import type { Runner } from './exec.js';
import { gitConfigGet } from './config.js';

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Turns a work item title into a branch-name-safe slug: lowercase, ASCII, dash-separated, capped length. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '') // strip combining accents left behind by NFKD decomposition
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

/** Turns a work item type name into a safe git-config key segment (e.g. "Product Backlog Item" -> "product-backlog-item"). */
export function typeToConfigKey(type: string): string {
  return type
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const BUILTIN_PREFIX_BY_TYPE_KEY: Record<string, string> = { bug: 'bugfix' };
const BUILTIN_DEFAULT_PREFIX = 'feature';

/**
 * Branch prefix for a work item type, from a user-configurable map (never
 * hardcoded to one process template): `git config --global
 * dova.branch-prefix.<type>` / `dova.branch-prefix.default`, falling back
 * to the built-in default (Bug -> bugfix, everything else -> feature) only
 * when nothing is configured.
 */
export async function resolveBranchPrefix(runner: Runner, type: string): Promise<string> {
  const key = typeToConfigKey(type);
  const configured = await gitConfigGet(runner, `dova.branch-prefix.${key}`, { global: true });
  if (configured) return configured;

  const configuredDefault = await gitConfigGet(runner, 'dova.branch-prefix.default', { global: true });
  if (configuredDefault) return configuredDefault;

  return BUILTIN_PREFIX_BY_TYPE_KEY[key] ?? BUILTIN_DEFAULT_PREFIX;
}

export function buildBranchName(prefix: string, primaryId: number, slug: string): string {
  return slug ? `${prefix}/${primaryId}-${slug}` : `${prefix}/${primaryId}`;
}
