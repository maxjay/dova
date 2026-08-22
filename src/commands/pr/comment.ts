import type { Command } from 'commander';
import type { Runner } from '../../lib/exec.js';
import { defaultRunner } from '../../lib/exec.js';
import { resolveContext } from '../../lib/context.js';
import { fetchPrById, postPrComment, replyToPrThread, setPrThreadStatus, resolveThreadStatusInput } from '../../lib/pr.js';
import { addContextOptions, addJsonOption } from '../../lib/command-helpers.js';
import { emit, getColor } from '../../lib/output.js';
import { UserError } from '../../lib/errors.js';

interface PrCommentFlags {
  org?: string;
  orgUrl?: string;
  project?: string;
  repo?: string;
  json?: string | boolean;
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

export function registerPrCommentCommand(pr: Command): void {
  const comment = pr.command('comment <id> <text>').description('Post a new comment thread on a pull request');

  addContextOptions(comment);
  addJsonOption(comment);
  comment.action(async (idArg: string, text: string, opts: PrCommentFlags) => {
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
