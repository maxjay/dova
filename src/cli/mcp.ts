import { UserError } from '../errors.js';
import { DOVA_VERSION } from '../version.js';
import type { Group } from './framework.js';
import { errorData, invoker, serveLines, type Invoke, type ServeOptions } from './rpc.js';

/* ------------------------------------------------------------------ *
 * `dova mcp`: dova as an MCP server (stdio). Not one tool per command —
 * ten tools shaped around what an agent actually does, each mapped onto
 * the commands underneath. Free text travels as JSON, so the shell
 * quoting rules the CLI instructions are full of don't exist here.
 * ------------------------------------------------------------------ */

type Args = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  properties: Record<string, { type: string | string[]; description: string; items?: { type: string | string[] }; enum?: string[] }>;
  required?: string[];
  call(invoke: Invoke, a: Args, scope: Args): Promise<unknown>;
}

const str = (description: string) => ({ type: 'string', description });
const bool = (description: string) => ({ type: 'boolean', description });
const id = (description: string) => ({ type: ['string', 'number'], description });

const TOOLS: Tool[] = [
  {
    name: 'status',
    description: "Start here. The checked-out branch: its pull request, linked work items, latest pipeline runs, and review threads (open first, with each thread's last comment).",
    properties: {},
    call: (invoke, _, scope) => invoke('status', scope),
  },
  {
    name: 'view',
    description: 'A work item (with parent, children and its full description / acceptance criteria / repro steps) or a pull request (with work items and review threads), by id or link. A bare id is tried as a work item first.',
    properties: { id: id('work item or PR id, or a link to either') },
    required: ['id'],
    call: (invoke, a, scope) => invoke('view', { ...scope, idOrUrl: String(a.id) }),
  },
  {
    name: 'summarize',
    description: "Catch up on a branch or PR: its work items' content, commits, and diff stat since it diverged from its base. Pass `files` to get the actual diff for those paths.",
    properties: {
      target: str('branch name, PR id or PR link (default: the checked-out branch)'),
      base: str('compare against this branch (default: the PR target, else the repo default branch)'),
      files: { type: 'array', items: { type: 'string' }, description: 'paths to include the full diff for' },
      full: bool('full commit messages and the whole diff'),
    },
    call: (invoke, a, scope) => invoke('summarize', { ...scope, ...a }),
  },
  {
    name: 'search_work_items',
    description: "Work items in the project, newest change first. Use assignee \"me\" for the signed-in user's.",
    properties: { query: str('words in the title'), state: str('state'), type: str('work item type'), assignee: str('assignee, or "me"'), tag: str('tag') },
    call: (invoke, a, scope) => invoke('wi.search', { ...scope, ...a }),
  },
  {
    name: 'create_work_item',
    description: "File a work item. Area and iteration come from the repo's saved defaults or its team's current sprint; if several teams or areas are possible the error lists them — pass `team` or `area`.",
    properties: {
      title: str('title'),
      type: str('work item type (default: Task; e.g. Bug, User Story)'),
      body: str('description: what and why, repro steps for a bug'),
      parent: id('parent work item id'),
      assignee: str('assignee, or "me"'),
      at: str('file:line to link as "Found in" at the current commit'),
      link: bool('also link it to the checked-out branch'),
      team: str('team to take area and sprint from'),
      area: str('area path'),
      iteration: str('iteration path'),
    },
    required: ['title'],
    call: (invoke, a, scope) => invoke('wi.create', { ...scope, ...a, type: a.type ?? 'Task', parent: a.parent === undefined ? undefined : String(a.parent) }),
  },
  {
    name: 'link_work_items',
    description: 'Record which work items the checked-out branch is for — do this before create_pull_request, or the PR opens with no work item attached. Create and switch branches with git yourself; this never does. `remove: true` unlinks instead.',
    properties: { ids: { type: 'array', items: { type: ['string', 'number'] }, description: 'work item ids' }, primary: id('the main one'), remove: bool('unlink these instead') },
    required: ['ids'],
    call: (invoke, a, scope) => invoke(a.remove ? 'unlink' : 'link', { ...scope, ids: (a.ids as unknown[]).map(String), primary: a.primary === undefined ? undefined : String(a.primary) }),
  },
  {
    name: 'create_pull_request',
    description: "Open a PR from the checked-out branch (push it first). Links the branch's work items; targets the repo's default branch. Completing the PR moves those work items on — don't change their state yourself.",
    properties: {
      title: str("title (default: the last commit's subject)"),
      body: str('description, markdown; any length'),
      target: str('branch to merge into'),
      draft: bool('open as a draft'),
      workItems: { type: 'array', items: { type: ['string', 'number'] }, description: 'work item ids, instead of the linked ones' },
    },
    call: (invoke, a, scope) => invoke('pr.create', { ...scope, ...a, workItems: (a.workItems as unknown[] | undefined)?.map(String) }),
  },
  {
    name: 'review_thread',
    description:
      'Act on PR review threads. thread + nothing else: read every comment in it. thread + text: reply (add status "resolved" to resolve it in the same step). thread + status: just set the status. text without thread: start a new thread.',
    properties: {
      pr: id('PR id or link'),
      thread: id('thread id, as listed by status or view'),
      text: str('comment text, markdown'),
      status: { type: 'string', enum: ['resolved', 'active', 'wontfix', 'closed', 'pending'], description: 'set the thread to this' },
    },
    required: ['pr'],
    async call(invoke, a, scope) {
      const base = { ...scope, pr: String(a.pr), thread: a.thread === undefined ? undefined : String(a.thread) };
      if (!base.thread) {
        if (!a.text) throw new UserError('Pass text to start a thread, or a thread to act on.');
        return invoke('pr.comment', { ...base, text: a.text });
      }
      if (a.text) return invoke('pr.reply', { ...base, text: a.text, resolve: a.status });
      if (a.status) return invoke('pr.resolve', { ...base, status: a.status });
      return invoke('pr.thread', base);
    },
  },
  {
    name: 'pipeline_log',
    description: "Why a pipeline run failed: the log of its first failed task (or all of them). Default: the checked-out branch's latest run.",
    properties: { run: id('run id'), branch: str('latest run of this branch instead'), task: str('this failed task'), all: bool('every failed task') },
    call: (invoke, a, scope) => invoke('pipeline.log', { ...scope, ...a, run: a.run === undefined ? undefined : String(a.run) }),
  },
  {
    name: 'azure_devops_api',
    description: 'Any Azure DevOps REST call, signed in, for what the other tools don\'t cover. A path starting with "/" is org-relative (/_apis/projects); otherwise project-relative (_apis/git/repositories). api-version 7.1 is added.',
    properties: { path: str('REST path, or a full https://dev.azure.com URL'), method: str('GET (default), POST, PATCH, PUT, DELETE'), body: str('request body (JSON text)'), contentType: str('default application/json') },
    required: ['path'],
    call: (invoke, a, scope) => invoke('api', { ...scope, ...a }),
  },
];

/** Every tool can be pointed at a repo or an org/project; the server's own cwd isn't necessarily the agent's. */
const SCOPE = {
  cwd: str("the git repo to act in (default: the server's working directory)"),
  org: str('organization, outside an Azure Repos clone'),
  project: str('project, outside an Azure Repos clone'),
};

export function toolList() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: { ...t.properties, ...SCOPE }, ...(t.required ? { required: t.required } : {}) },
  }));
}

const INSTRUCTIONS =
  'dova is Azure DevOps for the repo you are in: work items, pull requests, pipelines. Start with `status`. ' +
  'Before create_pull_request, run link_work_items for the branch. Never change a work item’s state or assignee yourself. ' +
  'If a tool reports exitCode 3, the user needs to sign in (`az login`) — tell them; never sign in for them.';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export function serveMcp(commands: Group['commands'], opts: ServeOptions = {}): Promise<void> {
  const invoke = invoker(commands, opts);
  const tools = new Map(TOOLS.map((t) => [t.name, t]));
  return serveLines(async (req) => {
    const p = req.params ?? {};
    switch (req.method) {
      case 'initialize':
        return {
          protocolVersion: VERSIONS.includes(p.protocolVersion as string) ? p.protocolVersion : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'dova', version: DOVA_VERSION },
          instructions: INSTRUCTIONS,
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: toolList() };
      case 'tools/call': {
        const tool = tools.get(p.name as string);
        if (!tool) throw Object.assign(new Error(`Unknown tool "${p.name}".`), { code: -32602 });
        const { cwd, org, project, ...args } = (p.arguments ?? {}) as Args;
        try {
          const result = await tool.call(invoke, args, { cwd, org, project });
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
        } catch (err) {
          // A failed call is a result the agent reads, not a protocol error.
          const data = errorData(err);
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message, ...data }) }] };
        }
      }
      default:
        if (req.id === undefined) return null; // notifications/initialized and friends
        throw Object.assign(new Error(`Method not found: ${req.method}`), { code: -32601 });
    }
  }, opts);
}
