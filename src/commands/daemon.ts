import type { Command } from 'commander';
import { addJsonOption, addNoColorOption } from '../lib/command-helpers.js';
import { emit, getColor } from '../lib/output.js';
import { dovaPaths } from '../lib/paths.js';
import { ExitCode } from '../lib/errors.js';
import { connectDaemon, DaemonConnection } from '../daemon/client.js';
import { buildId, type DaemonStatus } from '../daemon/protocol.js';
import { runDaemon } from '../daemon/server.js';
import { serviceManager } from '../daemon/service.js';

async function runningDaemon(): Promise<DaemonConnection | null> {
  try {
    return (await DaemonConnection.open(dovaPaths())).connection;
  } catch {
    return null;
  }
}

function uptime(startedAt: string): string {
  const s = Math.floor((Date.now() - Date.parse(startedAt)) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function serviceInstalled(): boolean {
  try {
    return serviceManager().isInstalled();
  } catch {
    return false;
  }
}

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('The background process that holds your sign-in and talks to Azure DevOps (started automatically)');

  daemon
    .command('run')
    .description('Run the daemon in the foreground (what `start` and the login service launch)')
    .option('--service', 'launched by the OS service manager: wait for a busy socket instead of exiting')
    .action(async (opts: { service?: boolean }) => {
      await runDaemon({ service: opts.service, echoLog: Boolean(process.stderr.isTTY) });
      // The server keeps the process alive from here until it's stopped.
    });

  const start = daemon.command('start').description('Start the daemon if it is not already running');
  addNoColorOption(start);
  start.action(async (opts: { color: boolean }) => {
    const color = getColor(opts.color === false);
    const connection = await connectDaemon();
    const status = (await connection.call('daemon.status')) as DaemonStatus;
    connection.close();
    process.stdout.write(`${color.green('Running')} (pid ${status.pid})\n`);
  });

  const stop = daemon.command('stop').description('Stop the daemon');
  addNoColorOption(stop);
  stop.action(async (opts: { color: boolean }) => {
    const color = getColor(opts.color === false);
    const connection = await runningDaemon();
    if (!connection) {
      process.stdout.write(`${color.dim('Not running.')}\n`);
      return;
    }
    await connection.call('daemon.shutdown');
    connection.close();
    process.stdout.write(`${color.green('Stopped.')}\n`);
    if (serviceInstalled()) {
      process.stdout.write(color.dim('The login service will start it again; `dova daemon uninstall` stops it for good.\n'));
    }
  });

  const restart = daemon.command('restart').description('Stop the daemon and start a fresh one');
  addNoColorOption(restart);
  restart.action(async (opts: { color: boolean }) => {
    const color = getColor(opts.color === false);
    const old = await runningDaemon();
    if (old) {
      await old.call('daemon.shutdown').catch(() => {});
      old.close();
    }
    const connection = await connectDaemon();
    const status = (await connection.call('daemon.status')) as DaemonStatus;
    connection.close();
    process.stdout.write(`${color.green('Running')} (pid ${status.pid})\n`);
  });

  const statusCmd = daemon.command('status').description('Whether the daemon is running, and what it has been doing');
  addJsonOption(statusCmd);
  addNoColorOption(statusCmd);
  statusCmd.action(async (opts: { json?: string | boolean; color: boolean }) => {
    const color = getColor(opts.color === false);
    const paths = dovaPaths();
    const connection = await runningDaemon();
    const status = connection ? ((await connection.call('daemon.status')) as DaemonStatus) : null;
    connection?.close();

    const result = {
      running: Boolean(status),
      ...(status ?? { socket: paths.socket, logFile: paths.logFile }),
      current: status ? status.build === buildId() : null,
      serviceInstalled: serviceInstalled(),
    };
    await emit(result, opts, () => {
      if (!status) {
        process.stdout.write(
          `${color.yellow('Not running.')} It starts on the next dova command, or: dova daemon start\n  Log: ${paths.logFile}\n`
        );
        return;
      }
      process.stdout.write(
        [
          `${color.green('Running')} — pid ${status.pid}, up ${uptime(status.startedAt)}, ${status.requests} request${status.requests === 1 ? '' : 's'} served`,
          `  Version: ${status.build}${result.current ? '' : color.yellow(' (older than this dova — the next command replaces it)')}`,
          `  Socket:  ${status.socket}`,
          `  Log:     ${status.logFile}`,
          `  Started: ${status.service ? 'by the login service' : 'on demand'}${result.serviceInstalled ? '' : color.dim(' (`dova daemon install` starts it at login)')}`,
        ].join('\n') + '\n'
      );
    });
    if (!status) process.exitCode = ExitCode.PrereqError;
  });

  const install = daemon
    .command('install')
    .description('Start the daemon at login and keep it running (systemd / launchd / Windows Startup)');
  addNoColorOption(install);
  install.action(async (opts: { color: boolean }) => {
    const color = getColor(opts.color === false);
    const manager = serviceManager();
    // The on-demand daemon steps aside so the service's own instance is
    // the one running from now on.
    const current = await runningDaemon();
    if (current) {
      await current.call('daemon.shutdown').catch(() => {});
      current.close();
    }
    await manager.install();
    process.stdout.write(`${color.green('Installed')} as a ${manager.kind}: ${color.dim(manager.file)}\n`);
  });

  const uninstall = daemon.command('uninstall').description('Stop starting the daemon at login');
  addNoColorOption(uninstall);
  uninstall.action(async (opts: { color: boolean }) => {
    const color = getColor(opts.color === false);
    const manager = serviceManager();
    if (!manager.isInstalled()) {
      process.stdout.write(`${color.dim('Not installed.')}\n`);
      return;
    }
    await manager.uninstall();
    process.stdout.write(`${color.green('Uninstalled')} ${color.dim(manager.file)}\n`);
  });
}
