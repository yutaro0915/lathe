#!/usr/bin/env node
// CLI: node scripts/inner-queue.mjs [--max K] [--max-failures N] [--dry-run]
// DEPRECATED shim — inner-queue は単一 orchestrator に吸収された（#201 分解 9）。
// 新しい入口は `node scripts/orchestrator.mjs`（derive → classify → dispatch → 投影）。
// 本ファイルは後方互換のためだけに残る:
//   - CLI は同義 flag をそのまま orchestrator へ委譲する（--max の既定は orchestrator
//     側の 5 に変わる。旧 2 が必要なら明示すること）
//   - 純関数の import 面（inner-queue-decisions.mjs の再 export）は維持する
// spawn 系（spawnInnerLoop / buildInnerLoopSpawnSpec）と gh 結線は orchestrator.mjs
// が置き換えたため削除済み。

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

export * from './inner-queue-decisions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  process.stderr.write('[inner-queue] DEPRECATED: use `node scripts/orchestrator.mjs` — delegating\n');
  const result = spawnSync(process.execPath, [join(__dirname, 'orchestrator.mjs'), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
}
