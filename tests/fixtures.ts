import { AdoClient } from '../src/ado/client.js';
import type { AdoRequest, AdoResponse } from '../src/ado/http.js';
import { cannotAsk, resolveScope, type App, type Prompts } from '../src/app.js';
import { run } from '../src/cli/framework.js';
import { commands } from '../src/cli/commands/index.js';
import { Git, LinkStore, type GitRunner } from '../src/git.js';

/** A request as a handler sees it: the method, the decoded path without the org, the query, and the parsed body. */
export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  raw: AdoRequest;
}

export type Route = (req: Req) => unknown | undefined;

export const json = (body: unknown, status = 200): AdoResponse => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Azure DevOps answering from `route`; `undefined` from it means 404. Every request is recorded. */
export function fakeAdo(route: Route) {
  const requests: Req[] = [];
  const http = async (raw: AdoRequest): Promise<AdoResponse> => {
    const url = new URL(raw.url);
    const req: Req = { method: raw.method, path: decodeURIComponent(url.pathname).replace(/^\/[^/]+/, ''), query: url.searchParams, body: raw.body ? JSON.parse(raw.body) : undefined, raw };
    requests.push(req);
    const answer = route(req);
    if (answer === undefined) return json({ message: `no route for ${req.method} ${req.path}` }, 404);
    if (typeof answer === 'object' && answer !== null && 'status' in answer && 'body' in answer) return answer as AdoResponse;
    return json(answer);
  };
  return { http, requests };
}

export interface FakeGitOptions {
  inRepo?: boolean;
  /** null for a detached HEAD. */
  branch?: string | null;
  remote?: string | null;
  config?: Record<string, string>;
  /** Extra answers, keyed by the joined args. */
  answers?: Record<string, string>;
}

/** A repo in memory: a branch, an origin remote, and git config. */
export function fakeGit(opts: FakeGitOptions = {}) {
  const config = new Map(Object.entries(opts.config ?? {}));
  const commands: string[][] = [];
  const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
  const no = { stdout: '', stderr: 'nope', exitCode: 1 };
  const runner: GitRunner = async (args) => {
    commands.push(args);
    const key = args.join(' ');
    if (opts.answers?.[key] !== undefined) return ok(opts.answers[key]);
    if (key === 'rev-parse --is-inside-work-tree') return opts.inRepo === false ? no : ok('true');
    if (key === 'rev-parse --abbrev-ref HEAD') return opts.branch === null ? ok('HEAD') : ok(opts.branch ?? 'feature/x');
    if (key === 'remote get-url origin') return opts.remote === null ? no : ok(opts.remote ?? 'https://dev.azure.com/contoso/MyProject/_git/web');
    if (args[0] === 'config' && args[1] === '--get') return config.has(args[2]!) ? ok(config.get(args[2]!)) : no;
    if (args[0] === 'config' && args[1] === '--unset') return config.delete(args[2]!) ? ok() : no;
    if (args[0] === 'config' && args[1] === '--get-regexp') {
      const re = new RegExp(args[2]!);
      const lines = [...config].filter(([k]) => re.test(k)).map(([k, v]) => `${k} ${v}`);
      return lines.length > 0 ? ok(lines.join('\n')) : no;
    }
    if (args[0] === 'config' && args.length === 3) return config.set(args[1]!, args[2]!), ok();
    return no;
  };
  return { runner, config, commands };
}

/** Prompts that answer from a script; without one, they behave as with no terminal. */
export function fakePrompts(answers: { select?: string; checkbox?: string[]; confirm?: boolean } = {}): Prompts & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async select(message, choices, by) {
      asked.push(message);
      if (answers.select === undefined) throw cannotAsk(message, by, choices.map((c) => c.value));
      return answers.select;
    },
    async checkbox(message, choices, by) {
      asked.push(message);
      if (answers.checkbox === undefined) throw cannotAsk(message, by, choices.map((c) => c.value));
      return answers.checkbox;
    },
    async confirm(message) {
      asked.push(message);
      return answers.confirm ?? false;
    },
  };
}

export function testApp(opts: { route?: Route; git?: FakeGitOptions; prompts?: Prompts; stdin?: string; flags?: { org?: string; project?: string; repo?: string } } = {}) {
  const ado = fakeAdo(opts.route ?? (() => undefined));
  const git = fakeGit(opts.git);
  const g = new Git(git.runner, '/repo');
  const app: App = {
    env: {},
    git: g,
    links: new LinkStore(g),
    prompts: opts.prompts ?? fakePrompts(),
    stdin: {
      hasData: () => opts.stdin !== undefined,
      text: async (value) => (value !== undefined && value !== '-' ? value : opts.stdin ?? ''),
    },
    transport: () => ({ kind: 'in-process', http: ado.http, status: async () => ({ signedIn: true, account: 'jane@contoso.com', tenant: 't', expiresAt: null, error: null }) }),
    ado: (orgUrl) => new AdoClient(ado.http, orgUrl),
    scope: (hint) => resolveScope(g, {}, opts.flags ?? {}, hint),
    openUrl: async () => {},
  };
  return { app, ado, git };
}

/** Runs dova end to end against a test app; returns exit code and what it printed. */
export async function cli(app: App, ...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await run(commands, argv, { app, env: { NO_COLOR: '1' }, stdout: { write: (s: string) => (stdout += s) }, stderr: { write: (s: string) => (stderr += s) } });
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

/** A work item as the REST API returns it. */
export const wi = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  fields: { 'System.Title': `Item ${id}`, 'System.WorkItemType': 'Task', 'System.State': 'Active', 'System.TeamProject': 'MyProject', ...fields },
});

/** Answers the work items batch endpoint from a list. */
export const batch = (items: ReturnType<typeof wi>[]) => (req: Req) => ({ value: (req.body.ids as number[]).map((id) => items.find((w) => w.id === id) ?? null) });

export const restPr = (id: number, extra: Record<string, unknown> = {}) => ({
  pullRequestId: id,
  title: `PR ${id}`,
  status: 'active',
  createdBy: { displayName: 'Jane' },
  sourceRefName: 'refs/heads/feature/x',
  targetRefName: 'refs/heads/main',
  repository: { id: 'r', name: 'web', project: { id: 'p', name: 'MyProject' } },
  ...extra,
});
