import chalk, { Chalk, type ChalkInstance } from 'chalk';
import Table from 'cli-table3';
import { Command, CommanderError } from 'commander';
import * as jq from 'jq-wasm';
import { createApp, type App } from '../app.js';
import { DovaError, ExitCode, UserError } from '../errors.js';
import { DOVA_VERSION } from '../version.js';

/* ------------------------------------------------------------------ *
 * A command is its arguments and flags, a `run` that returns data, and
 * a `render` that prints it for a person. `--json`/`--jq` print the data
 * instead, for every command; `web` adds `-w, --web` to open a URL.
 * ------------------------------------------------------------------ */

export interface GlobalFlags {
  org?: string;
  project?: string;
  repo?: string;
  json?: string | true;
  jq?: string;
  color: boolean;
  input: boolean;
  web?: boolean;
}

export interface Spec<A = never, F = never, R = unknown> {
  /** Name plus commander argument syntax: `view <id-or-url>`, `unlink [ids...]`. */
  name: string;
  description: string;
  options?: Array<[flags: string, description: string]>;
  hidden?: boolean;
  /** Arguments arrive keyed by camelCased name: `<id-or-url>` → `idOrUrl`. */
  run(app: App, args: A, flags: F & GlobalFlags, out: Out): Promise<R>;
  render?(result: R, out: Out, flags: F & GlobalFlags): void;
  web?(result: R): string | null;
}

export interface Group {
  name: string;
  description: string;
  commands: Array<Spec<any, any, any> | Group>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export const command = <A, F, R>(spec: Spec<A, F, R>) => spec;
export const group = (name: string, description: string, commands: Group['commands']): Group => ({ name, description, commands });

export interface Writable {
  write(text: string): unknown;
}

/** The only way commands write. stdout is the result; notes and warnings go to stderr. */
export class Out {
  constructor(
    readonly color: ChalkInstance,
    private readonly stdout: Writable,
    private readonly stderr: Writable
  ) {}

  print(...lines: Array<string | false | null | undefined>): void {
    this.stdout.write(`${lines.filter((l): l is string => typeof l === 'string').join('\n')}\n`);
  }

  note(text: string): void {
    this.stderr.write(`${text}\n`);
  }

  table(head: string[], rows: string[][]): string {
    const table = new Table({ head, style: { head: [], border: [] } });
    table.push(...rows);
    return table.toString();
  }

  outcome(value: string): string {
    return value === 'succeeded' ? this.color.green(value) : /failed|canceled/.test(value) ? this.color.red(value) : this.color.yellow(value);
  }
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: Writable;
  stderr?: Writable;
  /** Tests pass a fake App. */
  app?: App;
}

const camel = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

export function buildProgram(commands: Group['commands'], opts: RunOptions = {}): Command {
  const env = opts.env ?? process.env;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const program = new Command('dova')
    .description('Azure DevOps from the terminal — work items, pull requests and pipelines for the repo you are in.')
    .version(DOVA_VERSION)
    .option('--org <org>', 'organization (default: the git remote’s, or $DOVA_ORG)')
    .option('--project <project>', 'project (default: the git remote’s, or $DOVA_PROJECT)')
    .option('--repo <repo>', 'repository (default: the git remote’s)')
    .option('--json [fields]', 'print the result as JSON, optionally only these comma-separated fields')
    .option('--jq <expression>', 'filter --json output through jq')
    .option('--no-color', 'no colors (also $NO_COLOR)')
    .option('--no-input', 'never prompt (also without a terminal, or with $DOVA_NO_INPUT)')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: (s) => stdout.write(s), writeErr: (s) => stderr.write(s) });

  const add = (parent: Command, spec: Spec<any, any, any> | Group): void => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const cmd = parent.command(spec.name, { hidden: 'hidden' in spec && spec.hidden }).description(spec.description);
    if ('commands' in spec) return spec.commands.forEach((child) => add(cmd, child));
    for (const [flags, description] of spec.options ?? []) cmd.option(flags, description);
    if (spec.web) cmd.option('-w, --web', 'open it in the browser');
    cmd.action(async (...params: unknown[]) => {
      const self = params.at(-1) as Command;
      const flags = self.optsWithGlobals<GlobalFlags>();
      if (flags.jq !== undefined && flags.json === undefined) throw new UserError('--jq needs --json.');
      const color = flags.color && !env.NO_COLOR && env.FORCE_COLOR !== '0' ? chalk : new Chalk({ level: 0 });
      const out = new Out(color, stdout, stderr);
      const app =
        opts.app ??
        createApp({ env, interactive: flags.input && !env.DOVA_NO_INPUT && Boolean(process.stdin.isTTY), flags: { org: flags.org, project: flags.project, repo: flags.repo } });
      const args = Object.fromEntries(self.registeredArguments.map((a, i) => [camel(a.name()), params[i]]));
      const result = await spec.run(app, args, flags, out);

      if (flags.web && spec.web) {
        const url = spec.web(result);
        if (!url) throw new UserError('Nothing to open in the browser.');
        return app.openUrl(url);
      }
      if (flags.json === undefined && spec.render) return spec.render(result, out, flags);
      if (result === undefined) return;
      const data = selectFields(result, flags.json ?? true);
      out.print(flags.jq ? await applyJq(data, flags.jq) : JSON.stringify(data, null, 2));
    });
  };
  commands.forEach((spec) => add(program, spec));
  return program;
}

function selectFields(data: unknown, json: string | true): unknown {
  if (json === true || typeof data !== 'object' || data === null || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  return Object.fromEntries(
    json.split(',').map((f) => {
      const field = f.trim();
      if (!(field in record)) throw new UserError(`Unknown --json field "${field}".`, [`Available: ${Object.keys(record).join(', ')}`]);
      return [field, record[field]];
    })
  );
}

async function applyJq(data: unknown, expression: string): Promise<string> {
  try {
    const results = await jq.json(data as jq.JqInput, expression);
    return results.map((v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2))).join('\n');
  } catch (err) {
    throw new UserError(`Invalid --jq expression: ${(err as Error).message}`);
  }
}

/** Runs dova and returns its exit code. Never calls process.exit. */
export async function run(commands: Group['commands'], argv: string[], opts: RunOptions = {}): Promise<number> {
  const stderr = opts.stderr ?? process.stderr;
  try {
    await buildProgram(commands, opts).parseAsync(argv, { from: 'user' });
    return ExitCode.Success;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode; // help or a usage error, already printed
    const c = argv.includes('--no-color') || (opts.env ?? process.env).NO_COLOR ? new Chalk({ level: 0 }) : chalk;
    stderr.write(`${c.red('Error:')} ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof DovaError) err.hints.forEach((h) => stderr.write(`${c.dim(`  ${h}`)}\n`));
    else if ((opts.env ?? process.env).DOVA_DEBUG) stderr.write(`${(err as Error).stack}\n`);
    return err instanceof DovaError ? err.exitCode : ExitCode.Unexpected;
  }
}
