import fs from 'node:fs';
import { checkbox, confirm, select } from '@inquirer/prompts';
import open from 'open';
import { AdoClient } from './ado/client.js';
import type { Scope } from './core/types.js';
import { orgUrlFor, parseRemote } from './core/urls.js';
import { createTransport, type Transport } from './daemon.js';
import { UserError } from './errors.js';
import { execGit, Git, LinkStore, type GitRunner } from './git.js';

/* ------------------------------------------------------------------ *
 * Everything a command touches outside itself, built once per process.
 * Tests build one from fakes (tests/fixtures.ts).
 * ------------------------------------------------------------------ */

export interface Choice {
  name: string;
  value: string;
  checked?: boolean;
}

/**
 * Without a terminal a prompt would hang forever, so `select` and
 * `checkbox` fail naming what would have answered them, and `confirm`
 * answers no — every confirm dova asks has a safe no.
 */
export interface Prompts {
  select(message: string, choices: Choice[], answeredBy: string): Promise<string>;
  checkbox(message: string, choices: Choice[], answeredBy: string): Promise<string[]>;
  confirm(message: string): Promise<boolean>;
}

export interface Stdin {
  /** Something is piped or redirected in — not merely "no terminal", which every agent run is. */
  hasData(): boolean;
  /** `value`, or stdin when it's omitted or `-`. */
  text(value: string | undefined, what: string): Promise<string>;
}

export interface ScopeHint {
  org?: string;
  project?: string;
  repo?: string;
}

export interface App {
  env: NodeJS.ProcessEnv;
  git: Git;
  links: LinkStore;
  prompts: Prompts;
  stdin: Stdin;
  transport(): Transport;
  ado(orgUrl: string): AdoClient;
  /** What a command is about. `hint` comes from a link it was given, which names the resource exactly. */
  scope(hint?: ScopeHint): Promise<Scope>;
  openUrl(url: string): Promise<void>;
}

export interface AppOptions {
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  flags: ScopeHint;
  cwd?: string;
  gitRunner?: GitRunner;
  /** Shared between apps — `dova rpc` makes one App per request, all on one daemon connection. */
  transport?: Transport;
  stdin?: Stdin;
}

export function createApp(opts: AppOptions): App {
  const git = new Git(opts.gitRunner ?? execGit, opts.cwd ?? process.cwd());
  let transport = opts.transport;
  const clients = new Map<string, AdoClient>();
  const app: App = {
    env: opts.env,
    git,
    links: new LinkStore(git),
    prompts: terminalPrompts(opts.interactive),
    stdin: opts.stdin ?? processStdin(),
    transport: () => (transport ??= createTransport(opts.env, opts.interactive)),
    ado: (orgUrl) => clients.get(orgUrl) ?? clients.set(orgUrl, new AdoClient((req) => app.transport().http(req), orgUrl)).get(orgUrl)!,
    scope: (hint) => resolveScope(git, opts.env, opts.flags, hint),
    openUrl: async (url) => void (await open(url)),
  };
  return app;
}

/**
 * Per field, first answer wins: a link the command was given, then
 * --org/--project/--repo, then $DOVA_ORG/$DOVA_PROJECT, then the `origin`
 * remote of the repo you're in. The branch is whatever is checked out.
 */
export async function resolveScope(git: Git, env: NodeJS.ProcessEnv, flags: ScopeHint, hint: ScopeHint = {}): Promise<Scope> {
  const inRepo = await git.isRepo();
  const remoteUrl = inRepo ? await git.remoteUrl() : null;
  const remote = remoteUrl ? parseRemote(remoteUrl) : null;
  const org = hint.org ?? flags.org ?? env.DOVA_ORG ?? remote?.org;
  const project = hint.project ?? flags.project ?? env.DOVA_PROJECT ?? remote?.project;
  if (!org || !project) {
    throw new UserError('Could not tell which Azure DevOps organization and project this is about.', [
      'Run it inside a repo cloned from Azure Repos, or pass --org and --project (or set DOVA_ORG and DOVA_PROJECT).',
    ]);
  }
  const sameRemote = remote?.org === org && remote.project === project;
  return {
    org,
    orgUrl: orgUrlFor(org),
    project,
    repo: hint.repo ?? flags.repo ?? (sameRemote ? remote.repo : undefined),
    branch: inRepo ? (await git.currentBranch()) ?? undefined : undefined,
  };
}

export function needRepo<S extends Scope>(scope: S, command: string): S & { repo: string } {
  if (!scope.repo) throw new UserError(`\`dova ${command}\` needs a repo.`, ['Run it inside a repo cloned from Azure Repos, or pass --repo.']);
  return scope as S & { repo: string };
}

export function needBranch<S extends Scope>(scope: S): S & { branch: string } {
  if (!scope.branch) throw new UserError('Not on a branch (detached HEAD?).');
  return scope as S & { branch: string };
}

export function cannotAsk(message: string, answeredBy: string, choices: string[]): UserError {
  return new UserError(message, [answeredBy, `Available: ${choices.join(', ')}`, '(No terminal, so dova cannot ask.)']);
}

function terminalPrompts(interactive: boolean): Prompts {
  return {
    select: (message, choices, answeredBy) =>
      interactive ? select({ message, choices }) : Promise.reject(cannotAsk(message, answeredBy, choices.map((c) => c.value))),
    checkbox: (message, choices, answeredBy) =>
      interactive ? checkbox({ message, choices }) : Promise.reject(cannotAsk(message, answeredBy, choices.map((c) => c.value))),
    confirm: (message) => (interactive ? confirm({ message, default: true }) : Promise.resolve(false)),
  };
}

function processStdin(): Stdin {
  return {
    hasData() {
      try {
        const stat = fs.fstatSync(0);
        return stat.isFIFO() || (stat.isFile() && stat.size > 0);
      } catch {
        return false;
      }
    },
    async text(value, what) {
      if (value !== undefined && value !== '-') return value;
      const hint = `Pipe it in, e.g. … - <<'EOF'`;
      if (process.stdin.isTTY) throw new UserError(`No ${what} given.`, [hint]);
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
      if (!text) throw new UserError(`No ${what} given — stdin was empty.`, [hint]);
      return text;
    },
  };
}
