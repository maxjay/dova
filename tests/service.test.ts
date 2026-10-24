import { describe, it, expect } from 'vitest';
import { launchdPlist, systemdUnit, windowsLauncher } from '../src/daemon/service.js';
import { proxyUrl } from '../src/lib/proxy.js';
import { dovaPaths } from '../src/lib/paths.js';

describe('systemdUnit', () => {
  it('restarts always, and quotes paths with spaces', () => {
    const unit = systemdUnit('/usr/bin/node', ['/home/j/my tools/dova/dist/index.js', 'daemon', 'run', '--service'], [
      ['HTTPS_PROXY', 'http://proxy:8080'],
    ]);
    expect(unit).toContain('ExecStart=/usr/bin/node "/home/j/my tools/dova/dist/index.js" daemon run --service');
    expect(unit).toContain('Environment=HTTPS_PROXY=http://proxy:8080');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
  });
});

describe('launchdPlist', () => {
  it('keeps the agent alive and escapes XML', () => {
    const plist = launchdPlist('/opt/node', ['/a&b/index.js', 'daemon', 'run', '--service'], [['NO_PROXY', '<local>']]);
    expect(plist).toContain('<string>/a&amp;b/index.js</string>');
    expect(plist).toContain('<string>&lt;local&gt;</string>');
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });
});

describe('windowsLauncher', () => {
  it('runs hidden (window style 0) and does not wait', () => {
    expect(windowsLauncher('C:\\Program Files\\nodejs\\node.exe', ['C:\\dova\\index.js', 'daemon', 'run', '--service'])).toBe(
      'CreateObject("WScript.Shell").Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\dova\\index.js"" ""daemon"" ""run"" ""--service""", 0, False\r\n'
    );
  });
});

describe('proxyUrl', () => {
  it('uses HTTPS_PROXY', () => {
    expect(proxyUrl({ HTTPS_PROXY: 'http://p:1' })).toBe('http://p:1');
  });

  it('is skipped when NO_PROXY covers every host dova talks to', () => {
    expect(proxyUrl({ HTTPS_PROXY: 'http://p:1', NO_PROXY: '.azure.com' })).toBeNull();
    expect(proxyUrl({ https_proxy: 'http://p:1', no_proxy: '*' })).toBeNull();
  });

  it('still applies when NO_PROXY covers something else', () => {
    expect(proxyUrl({ HTTPS_PROXY: 'http://p:1', NO_PROXY: 'internal.example' })).toBe('http://p:1');
  });

  it('is null with no proxy configured', () => {
    expect(proxyUrl({})).toBeNull();
  });
});

describe('dovaPaths', () => {
  it('puts everything under $DOVA_HOME when set', () => {
    const p = dovaPaths({ DOVA_HOME: '/x' }, 'linux');
    expect([p.stateDir, p.socket]).toEqual(['/x', '/x/dovad.sock']);
  });

  it('prefers $XDG_RUNTIME_DIR for the socket on Linux', () => {
    expect(dovaPaths({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux').socket).toBe('/run/user/1000/dova/dovad.sock');
  });

  it('uses a per-user named pipe on Windows', () => {
    expect(dovaPaths({}, 'win32').socket).toMatch(/^\\\\\.\\pipe\\dova-/);
  });
});
