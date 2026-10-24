import type { Command } from 'commander';
import { defaultRunner } from '../lib/exec.js';
import { adoJson, adoUrl, accountFromConnectionData, type ConnectionData } from '../lib/ado.js';
import { defaultTransport } from '../lib/transport.js';
import { resolveContext } from '../lib/context.js';
import { readTextArg } from '../lib/stdin.js';
import { openInBrowser } from '../lib/browser.js';
import { addJsonOption, addNoColorOption } from '../lib/command-helpers.js';
import { emit, getColor } from '../lib/output.js';
import { dovaPaths } from '../lib/paths.js';
import { ExitCode } from '../lib/errors.js';
import type { AuthStatus, LoginEvent, LoginParams } from '../auth/session.js';

interface LoginFlags {
  deviceCode?: boolean;
  tenant?: string;
  withToken?: boolean;
  json?: string | boolean;
  color: boolean;
}

interface StatusFlags {
  json?: string | boolean;
  color: boolean;
}

/** No browser to open here (an SSH session, a Linux box with no display): use a device code instead. */
export function prefersDeviceCode(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

/** The org in context, if there is one — only ever used to check a token against, so never an error. */
async function contextOrgUrl(): Promise<string | undefined> {
  try {
    return (await resolveContext(defaultRunner)).orgUrl;
  } catch {
    return undefined;
  }
}

function describeAccount(status: AuthStatus): string {
  const { name, username } = status.account ?? {};
  if (name && username && name !== username) return `${name} (${username})`;
  return username ?? name ?? 'an unnamed account';
}

function describeStorage(status: AuthStatus): string {
  switch (status.storage) {
    case 'keychain':
      return 'encrypted, key in the OS keychain';
    case 'file':
      return `in ${dovaPaths().credentialsFile} (no OS keychain available; readable only by you)`;
    case 'environment':
      return '$DOVA_TOKEN';
    default:
      return 'not stored';
  }
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Sign in to Azure DevOps as yourself — held by the dova daemon');

  /* ---------------- login ---------------- */

  const login = auth
    .command('login')
    .description('Sign in with your Microsoft work or school account (or a PAT with --with-token)')
    .option('--device-code', 'sign in with a code on another device, instead of a browser on this one')
    .option('--tenant <id>', 'Entra tenant (id or domain) to sign in to — for an org whose tenant requires it')
    .option('--with-token', 'read a personal access token from stdin instead');
  addJsonOption(login);
  addNoColorOption(login);

  login.action(async (opts: LoginFlags) => {
    const color = getColor(opts.color === false);
    const transport = defaultTransport();

    let params: LoginParams;
    if (opts.withToken) {
      const token = (await readTextArg('-', { what: 'token', hints: ['Pipe it in: dova auth login --with-token < token.txt'] })).trim();
      params = { method: 'pat', token, orgUrl: await contextOrgUrl() };
    } else {
      params = { method: opts.deviceCode || prefersDeviceCode() ? 'device' : 'browser', tenant: opts.tenant };
    }

    const onEvent = (event: LoginEvent): void => {
      if (event.type === 'open-url') {
        process.stderr.write(`Opening your browser to sign in…\n  If it doesn't open, go to:\n  ${color.dim(event.url)}\n`);
        openInBrowser(event.url).catch(() => {
          // The URL is printed above for exactly this case.
        });
      } else {
        process.stderr.write(`${color.bold(event.message)}\n`);
      }
    };

    const status = await transport.auth.login(params, onEvent);
    await emit(status, opts, () => {
      process.stdout.write(
        [
          `${color.green('Signed in')} as ${color.bold(describeAccount(status))}${status.method === 'pat' ? ' with a personal access token' : ''}.`,
          `  Stored ${describeStorage(status)}.`,
          ...(status.storage === 'file' ? [color.yellow('  Warning: no OS keychain was available, so the sign-in is stored unencrypted.')] : []),
        ].join('\n') + '\n'
      );
    });
  });

  /* ---------------- status ---------------- */

  const statusCmd = auth
    .command('status')
    .description("Who you're signed in as, and whether this repo's organization accepts it");
  addJsonOption(statusCmd);
  addNoColorOption(statusCmd);

  statusCmd.action(async (opts: StatusFlags) => {
    const color = getColor(opts.color === false);
    const transport = defaultTransport();
    const status = await transport.auth.status();
    const check = status.signedIn ? await checkOrg() : null;

    const result = { ...status, transport: transport.kind, organization: check };
    await emit(result, opts, () => {
      if (!status.signedIn) {
        process.stdout.write(`${color.yellow('Not signed in.')} Run: dova auth login\n`);
        return;
      }
      const lines = [
        `Signed in as ${color.bold(describeAccount(status))}`,
        `  Method:   ${status.method === 'pat' ? 'personal access token' : 'Microsoft Entra ID'}${status.tenant ? color.dim(` (tenant ${status.tenant})`) : ''}`,
        `  Stored:   ${describeStorage(status)}`,
        `  Requests: ${transport.kind === 'daemon' ? 'through the dova daemon' : 'from this process (no daemon)'}`,
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

  /* ---------------- logout ---------------- */

  const logout = auth.command('logout').description('Forget the stored sign-in');
  addNoColorOption(logout);
  logout.action(async (opts: { color: boolean }) => {
    const color = getColor(opts.color === false);
    await defaultTransport().auth.logout();
    process.stdout.write(`${color.green('Signed out.')}\n`);
  });
}

interface OrgCheck {
  orgUrl: string;
  ok: boolean;
  as?: string;
  error?: string;
}

/** A real request against the org in context — the only way to know a sign-in actually works there. */
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
