import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { PrereqError } from '../lib/errors.js';
import { daemonCommand, spawnDaemon } from './client.js';

/* ------------------------------------------------------------------ *
 * `dova daemon install`: have the OS start the daemon at login and keep
 * it running. The CLI starts one on demand regardless; this makes it
 * already be there, and brings it back if it ever dies.
 *
 *   Linux    systemd user unit, Restart=always
 *   macOS    launchd agent, KeepAlive
 *   Windows  a hidden launcher in the Startup folder
 *
 * The service instance runs with `--service`: if a daemon is already up
 * when it starts, it waits for the socket instead of exiting, so the
 * OS-managed one is always the one that takes over.
 * ------------------------------------------------------------------ */

/** Environment a daemon needs that a login session may not hand it: proxy settings, and dova's own overrides. */
const PASSTHROUGH_ENV = [
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'DOVA_HOME', 'DOVA_CLIENT_ID',
];

export interface ServiceManager {
  /** Human name, for messages. */
  kind: string;
  /** Where the definition lives. */
  file: string;
  isInstalled(): boolean;
  install(): Promise<void>;
  uninstall(): Promise<void>;
}

export function serviceManager(platform: NodeJS.Platform = process.platform): ServiceManager {
  if (platform === 'linux') return systemd();
  if (platform === 'darwin') return launchd();
  if (platform === 'win32') return windowsStartup();
  throw new PrereqError(`dova can't install a login service on ${platform}.`, ['It still starts its daemon on demand.']);
}

function serviceArgs(): { command: string; args: string[] } {
  const { command, args } = daemonCommand();
  return { command, args: [...args, '--service'] };
}

function passthroughEnv(): Array<[string, string]> {
  return PASSTHROUGH_ENV.flatMap((name) => (process.env[name] ? [[name, process.env[name]!] as [string, string]] : []));
}

/* ---------------- systemd ---------------- */

const SYSTEMD_UNIT = 'dova.service';

/** systemd's quoting: double quotes, with backslash and quote escaped. */
function systemdQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function systemdUnit(command: string, args: string[], env: Array<[string, string]>): string {
  return [
    '[Unit]',
    'Description=dova — Azure DevOps daemon',
    '',
    '[Service]',
    `ExecStart=${[command, ...args].map(systemdQuote).join(' ')}`,
    ...env.map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`),
    'Restart=always',
    'RestartSec=1',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function systemd(): ServiceManager {
  const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', SYSTEMD_UNIT);
  const systemctl = async (...args: string[]): Promise<void> => {
    try {
      await execa('systemctl', ['--user', ...args]);
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim();
      throw new PrereqError(`systemctl --user ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}.`, [
        'No systemd user session here? dova still starts its daemon on demand.',
      ]);
    }
  };
  return {
    kind: 'systemd user service',
    file,
    isInstalled: () => fs.existsSync(file),
    async install() {
      const { command, args } = serviceArgs();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, systemdUnit(command, args, passthroughEnv()));
      await systemctl('daemon-reload');
      await systemctl('enable', '--now', SYSTEMD_UNIT);
    },
    async uninstall() {
      await systemctl('disable', '--now', SYSTEMD_UNIT).catch(() => {});
      fs.rmSync(file, { force: true });
      await systemctl('daemon-reload').catch(() => {});
    },
  };
}

/* ---------------- launchd ---------------- */

const LAUNCHD_LABEL = 'dev.dova.daemon';

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function launchdPlist(command: string, args: string[], env: Array<[string, string]>): string {
  const strings = (values: string[]): string => values.map((v) => `    <string>${xmlEscape(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([command, ...args])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

function launchd(): ServiceManager {
  const file = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${process.getuid?.() ?? ''}`;
  return {
    kind: 'launchd agent',
    file,
    isInstalled: () => fs.existsSync(file),
    async install() {
      const { command, args } = serviceArgs();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Replacing an existing agent: unload the old definition first.
      await execa('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]).catch(() => {});
      fs.writeFileSync(file, launchdPlist(command, args, passthroughEnv()));
      try {
        await execa('launchctl', ['bootstrap', domain, file]);
      } catch (err) {
        throw new PrereqError(`launchctl bootstrap failed: ${(err as { stderr?: string }).stderr?.trim() ?? err}`);
      }
    },
    async uninstall() {
      await execa('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]).catch(() => {});
      fs.rmSync(file, { force: true });
    },
  };
}

/* ---------------- Windows ---------------- */

/** A VBScript launcher: the only built-in way to start node at login without a console window flashing up. */
export function windowsLauncher(command: string, args: string[]): string {
  const quoted = [command, ...args].map((a) => `""${a.replace(/"/g, '')}""`).join(' ');
  return `CreateObject("WScript.Shell").Run "${quoted}", 0, False\r\n`;
}

function windowsStartup(): ServiceManager {
  const startup = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
  );
  const file = path.join(startup, 'dova-daemon.vbs');
  return {
    kind: 'Windows Startup launcher',
    file,
    isInstalled: () => fs.existsSync(file),
    async install() {
      const { command, args } = serviceArgs();
      fs.mkdirSync(startup, { recursive: true });
      fs.writeFileSync(file, windowsLauncher(command, args));
      // Startup items run at the next login; start one for this session now.
      spawnDaemon();
    },
    async uninstall() {
      fs.rmSync(file, { force: true });
    },
  };
}
