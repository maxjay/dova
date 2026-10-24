import readline from 'node:readline';
import { Chalk } from 'chalk';
import { createApp, type App, type Stdin } from '../app.js';
import { createTransport, type Transport } from '../daemon.js';
import { DovaError, ExitCode, UserError } from '../errors.js';
import { Out, type Group, type Spec, type Writable } from './framework.js';

/* ------------------------------------------------------------------ *
 * `dova rpc`: every dova command as a JSON-RPC 2.0 method, one JSON
 * message per line on stdin/stdout — for tools that want Azure DevOps
 * through dova rather than through az.
 *
 *   → {"jsonrpc":"2.0","id":1,"method":"wi.view","params":{"idOrUrl":"4821"}}
 *   ← {"jsonrpc":"2.0","id":1,"result":{"id":4821,"title":…}}
 *
 * A method is a command path joined with dots (`status`, `pr.create`,
 * `pipeline.log`). Params are its arguments and flags by camelCased
 * name, plus `cwd` (which repo to act in) and `org`/`project`/`repo`.
 * Results are exactly what `--json` prints. `rpc.methods` lists them.
 * Requests run concurrently; nothing prompts, and text that the CLI
 * would read from stdin is passed as a param instead.
 * ------------------------------------------------------------------ */

type AnySpec = Spec<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Method {
  name: string;
  description: string;
  /** Positional arguments, in order; `…` marks a list. */
  args: string[];
  options: string[];
  spec: AnySpec;
}

const camel = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

/** Commands that make no sense as a request (run forever, need a terminal, or are this). */
const EXCLUDED = new Set(['rpc', 'daemon.run', 'completion', '__complete']);

export function methods(commands: Group['commands'], prefix = ''): Method[] {
  return commands.flatMap((node): Method[] => {
    const [word, ...argSyntax] = node.name.split(' ');
    const name = prefix + word;
    if ('commands' in node) return methods(node.commands, `${name}.`);
    if (EXCLUDED.has(name)) return [];
    return [
      {
        name,
        description: node.description,
        args: argSyntax.map((a) => camel(a.replace(/[<>[\]]/g, '').replace('...', '…'))),
        options: (node.options ?? []).map(([flags]) => camel(flags.match(/--([\w-]+)/)![1]!)),
        spec: node,
      },
    ];
  });
}

/** stdin for a request: the text is the param, or it isn't there. */
const paramStdin: Stdin = {
  hasData: () => false,
  async text(value, what) {
    if (value === undefined || value === '-') throw new UserError(`No ${what} given — pass it as a param.`);
    return value;
  },
};

interface Request {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ServeRpcOptions {
  input?: NodeJS.ReadableStream;
  output?: Writable;
  env?: NodeJS.ProcessEnv;
  /** Tests pass a fake App. */
  app?: (params: Record<string, unknown>) => App;
}

/** Answers requests until stdin closes. */
export async function serveRpc(commands: Group['commands'], opts: ServeRpcOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const output = opts.output ?? process.stdout;
  // The client hung up: nobody is left to answer.
  if (!opts.output) process.stdout.on('error', (err: NodeJS.ErrnoException) => err.code === 'EPIPE' && process.exit(0));
  const table = new Map(methods(commands).map((m) => [m.name, m]));
  let transport: Transport | undefined;
  const appFor = (p: Record<string, unknown>): App =>
    opts.app ? { ...opts.app(p), stdin: paramStdin } : createApp({
      env,
      interactive: false,
      cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
      flags: { org: p.org as string, project: p.project as string, repo: p.repo as string },
      transport: (transport ??= createTransport(env, false)),
      stdin: paramStdin,
    });
  // Notes a command prints (pipeline.watch's progress) go to stderr, never into the protocol.
  const out = new Out(new Chalk({ level: 0 }), { write: () => true }, process.stderr);
  const reply = (msg: object) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

  const handle = async (req: Request) => {
    const method = req.method === undefined ? undefined : table.get(req.method);
    if (req.method === 'rpc.methods') return [...table.values()].map(({ spec: _spec, ...m }) => m);
    if (!method) throw Object.assign(new Error(`Unknown method "${req.method}".`), { code: -32601 });
    const params = req.params ?? {};
    const args = Object.fromEntries(method.args.map((a) => [a.replace('…', ''), params[a.replace('…', '')]]));
    return (await method.spec.run(appFor(params), args, { ...params, color: false, input: false }, out)) ?? null;
  };

  const pending = new Set<Promise<void>>();
  for await (const line of readline.createInterface({ input: opts.input ?? process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let req: Request;
    try {
      req = JSON.parse(line);
    } catch {
      reply({ id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    const task = handle(req).then(
      (result) => void (req.id !== undefined && reply({ id: req.id, result })),
      (err: unknown) => {
        const e = err as Error & { code?: number };
        if (req.id === undefined) return;
        reply({
          id: req.id,
          error: {
            code: typeof e.code === 'number' ? e.code : -32000,
            message: e.message,
            // dova's own error kinds: exitCode says which (2 not found, 3 not signed in, …).
            data: { name: e.name, exitCode: e instanceof DovaError ? e.exitCode : ExitCode.Unexpected, hints: e instanceof DovaError ? e.hints : [] },
          },
        });
      }
    );
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}
