import type { Command } from 'commander';
import { defaultRunner, runAzJson } from '../../lib/exec.js';
import { resolveContext } from '../../lib/context.js';
import { buildWiql, isCurrentUserToken } from '../../lib/wiql.js';
import { fieldValue } from '../../lib/work-items.js';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption } from '../../lib/command-helpers.js';
import { emit, getColor, renderTable } from '../../lib/output.js';
import type { AzWorkItem } from '../../types/azure-devops.js';

interface WiSearchFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  state?: string;
  assignedTo?: string;
  type?: string;
  tag?: string;
  json?: string | boolean;
  jq?: string;
  color: boolean;
}

const RESULT_FIELDS = ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo'];

export function registerWiSearchCommand(wi: Command): void {
  const cmd = wi
    .command('search <query>')
    .description('Search work items by free-text title match plus filters (builds WIQL for you)')
    .option('--state <state>', "filter by state (as defined by this project's process)")
    .option('--assigned-to <user>', 'filter by assignee ("me" for the current user)')
    .option('--type <type>', 'filter by work item type')
    .option('--tag <tag>', 'filter by tag');

  addContextOptions(cmd);
  addJsonOption(cmd);
  addJqOption(cmd);
  addNoColorOption(cmd);

  cmd.action(async (query: string, opts: WiSearchFlags) => {
    const runner = defaultRunner;
    const ctx = await resolveContext(runner, {
      org: opts.org,
      orgUrl: opts.orgUrl,
      project: opts.project,
      repo: opts.repo,
    });

    const wiql = buildWiql({
      fields: RESULT_FIELDS,
      where: [
        { field: 'System.TeamProject', op: '=', value: ctx.project },
        ...(query ? [{ field: 'System.Title', op: 'CONTAINS' as const, value: query }] : []),
        ...(opts.state ? [{ field: 'System.State', op: '=' as const, value: opts.state }] : []),
        ...(opts.type ? [{ field: 'System.WorkItemType', op: '=' as const, value: opts.type }] : []),
        ...(opts.tag ? [{ field: 'System.Tags', op: 'CONTAINS' as const, value: opts.tag }] : []),
        ...(opts.assignedTo
          ? [
              isCurrentUserToken(opts.assignedTo)
                ? { field: 'System.AssignedTo', op: '=' as const, macro: '@Me' }
                : { field: 'System.AssignedTo', op: '=' as const, value: opts.assignedTo },
            ]
          : []),
      ],
      orderBy: '[System.ChangedDate] DESC',
    });

    const items = (await runAzJson<AzWorkItem[] | null>(runner, [
      'boards', 'query',
      '--wiql', wiql,
      '--organization', ctx.orgUrl,
    ])) ?? [];

    const results = items.map((w) => ({
      id: w.id,
      title: fieldValue(w, 'System.Title'),
      state: fieldValue(w, 'System.State'),
      type: fieldValue(w, 'System.WorkItemType'),
      assignedTo: fieldValue(w, 'System.AssignedTo'),
    }));

    const color = getColor(opts.color === false);
    await emit({ items: results, count: results.length }, opts, () => {
      if (results.length === 0) {
        process.stdout.write(`${color.dim('No work items matched.')}\n`);
        return;
      }
      const rows = results.map((r) => [
        `#${r.id}`,
        r.type ?? color.dim('?'),
        r.state ?? color.dim('?'),
        r.title ?? color.dim('(no title)'),
        r.assignedTo ?? color.dim('unassigned'),
      ]);
      process.stdout.write(`${renderTable(['ID', 'Type', 'State', 'Title', 'Assigned To'], rows)}\n`);
    });
  });
}
