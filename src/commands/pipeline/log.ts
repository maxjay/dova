import type { Command } from 'commander';
import { defaultRunner } from '../../lib/exec.js';
import { resolveContext } from '../../lib/context.js';
import { fetchRecentRuns, fetchTimeline, fetchLogText, failedRecords, buildRunWebUrl } from '../../lib/pipelines.js';
import { addContextOptions, addJsonOption, addNoColorOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
import { NotFoundError, UserError } from '../../lib/errors.js';

interface PipelineLogFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  branch?: string;
  task?: string;
  all?: boolean;
  full?: boolean;
  json?: string | boolean;
  color: boolean;
}

interface PipelineLogEntry {
  name: string;
  type: string;
  logId: number;
  text: string;
}

interface PipelineLogResult {
  runId: number;
  runUrl: string;
  failedTaskNames: string[];
  entries: PipelineLogEntry[];
}

const TAIL_LINES = 200;

function tail(text: string, n: number): { shown: string; truncated: boolean; totalLines: number } {
  const lines = text.split('\n');
  if (lines.length <= n) return { shown: text, truncated: false, totalLines: lines.length };
  return { shown: lines.slice(-n).join('\n'), truncated: true, totalLines: lines.length };
}

function renderPipelineLogHuman(result: PipelineLogResult, full: boolean, color: ReturnType<typeof getColor>): void {
  if (result.entries.length === 0) {
    process.stdout.write(
      `${color.dim(`No failed tasks found in run #${result.runId} (still in progress, or it succeeded).`)}\n${color.dim(result.runUrl)}\n`
    );
    return;
  }

  const lines: string[] = [];
  for (const entry of result.entries) {
    lines.push(color.bold(`${entry.type}: ${entry.name}`));
    if (full) {
      lines.push(entry.text);
    } else {
      const { shown, truncated, totalLines } = tail(entry.text, TAIL_LINES);
      lines.push(shown);
      if (truncated) {
        lines.push(color.dim(`… showing last ${TAIL_LINES} of ${totalLines} lines — pass --full for the whole log`));
      }
    }
    lines.push('');
  }

  const shown = new Set(result.entries.map((e) => e.name));
  const remaining = result.failedTaskNames.filter((n) => !shown.has(n));
  if (remaining.length > 0) {
    lines.push(color.yellow(`+${remaining.length} other failed task(s): ${remaining.join(', ')}`));
    lines.push(color.dim('Pass --all to see all of them, or --task <name> for one specifically.'));
  }
  lines.push(color.dim(result.runUrl));

  process.stdout.write(`${lines.join('\n')}\n`);
}

export function registerPipelineLogCommand(pipeline: Command): void {
  const cmd = pipeline
    .command('log [run-id]')
    .description("Show why a pipeline run failed — the failed task's log (default: most recent run for current branch)")
    .option('--branch <branch>', 'branch to look up the most recent run for (ignored when run-id is given)')
    .option('--task <name>', "show this task's log specifically, instead of just the first failure")
    .option('--all', "show every failed task's log, not just the first")
    .option('--full', 'show the full log instead of the last 200 lines');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addNoColorOption(cmd);

  cmd.action(async (runIdArg: string | undefined, opts: PipelineLogFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);
    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });

    let runId: number;
    if (runIdArg) {
      runId = Number(runIdArg);
      if (!Number.isInteger(runId) || runId <= 0) {
        throw new UserError(`"${runIdArg}" is not a valid pipeline run id.`);
      }
    } else {
      const branch = opts.branch ?? ctx.branch;
      if (!branch) {
        throw new UserError('No run id given and no current branch to look one up for.', ['Pass a run id, or --branch, or run this inside a repo on a branch.']);
      }
      const recent = await fetchRecentRuns(runner, ctx.orgUrl, ctx.project, branch, 1);
      if (recent.length === 0) {
        throw new NotFoundError(`No pipeline runs found for branch "${branch}".`);
      }
      runId = recent[0]!.id;
    }

    const records = await fetchTimeline(runner, ctx.orgUrl, ctx.project, runId);
    const failures = failedRecords(records);
    const runUrl = buildRunWebUrl(ctx.orgUrl, ctx.project, runId);

    let toFetch = failures;
    if (opts.task) {
      const match = failures.find((f) => f.name.toLowerCase() === opts.task!.toLowerCase());
      if (!match) {
        throw new NotFoundError(`No failed task named "${opts.task}" in run #${runId}.`, [
          failures.length > 0 ? `Failed tasks: ${failures.map((f) => f.name).join(', ')}` : 'No tasks failed in this run.',
        ]);
      }
      toFetch = [match];
    } else if (!opts.all) {
      toFetch = failures.slice(0, 1);
    }

    const entries: PipelineLogEntry[] = [];
    for (const f of toFetch) {
      const text = await fetchLogText(runner, ctx.orgUrl, ctx.project, runId, f.log!.id);
      entries.push({ name: f.name, type: f.type, logId: f.log!.id, text });
    }

    const result: PipelineLogResult = {
      runId,
      runUrl,
      failedTaskNames: failures.map((f) => f.name),
      entries,
    };

    await emit(result, opts, () => renderPipelineLogHuman(result, Boolean(opts.full), color));
  });
}
