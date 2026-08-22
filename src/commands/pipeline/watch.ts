import type { Command } from 'commander';
import { defaultRunner } from '../../lib/exec.js';
import { resolveContext } from '../../lib/context.js';
import { fetchRecentRuns, fetchRun, buildRunWebUrl, isRunFinished, describeOutcome } from '../../lib/pipelines.js';
import { addContextOptions, addJsonOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
import { NotFoundError, ExternalCommandError } from '../../lib/errors.js';

interface PipelineWatchFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  json?: string | boolean;
  color: boolean;
}

const POLL_INTERVAL_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerPipelineWatchCommand(pipeline: Command): void {
  const cmd = pipeline
    .command('watch [run-id]')
    .description('Poll a pipeline run until it finishes (default: most recent run for current branch)');

  addContextOptions(cmd);
  addJsonOption(cmd);

  cmd.action(async (runIdArg: string | undefined, opts: PipelineWatchFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);
    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });

    let runId: number;
    if (runIdArg) {
      runId = Number(runIdArg);
    } else {
      if (!ctx.branch) {
        throw new NotFoundError('No run id given and no current branch to look one up for.');
      }
      const recent = await fetchRecentRuns(runner, ctx.orgUrl, ctx.project, ctx.branch, 1);
      if (recent.length === 0) {
        throw new NotFoundError(`No pipeline runs found for branch "${ctx.branch}".`);
      }
      runId = recent[0]!.id;
    }

    let run = await fetchRun(runner, ctx.orgUrl, ctx.project, runId);
    const url = run._links?.web?.href ?? buildRunWebUrl(ctx.orgUrl, ctx.project, runId);
    process.stdout.write(`Watching run ${color.bold(`#${runId}`)} (${run.definition?.name ?? run.buildNumber}) — ${color.dim(url)}\n`);

    let lastPrinted = '';
    const printIfChanged = (): void => {
      const line = `  ${describeOutcome(run)} (${run.status})`;
      if (line !== lastPrinted) {
        process.stdout.write(`${line}\n`);
        lastPrinted = line;
      }
    };
    printIfChanged();

    while (!isRunFinished(run)) {
      await sleep(POLL_INTERVAL_MS);
      run = await fetchRun(runner, ctx.orgUrl, ctx.project, runId);
      printIfChanged();
    }

    const result = {
      id: run.id,
      name: run.definition?.name ?? run.buildNumber,
      status: run.status,
      result: run.result,
      url,
    };

    await emit(result, opts, () => {
      const outcome = result.result ?? result.status;
      const colored = outcome === 'succeeded' ? color.green(outcome) : outcome === 'failed' ? color.red(outcome) : color.yellow(outcome);
      process.stdout.write(`${color.bold('Finished:')} ${colored}\n`);
    });

    if (run.result && run.result !== 'succeeded') {
      throw new ExternalCommandError(`Pipeline run #${runId} finished with result "${run.result}".`);
    }
  });
}
