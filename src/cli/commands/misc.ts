import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthStatus } from '../../ado/auth.js';
import type { HttpMethod } from '../../ado/http.js';
import { DaemonClient, connect, daemonPaths, serve, type DaemonStatus } from '../../daemon.js';
import { UserError } from '../../errors.js';
import block from '../../instructions.md';
import { command, group, type Group, type Spec } from '../framework.js';
import { commands } from './index.js';

export const api = command<{ path: string }, { method?: string; body?: string; contentType?: string }, unknown>({
  name: 'api <path>',
  description: 'Any Azure DevOps REST call, signed in — `/…` is org-relative, anything else project-relative',
  options: [
    ['-X, --method <method>', 'HTTP method (default: GET)'],
    ['-f, --body <body>', "request body: JSON, @file, or '-' for stdin"],
    ['--content-type <type>', 'body content type (default: application/json)'],
  ],
  async run(app, args, flags) {
    const scope = await app.scope();
    const ado = app.ado(scope.orgUrl);
    const method = (flags.method ?? 'GET').toUpperCase() as HttpMethod;
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new UserError(`Unknown method ${flags.method}.`);
    const url = /^https:\/\//.test(args.path) ? args.path : ado.url(args.path.startsWith('/') ? args.path.slice(1) : `${encodeURIComponent(scope.project)}/${args.path}`);
    const body = flags.body?.startsWith('@') ? fs.readFileSync(flags.body.slice(1), 'utf8') : flags.body === '-' ? await app.stdin.text('-', 'body') : flags.body;
    const res = await ado.raw(method, url, body, flags.contentType);
    try {
      return res.body.trim() ? JSON.parse(res.body) : null;
    } catch {
      return res.body; // build logs and other plain text
    }
  },
});

export const auth = group('auth', 'Your Azure sign-in — `az login`, once', [
  command<never, never, AuthStatus & { via: string; org: { url: string; ok: boolean; as?: string | null; error?: string } | null }>({
    name: 'status',
    description: "Who you're signed in as, and whether this repo's organization accepts it",
    async run(app) {
      const status = await app.transport().status();
      const scope = await app.scope().catch(() => null);
      let org = null;
      if (status.signedIn && scope) {
        org = await app.ado(scope.orgUrl).me().then(
          (as) => ({ url: scope.orgUrl, ok: true, as }),
          (err: Error) => ({ url: scope.orgUrl, ok: false, error: err.message })
        );
      }
      if (!status.signedIn || org?.ok === false) process.exitCode = 3;
      return { ...status, via: app.transport().kind, org };
    },
    render(r, out) {
      const c = out.color;
      if (!r.signedIn) return out.print(`${c.yellow('Not signed in.')} ${r.error}`, '  Run: az login — or any dova command, which runs it for you.');
      out.print(
        `Signed in as ${c.bold(r.account ?? '?')} ${c.dim(`(tenant ${r.tenant})`)}`,
        `  Token from az, held ${r.via === 'daemon' ? 'by the dova daemon' : 'by this command'} until ${r.expiresAt}`,
        r.org && `  ${r.org.url}: ${r.org.ok ? c.green('ok') + c.dim(` as ${r.org.as}`) : `${c.red('failed')} — ${r.org.error}`}`
      );
    },
  }),
]);

const running = async () => (await DaemonClient.open(daemonPaths()))?.status ?? null;

export const daemon = group('daemon', 'The background process that holds your token (started on first use)', [
  command<never, never, undefined>({
    name: 'run',
    description: 'Run the daemon in the foreground',
    run: async () => void (await serve({ echo: Boolean(process.stderr.isTTY) })),
  }),
  command<never, never, DaemonStatus>({
    name: 'start',
    description: 'Start it now',
    run: async () => (await connect()).call('daemon.status') as Promise<DaemonStatus>,
    render: (s, out) => out.print(`${out.color.green('Running')} (pid ${s.pid})`),
  }),
  command<never, never, { stopped: boolean }>({
    name: 'stop',
    description: 'Stop it; the next command starts a fresh one',
    async run() {
      const open = await DaemonClient.open(daemonPaths());
      await open?.client.call('daemon.stop').catch(() => {});
      return { stopped: Boolean(open) };
    },
    render: (r, out) => out.print(r.stopped ? out.color.green('Stopped.') : out.color.dim('Not running.')),
  }),
  command<never, never, DaemonStatus | { running: false; log: string }>({
    name: 'status',
    description: 'Whether it is running, and what it has done',
    run: async () => (await running()) ?? { running: false as const, log: daemonPaths().log },
    render(s, out) {
      if ('running' in s) return out.print(`${out.color.yellow('Not running')} — the next command starts it.`, `  Log: ${s.log}`);
      out.print(`${out.color.green('Running')} — pid ${s.pid}, since ${s.startedAt}, ${s.requests} requests`, `  Build:  ${s.build}`, `  Socket: ${s.socket}`, `  Log:    ${s.log}`);
    },
  }),
]);

/* ---------------- completion ---------------- */

type Node = Spec<any, any, any> | Group; // eslint-disable-line @typescript-eslint/no-explicit-any
const word = (n: Node) => n.name.split(' ')[0]!;
const flagsOf = (n: Node) => ('options' in n ? (n.options ?? []).map(([f]) => f.match(/--[\w-]+/)![0]) : []);

/** What can come next after `words`: a subcommand, or with a `-` prefix, a flag. */
export function complete(words: string[]): string[] {
  let level: Node[] = commands.filter((n) => !('hidden' in n && n.hidden));
  let node: Node | undefined;
  for (const w of words.slice(0, -1).filter((w) => !w.startsWith('-'))) {
    node = level.find((n) => word(n) === w);
    level = node && 'commands' in node ? node.commands : [];
  }
  const current = words.at(-1) ?? '';
  const pool = current.startsWith('-') ? [...flagsOf(node ?? ({} as Node)), '--json', '--jq', '--org', '--project', '--repo', '--no-color', '--no-input', '--help'] : level.map(word);
  return pool.filter((c) => c.startsWith(current));
}

const SHELLS: Record<string, string> = {
  bash: `_dova() { COMPREPLY=($(dova __complete "\${COMP_WORDS[@]:1:COMP_CWORD}")); }\ncomplete -F _dova dova`,
  zsh: `#compdef dova\n_dova() { compadd -- $(dova __complete "\${words[@]:1:CURRENT-1}") }\ncompdef _dova dova`,
  fish: `complete -c dova -f -a '(dova __complete -- (commandline -opc)[2..] (commandline -ct))'`,
  powershell: `Register-ArgumentCompleter -Native -CommandName dova -ScriptBlock { param($w, $ast, $pos) $words = $ast.CommandElements | Select-Object -Skip 1 | ForEach-Object { "$_" }; if ($w -eq '') { $words += '' }; dova __complete -- @words }`,
};

export const completion = command<{ shell: string }, never, string>({
  name: 'completion <shell>',
  description: `Shell completion script: ${Object.keys(SHELLS).join(', ')} (e.g. source <(dova completion bash))`,
  async run(_, { shell }) {
    if (!SHELLS[shell]) throw new UserError(`No completion for "${shell}".`, [`Supported: ${Object.keys(SHELLS).join(', ')}`]);
    return SHELLS[shell]!;
  },
  render: (script, out) => out.print(script),
});

export const completeWords = command<{ words: string[] }, never, string[]>({
  name: '__complete [words...]',
  description: '(used by the completion scripts)',
  hidden: true,
  run: async (_, { words }) => complete(words ?? []),
  render: (r, out) => out.print(...r),
});

/* ---------------- agent instructions ---------------- */

const START = '<!-- dova:start -->';
const END = '<!-- dova:end -->';

/** Replaces dova's block in place, or appends it; the rest of the file is left exactly as it was. */
export function spliceBlock(existing: string | null, body: string): string {
  const wrapped = `${START}\n<!-- Written by \`dova instructions\`; edits inside this block are overwritten. -->\n\n${body.trim()}\n${END}\n`;
  if (existing === null) return wrapped;
  const [start, end] = [existing.indexOf(START), existing.indexOf(END)];
  if (start !== -1 && end > start) return existing.slice(0, start) + wrapped + existing.slice(end + END.length).replace(/^\n/, '');
  return `${existing.replace(/\n*$/, '\n\n')}${wrapped}`;
}

export const instructions = command<never, { repo?: boolean }, { files: Array<{ file: string; changed: boolean }> }>({
  name: 'instructions',
  description: 'Teach coding agents (Copilot, Windsurf/Devin, Cursor, Codex) to use dova — globally, or --repo to commit for your team',
  options: [['--repo', 'write AGENTS.md and .github/copilot-instructions.md into this repo instead']],
  async run(app, _, flags) {
    let targets: Array<[file: string, preamble: string]>;
    if (flags.repo) {
      const root = await app.git.try(['rev-parse', '--show-toplevel']);
      if (!root) throw new UserError('--repo needs to run inside a git repo.');
      targets = [[fs.existsSync(path.join(root, 'agents.md')) ? path.join(root, 'agents.md') : path.join(root, 'AGENTS.md'), ''], [path.join(root, '.github', 'copilot-instructions.md'), '']];
    } else {
      const home = os.homedir();
      const base = process.platform === 'win32' ? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming') : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
      const vscode = ['Code', 'Code - Insiders', 'VSCodium'].map((v) => path.join(base, v, 'User')).filter((d) => fs.existsSync(d));
      targets = [
        [path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md'), ''],
        ...(vscode.length > 0 ? vscode : [path.join(base, 'Code', 'User')]).map((d): [string, string] => [path.join(d, 'prompts', 'dova.instructions.md'), "---\napplyTo: '**'\n---\n"]),
      ];
    }
    const files = targets.map(([file, preamble]) => {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      const next = spliceBlock(existing, block);
      const content = existing === null ? preamble + next : next;
      if (content !== existing) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      return { file, changed: content !== existing };
    });
    return { files };
  },
  render: (r, out) => out.print(...r.files.map((f) => `${f.changed ? out.color.green('✓ wrote') : out.color.dim('= unchanged')} ${f.file}`), out.color.dim('Re-run after upgrading dova.')),
});

export const rpcCommand = command<never, never, undefined>({
  name: 'rpc',
  description: 'Serve every command as JSON-RPC over stdin/stdout, for other tools (method list: rpc.methods)',
  run: async () => void (await (await import('../rpc.js')).serveRpc(commands)),
});

export const mcpCommand = command<never, never, undefined>({
  name: 'mcp',
  description: 'Serve dova as an MCP server over stdio, for AI agents',
  run: async () => void (await (await import('../mcp.js')).serveMcp(commands)),
});
