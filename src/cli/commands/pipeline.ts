import type { App } from '../../app.js';
import { tail } from '../../core/text.js';
import type { Run } from '../../core/types.js';
import { parseId } from '../../core/urls.js';
import { ExternalError, NotFoundError, UserError } from '../../errors.js';
import { command, group } from '../framework.js';

async function runFor(app: App, runArg: string | undefined, branchFlag: string | undefined) {
  const scope = await app.scope();
  const ado = app.ado(scope.orgUrl);
  if (runArg) {
    const id = parseId(runArg);
    if (!id) throw new UserError(`"${runArg}" isn't a run id.`);
    return { scope, ado, run: await ado.run(scope.project, id) };
  }
  const branch = branchFlag ?? scope.branch;
  if (!branch) throw new UserError('No run id, and not on a branch.', ['Pass a run id or --branch.']);
  const [latest] = await ado.runs(scope.project, branch, 1);
  if (!latest) throw new NotFoundError(`No pipeline runs for branch "${branch}".`);
  return { scope, ado, run: latest };
}

interface Log {
  run: Run;
  /** Every failed task; only the first (or --task, or --all) has its log fetched. */
  failedTasks: string[];
  logs: Array<{ task: string; text: string }>;
}

export const pipeline = group('pipeline', 'Pipeline runs', [
  command<never, { branch?: string }, { branch: string; runs: Run[] }>({
    name: 'list',
    description: 'Recent runs for the current branch',
    options: [['--branch <branch>', 'another branch']],
    async run(app, _, flags) {
      const scope = await app.scope();
      const branch = flags.branch ?? scope.branch;
      if (!branch) throw new UserError('Not on a branch — pass --branch.');
      return { branch, runs: await app.ado(scope.orgUrl).runs(scope.project, branch, 10) };
    },
    render: (r, out) =>
      out.print(r.runs.length === 0 ? out.color.dim(`No runs for "${r.branch}".`) : out.table(['Run', 'Pipeline', 'Result', 'Queued'], r.runs.map((x) => [String(x.id), x.name, out.outcome(x.result ?? x.status), x.queuedAt ?? '?']))),
  }),
  command<{ run?: string }, { branch?: string; task?: string; all?: boolean; full?: boolean }, Log>({
    name: 'log [run]',
    description: "Why a run failed: the failed task's log (default: the current branch's latest run)",
    options: [
      ['--branch <branch>', 'latest run of another branch'],
      ['--task <name>', 'this failed task'],
      ['--all', 'every failed task'],
      ['--full', 'whole logs, not the last 200 lines'],
    ],
    async run(app, args, flags) {
      const { scope, ado, run } = await runFor(app, args.run, flags.branch);
      const failed = (await ado.timeline(scope.project, run.id))
        .filter((r) => r.result === 'failed' && r.logId !== null)
        .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
      let pick = flags.all ? failed : failed.slice(0, 1);
      if (flags.task) {
        pick = failed.filter((r) => r.name.toLowerCase() === flags.task!.toLowerCase());
        if (pick.length === 0) throw new NotFoundError(`No failed task "${flags.task}" in run #${run.id}.`, [`Failed: ${failed.map((f) => f.name).join(', ') || 'none'}`]);
      }
      const logs = await Promise.all(pick.map(async (r) => ({ task: r.name, text: await ado.log(scope.project, run.id, r.logId!) })));
      return { run, failedTasks: failed.map((f) => f.name), logs };
    },
    render(r, out, flags) {
      const c = out.color;
      if (r.logs.length === 0) return out.print(c.dim(`Nothing failed in run #${r.run.id} (${r.run.result ?? r.run.status}).`), c.dim(r.run.url));
      const others = r.failedTasks.filter((t) => !r.logs.some((l) => l.task === t));
      out.print(
        ...r.logs.flatMap((l) => {
          const shown = flags.full ? { text: l.text, truncated: false, totalLines: 0 } : tail(l.text, 200);
          return [c.bold(l.task), shown.text, shown.truncated && c.dim(`… last 200 of ${shown.totalLines} lines — --full for all`), ''];
        }),
        others.length > 0 && c.yellow(`${others.length} more failed: ${others.join(', ')} (--all, or --task <name>)`),
        c.dim(r.run.url)
      );
    },
  }),
  command<{ run?: string }, { branch?: string }, Run>({
    name: 'watch [run]',
    description: "Follow a run until it finishes; fails if it didn't succeed (default: the current branch's latest)",
    options: [['--branch <branch>', 'latest run of another branch']],
    async run(app, args, flags, out) {
      const found = await runFor(app, args.run, flags.branch);
      const { scope, ado } = found;
      let run = found.run;
      out.note(`Watching #${run.id} ${run.name} — ${run.url}`);
      let last = '';
      for (;;) {
        const now = run.result ?? run.status;
        if (now !== last) out.note(`  ${now}`);
        last = now;
        if (run.status === 'completed') break;
        await new Promise((r) => setTimeout(r, 5000));
        run = await ado.run(scope.project, run.id);
      }
      if (run.result !== 'succeeded') throw new ExternalError(`Run #${run.id} finished: ${run.result}.`);
      return run;
    },
    render: (r, out) => out.print(`${out.color.bold('Finished:')} ${out.outcome(r.result ?? r.status)}`),
  }),
]);
