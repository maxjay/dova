import type { Command } from 'commander';
import { defaultRunner, runAzJson } from '../../lib/exec.js';
import { azText } from '../../lib/az-file-arg.js';
import { readTextArg } from '../../lib/stdin.js';
import { resolveContext } from '../../lib/context.js';
import { resolveProject, resolveCreateContext } from '../../lib/team-resolver.js';
import { buildWiWebUrl } from '../../lib/work-items.js';
import { addContextOptions, addJsonOption, addTeamOptions, addNoInputOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
import type { AzWorkItem } from '../../types/azure-devops.js';

interface WiCreateFlags {
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
  type: string;
  title: string;
  assignTo?: string;
  parent?: string;
  json?: string | boolean;
  color: boolean;
}

export function registerWiCreateCommand(wi: Command): void {
  const cmd = wi
    .command('create')
    .description('Create a work item (the fuller version of `dova bug` / `dova wi quick`)')
    .requiredOption('--type <type>', "work item type, as defined by this project's process")
    .requiredOption('--title <title>', "title (use '-' to read it from stdin)")
    .option('--assign-to <user>', 'assign to a user (default: unassigned; "me" for the current user)')
    .option('--parent <id>', 'link as a child of this work item id');

  addContextOptions(cmd);
  addTeamOptions(cmd);
  addJsonOption(cmd);
  addNoInputOption(cmd);

  cmd.action(async (opts: WiCreateFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);

    const title = await readTextArg(opts.title, {
      what: 'title',
      hints: ["Pipe it in with --title -, or pass it single-quoted."],
    });

    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });
    const projectResult = await resolveProject(runner, ctx.project, { project: opts.project });
    const createContext = await resolveCreateContext(
      runner,
      ctx.orgUrl,
      projectResult.project,
      { team: opts.team, area: opts.area, iteration: opts.iteration },
      { reresolve: opts.reresolve, like: opts.like, save: opts.save }
    );

    const args = [
      'boards', 'work-item', 'create',
      '--type', opts.type,
      '--title', azText(title),
      '--area', createContext.areaPath,
      '--iteration', createContext.iterationPath,
      '--organization', ctx.orgUrl,
      '--project', projectResult.project,
    ];
    if (opts.assignTo) args.push('--assigned-to', opts.assignTo);

    const created = await runAzJson<AzWorkItem>(runner, args);
    const warnings = [...createContext.warnings];

    if (opts.parent) {
      // The item is already created at this point — a failure here should
      // degrade to a warning, not lose track of the id we just created.
      try {
        await runAzJson(runner, [
          'boards', 'work-item', 'relation', 'add',
          '--id', String(created.id),
          '--relation-type', 'Parent',
          '--target-id', opts.parent,
          '--organization', ctx.orgUrl,
        ]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`Created #${created.id}, but linking it as a child of #${opts.parent} failed: ${message}`);
      }
    }

    const result = {
      id: created.id,
      url: buildWiWebUrl(ctx.orgUrl, projectResult.project, created.id),
      project: projectResult.project,
      team: createContext.team,
      areaPath: createContext.areaPath,
      iterationPath: createContext.iterationPath,
      parent: opts.parent ? Number(opts.parent) : null,
      warnings,
    };

    await emit(result, opts, () => {
      process.stdout.write(
        [
          `${color.green('Created')} ${opts.type} ${color.bold(`#${result.id}`)}`,
          `  ${color.dim(result.url)}`,
          `  Project: ${result.project}${result.team ? `   Team: ${result.team}` : ''}`,
          `  Area: ${result.areaPath}`,
          `  Iteration: ${result.iterationPath}`,
          result.parent ? `  Parent: #${result.parent}` : undefined,
          ...result.warnings.map((w) => color.yellow(`  Warning: ${w}`)),
        ]
          .filter((l): l is string => l !== undefined)
          .join('\n') + '\n'
      );
    });
  });
}
