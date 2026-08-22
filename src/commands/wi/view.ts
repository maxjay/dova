import type { Command } from 'commander';
import { defaultRunner } from '../../lib/exec.js';
import { resolveContext } from '../../lib/context.js';
import { fetchWorkItem, buildWiWebUrl, fieldValue } from '../../lib/work-items.js';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption, addWebOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
import { openInBrowser } from '../../lib/browser.js';
import { UserError } from '../../lib/errors.js';

interface WiViewFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  json?: string | boolean;
  jq?: string;
  web?: boolean;
  color: boolean;
}

export function registerWiViewCommand(wi: Command): void {
  const cmd = wi.command('view <id>').description("View a work item's detail");

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);
  addWebOption(cmd);

  cmd.action(async (idArg: string, opts: WiViewFlags) => {
    const id = Number(idArg);
    if (!Number.isInteger(id) || id <= 0) {
      throw new UserError(`"${idArg}" is not a valid work item id.`);
    }

    const runner = defaultRunner;
    const ctx = await resolveContext(runner, {
      org: opts.org,
      orgUrl: opts.orgUrl,
      project: opts.project,
      repo: opts.repo,
    });

    const item = await fetchWorkItem(runner, ctx.orgUrl, id);
    const project = fieldValue(item, 'System.TeamProject') ?? ctx.project;
    const url = buildWiWebUrl(ctx.orgUrl, project, id);

    if (opts.web) {
      await openInBrowser(url);
      return;
    }

    const result = {
      id: item.id,
      type: fieldValue(item, 'System.WorkItemType'),
      title: fieldValue(item, 'System.Title'),
      state: fieldValue(item, 'System.State'),
      assignedTo: fieldValue(item, 'System.AssignedTo'),
      areaPath: fieldValue(item, 'System.AreaPath'),
      iterationPath: fieldValue(item, 'System.IterationPath'),
      parent: item.fields['System.Parent'] ?? null,
      description: fieldValue(item, 'System.Description'),
      url,
    };

    const color = getColor(opts.color === false);
    await emit(result, opts, () => {
      const lines = [
        `${color.bold(`#${result.id}`)} ${result.title ?? color.dim('(no title)')}`,
        `${color.dim(String(result.type))} · ${color.dim(String(result.state))}${result.assignedTo ? ` · ${color.dim(`assigned to ${result.assignedTo}`)}` : color.dim(' · unassigned')}`,
        '',
        `Area:      ${result.areaPath ?? color.dim('(none)')}`,
        `Iteration: ${result.iterationPath ?? color.dim('(none)')}`,
        result.parent ? `Parent:    #${result.parent}` : undefined,
        '',
        color.dim(result.url),
      ].filter((l): l is string => l !== undefined);
      process.stdout.write(`${lines.join('\n')}\n`);
    });
  });
}
