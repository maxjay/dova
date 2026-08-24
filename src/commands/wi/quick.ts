import type { Command } from 'commander';
import { defaultRunner } from '../../lib/exec.js';
import { readTextArg } from '../../lib/stdin.js';
import { quickCreateWorkItem } from '../../lib/quick-create.js';
import { addContextOptions, addJsonOption, addTeamOptions, addNoInputOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
import { runLink, renderLinkHuman, type LinkResult } from '../../lib/link.js';

interface WiQuickFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  team?: string;
  area?: string;
  iteration?: string;
  like?: string;
  save?: boolean;
  reresolve?: boolean;
  at?: string;
  link?: boolean;
  json?: string | boolean;
  color: boolean;
}

export function registerWiQuickCommand(wi: Command): void {
  const cmd = wi
    .command('quick <type> [title]')
    .description('Fast work item filing for any type — `dova bug` is sugar over this with type defaulted to Bug')
    .option('--at <location>', 'file:line to build a "Found in:" permalink from')
    .option('--link', 'link the newly created id to the current branch (chains into `dova link`)');

  addContextOptions(cmd);
  addTeamOptions(cmd);
  addJsonOption(cmd);
  addNoInputOption(cmd);

  cmd.action(async (type: string, titleArg: string | undefined, opts: WiQuickFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);
    const title = await readTextArg(titleArg, {
      what: 'title',
      hints: [
        "Pass it directly (single-quoted, so nothing is expanded): dova wi quick Task 'Add retry'",
        "Or pipe it in: dova wi quick Task - <<'EOF'",
      ],
    });

    const result = await quickCreateWorkItem(runner, {
      type,
      title,
      at: opts.at,
      project: opts.project,
      team: opts.team,
      area: opts.area,
      iteration: opts.iteration,
      like: opts.like,
      save: opts.save,
      reresolve: opts.reresolve,
    });

    let link: LinkResult | undefined;
    if (opts.link) {
      link = await runLink({
        ids: [String(result.id)],
        org: opts.org,
        orgUrl: opts.orgUrl,
        project: result.project,
        repo: opts.repo,
        json: opts.json,
        color,
      });
    }

    await emit({ ...result, link }, opts, () => {
      process.stdout.write(
        [
          `${color.green('Created')} ${type} ${color.bold(`#${result.id}`)}`,
          `  ${color.dim(result.url)}`,
          `  Project: ${result.project}${result.team ? `   Team: ${result.team}` : ''}`,
          `  Area: ${result.areaPath}`,
          `  Iteration: ${result.iterationPath}`,
          ...result.warnings.map((w) => color.yellow(`  Warning: ${w}`)),
        ].join('\n') + '\n'
      );
      if (link) {
        process.stdout.write('\n');
        renderLinkHuman(link, color);
      }
    });
  });
}
