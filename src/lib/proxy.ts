import { ProxyAgent, setGlobalDispatcher } from 'undici';

/* ------------------------------------------------------------------ *
 * Node's fetch ignores HTTPS_PROXY. dova only ever fetches Azure DevOps,
 * so one global proxy decision covers every request it makes.
 * (A TLS-inspecting proxy's CA comes from NODE_EXTRA_CA_CERTS, which Node
 * reads itself.)
 * ------------------------------------------------------------------ */

const HOSTS = ['dev.azure.com'];

export function proxyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxy) return null;
  const noProxy = (env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bypassed = (host: string): boolean =>
    noProxy.some((rule) => rule === '*' || host === rule.replace(/^\./, '') || host.endsWith(rule.startsWith('.') ? rule : `.${rule}`));
  return HOSTS.every(bypassed) ? null : proxy;
}

let configured = false;

export function configureProxy(): void {
  if (configured) return;
  configured = true;
  const proxy = proxyUrl();
  if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));
}
