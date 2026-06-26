/**
 * Dev launcher: spawns incremental ingest detached in background, then
 * runs next dev in foreground with all CLI args forwarded.
 *
 * Guarantees:
 *  (a) next dev starts immediately (ingest is detached, not awaited).
 *  (b) ingest failure never kills next dev (separate process, stdio to log file).
 *  (c) CLI args (e.g. --port 3210) are forwarded to next dev unchanged.
 *  (d) Works whether invoked via root `pnpm dev` or `pnpm -C apps/web dev`.
 */

import { spawn } from 'node:child_process';
import { existsSync, openSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 1. Launch incremental ingest — detached, stdio redirected to log file
// ---------------------------------------------------------------------------

const LOG_FILE = '/tmp/lathe-ingest.log';

try {
  const tsxBin = resolve(webRoot, 'node_modules', '.bin', 'tsx');
  const ingestScript = resolve(__dirname, 'ingest-incremental.ts');

  if (existsSync(tsxBin) && existsSync(ingestScript)) {
    // Open log file as a file descriptor (required for detached spawn on all platforms)
    const logFd = openSync(LOG_FILE, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o644);

    const ingest = spawn(tsxBin, [ingestScript], {
      cwd: webRoot,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    ingest.unref(); // do not hold the event loop open for ingest

    console.log(`[lathe-ingest] background ingest started (log: ${LOG_FILE})`);
  } else {
    console.warn('[lathe-ingest] tsx or ingest script not found — skipping background ingest');
  }
} catch (err) {
  // Never let ingest-launch errors prevent next dev from starting
  console.warn('[lathe-ingest] failed to start background ingest:', err?.message ?? String(err));
}

// ---------------------------------------------------------------------------
// 2. Run next dev in foreground — forwards all CLI args
// ---------------------------------------------------------------------------

const extraArgs = process.argv.slice(2); // e.g. ['--port', '3210']
const nextBin = resolve(webRoot, 'node_modules', '.bin', 'next');

const next = spawn(nextBin, ['dev', ...extraArgs], {
  cwd: webRoot,
  stdio: 'inherit',
  env: process.env,
});

next.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
