/**
 * Pure helpers for dev-with-ingest.mjs.
 *
 * Separated into a .mjs module so they can be imported by tests and by the
 * launcher (dev-with-ingest.mjs) using plain node (no tsx required).
 *
 * No top-level execution here — safe to import from tests.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Resolves the `next` binary path under the given webRoot.
 *
 * @param {string} webRoot   - absolute path to the apps/web directory
 * @param {(p: string) => boolean} existsFn  - injectable existence check (defaults to `existsSync`)
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function resolveNextBin(webRoot, existsFn = existsSync) {
  const binPath = resolve(webRoot, 'node_modules', '.bin', 'next');
  if (existsFn(binPath)) {
    return { ok: true, path: binPath };
  }
  return {
    ok: false,
    reason: `next binary not found at ${binPath} — run \`pnpm install\` first`,
  };
}
