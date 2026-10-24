import type { Command } from 'commander';
import { defaultRunner } from '../lib/exec.js';
import { adoJson, adoUrl, accountFromConnectionData, type ConnectionData } from '../lib/ado.js';
import { defaultTransport } from '../lib/transport.js';
import { resolveContext } from '../lib/context.js';
import { addJsonOption, addNoColorOption } from '../lib/command-helpers.js';
import { emit, getColor } from '../lib/output.js';
import { ExitCode } from '../lib/errors.js';

/** The org in context, if there is one — only ever used to check the sign-in against, so never an error. */
async function contextOrgUrl(): Promise<string | undefined> {
  try {
    return (await resolveContext(defaultRunner)).orgUrl;
  } catch {
    return undefined;
  }
}

interface OrgCheck {
  orgUrl: string;
  ok: boolean;
  as?: string;
  error?: string;
}

/** A real request against the org in context — the only way to know the sign-in actually works there. */
async function checkOrg(): Promise<OrgCheck | null> {
  const orgUrl = await contextOrgUrl();
  if (!orgUrl) return null;
  try {
    const data = await adoJson<ConnectionData>(defaultRunner, {
      method: 'GET',
      url: adoUrl(orgUrl, '_apis/connectionData', { 'api-version': '7.1-preview' }),
    });
    const account = accountFromConnectionData(data ?? {});
    return { orgUrl, ok: true, as: account.username ?? account.name };
  } catch (err) {
    return { orgUrl, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Your Azure CLI sign-in, as dova sees it (sign in with `az login`, once)');

  const statusCmd = auth.command('status').description("Who you're signed in as, and whether this repo's organization accepts it");
  addJsonOption(statusCmd);
  addNoColorOption(statusCmd);
  statusCmd.action(async (opts: { json?: string | boolean; color: boolean }) => {
    const color = getColor(opts.color === false);
    const transport = defaultTransport();
    const status = await transport.status();
    const check = status.signedIn ? await checkOrg() : null;

    await emit({ ...status, transport: transport.kind, organization: check }, opts, () => {
      if (!status.signedIn) {
        process.stdout.write(`${color.yellow('Not signed in.')} ${status.error ?? ''}\n  Run: az login (or any dova command, which runs it for you)\n`);
        return;
      }
      const lines = [
        `Signed in as ${color.bold(status.account ?? 'an unnamed account')}${status.tenant ? color.dim(` (tenant ${status.tenant})`) : ''}`,
        `  Token:    from az, cached ${transport.kind === 'daemon' ? 'by the dova daemon' : 'for this command only'} until ${status.expiresAt}`,
      ];
      if (check) {
        lines.push(
          check.ok
            ? `  ${check.orgUrl}: ${color.green('ok')}${check.as ? color.dim(` — as ${check.as}`) : ''}`
            : `  ${check.orgUrl}: ${color.red('failed')} — ${check.error}`
        );
      }
      process.stdout.write(`${lines.join('\n')}\n`);
    });
    if (!status.signedIn || (check && !check.ok)) process.exitCode = ExitCode.PrereqError;
  });
}
