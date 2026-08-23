import type { Command } from 'commander';
import type { Runner } from '../../lib/exec.js';
import { defaultRunner } from '../../lib/exec.js';
import { resolveContext } from '../../lib/context.js';
import {
  fetchPrById,
  postPrComment,
  replyToPrThread,
  setPrThreadStatus,
  resolveThreadStatusInput,
  gatherThreadDetail,
  renderThreadDetailHuman,
} from '../../lib/pr.js';
import { addContextOptions, addJsonOption, addJqOption, addNoColorOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
import { UserError } from '../../lib/errors.js';

interface PrCommentFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  json?: string | boolean;
  jq?: string;
  color: boolean;
}

async function resolveRepoForPr(runner: Runner, orgUrl: string, id: number, fallbackRepo?: string, fallbackProject?: string) {
  const pr = await fetchPrById(runner, orgUrl, id);
  const repo = pr.repository?.name ?? fallbackRepo;
  const project = pr.repository?.project?.name ?? fallbackProject;
  if (!repo || !project) {
    throw new UserError(`Could not determine the repo/project for PR #${id}.`);
  }
  return { pr, repo, project };
}

/**
 * `comment` is a pure group node with no signature/action of its own —
 * deliberately. commander 13.1.0 has a confirmed bug: a command that
 * both takes its own required positional args *and* has subcommands
 * drops every optional-value option (`--json [fields]` included) on
 * every one of its subcommands, silently — no error, `opts.json` is
 * just never populated. "Post a new comment" (what `dova pr comment
 * <id> <text>` used to be, directly) is now its own subcommand marked
 * `isDefault: true`, so `dova pr comment <id> <text>` still works
 * exactly as before with no CLI-facing change, but the group command
 * itself carries no args and the bug doesn't trigger.
 */
export function registerPrCommentCommand(pr: Command): void {
  const comment = pr.command('comment').description('Pull request comment threads: post, show, reply, resolve');

  const addCmd = comment
    .command('add <id> <text>', { isDefault: true })
    .description('Post a new comment thread on a pull request');
  addContextOptions(addCmd);
  addJsonOption(addCmd);
  addCmd.action(async (idArg: string, text: string, opts: PrCommentFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);
    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });
    const id = Number(idArg);
    const { repo, project } = await resolveRepoForPr(runner, ctx.orgUrl, id, ctx.repo, ctx.project);

    const thread = await postPrComment(runner, ctx.orgUrl, project, repo, id, text);

    await emit({ threadId: thread.id, prId: id }, opts, () => {
      process.stdout.write(`${color.green('Posted')} comment on PR #${id} (thread #${thread.id}).\n`);
    });
  });

  const showCmd = comment
    .command('show <id> <thread-id>')
    .description("Read a comment thread's full conversation — every comment, not just the last one");
  addContextOptions(showCmd);
  addJsonOption(showCmd);
  addJqOption(showCmd);
  addNoColorOption(showCmd);
  showCmd.action(async (idArg: string, threadIdArg: string, opts: PrCommentFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);
    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });
    const id = Number(idArg);
    const threadId = Number(threadIdArg);
    const { repo, project } = await resolveRepoForPr(runner, ctx.orgUrl, id, ctx.repo, ctx.project);

    const detail = await gatherThreadDetail(runner, ctx.orgUrl, project, repo, id, threadId);

    await emit(detail, opts, () => renderThreadDetailHuman(detail, color));
  });

  const replyCmd = comment
    .command('reply <id> <thread-id> <text>')
    .description('Reply within an existing comment thread (a response, not a new thread)');
  addContextOptions(replyCmd);
  addJsonOption(replyCmd);
  replyCmd.action(async (idArg: string, threadIdArg: string, text: string, opts: PrCommentFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);
    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });
    const id = Number(idArg);
    const threadId = Number(threadIdArg);
    const { repo, project } = await resolveRepoForPr(runner, ctx.orgUrl, id, ctx.repo, ctx.project);

    const posted = await replyToPrThread(runner, ctx.orgUrl, project, repo, id, threadId, text);

    await emit({ commentId: posted.id, threadId, prId: id }, opts, () => {
      process.stdout.write(`${color.green('Replied')} in thread #${threadId} on PR #${id}.\n`);
    });
  });

  const resolveCmd = comment
    .command('resolve <id> <thread-id> [status]')
    .description("Change a comment thread's status (default: resolved; also: active, won't-fix, closed, pending)");
  addContextOptions(resolveCmd);
  addJsonOption(resolveCmd);
  resolveCmd.action(async (idArg: string, threadIdArg: string, statusArg: string | undefined, opts: PrCommentFlags) => {
    const runner = defaultRunner;
    const color = getColor(opts.color === false);
    const ctx = await resolveContext(runner, { org: opts.org, orgUrl: opts.orgUrl, project: opts.project, repo: opts.repo });
    const id = Number(idArg);
    const threadId = Number(threadIdArg);
    const status = resolveThreadStatusInput(statusArg ?? 'resolved');
    const { repo, project } = await resolveRepoForPr(runner, ctx.orgUrl, id, ctx.repo, ctx.project);

    await setPrThreadStatus(runner, ctx.orgUrl, project, repo, id, threadId, status);

    await emit({ threadId, prId: id, status }, opts, () => {
      process.stdout.write(`${color.green('Set')} thread #${threadId} on PR #${id} to "${status}".\n`);
    });
  });
}
