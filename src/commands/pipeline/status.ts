import type { Command } from 'commander';
import { defaultRunner } from '../../lib/exec.js';
import { resolveContext } from '../../lib/context.js';
import { fetchRecentRuns, buildRunWebUrl } from '../../lib/pipelines.js';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption } from '../../lib/command-helpers.js';
import { emit, getColor, renderTable } from '../../lib/output.js';
import { UserError } from '../../lib/errors.js';

interface PipelineStatusFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  branch?: string;
  json?: string | boolean;
  jq?: string;
  color: boolean;
}

export function registerPipelineStatusCommand(pipeline: Command): void {
  const cmd = pipeline
    .command('status')
    .description('Recent pipeline runs for a branch (default: current branch)')
    .option('--branch <branch>', 'branch to show runs for (default: current branch)');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);

  cmd.action(async (opts: PipelineStatusFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);
    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });

    const branch = opts.branch ?? ctx.branch;
    if (!branch) {
      throw new UserError('No branch to check — pass --branch, or run this inside a repo on a branch.');
    }

    const runs = await fetchRecentRuns(runner, ctx.orgUrl, ctx.project, branch, 10);
    const results = runs.map((r) => ({
      id: r.id,
      name: r.definition?.name ?? `#${r.buildNumber}`,
      status: r.status,
      result: r.result,
      queueTime: r.queueTime ?? null,
      url: r._links?.web?.href ?? buildRunWebUrl(ctx.orgUrl, ctx.project, r.id),
    }));

    await emit({ branch, runs: results }, opts, () => {
      if (results.length === 0) {
        process.stdout.write(`${color.dim(`No pipeline runs found for branch "${branch}".`)}\n`);
        return;
      }
      const rows = results.map((r) => {
        const outcome = r.result ?? r.status;
        const colored = outcome === 'succeeded' ? color.green(outcome) : outcome === 'failed' ? color.red(outcome) : color.yellow(outcome);
        return [String(r.id), r.name, colored, r.queueTime ?? '?'];
      });
      process.stdout.write(`${renderTable(['Run', 'Pipeline', 'Result', 'Queued'], rows)}\n`);
    });
  });
}
