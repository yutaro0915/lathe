---
id: 30
title: r3-mcp-boundary — @lathe/domain 新設で packages/mcp の apps/web 依存(I2)を解消
status: completed
workflow: loop
audit: A
estimated: medium
bound: 24 turns
depends_on: []
assignee: codex
---
## What
design/convergence-plan.md r3。新パッケージ @lathe/domain を作り packages/mcp が apps/web を import しない状態(I2)にする。critique 訂正: stableJson/parseStoredAnalysis の最終 home を最初から @lathe/domain にする(二重確定回避)。

## 受け入れ条件（全 GREEN まで継続。途中停止禁止）
1. `packages/domain`（純粋・DB/web 非依存）を新設: finding/evidence/verdict のドメイン型、`stableJson`、`parseStoredAnalysis`（型シグネチャを1つに統一）、MCP schema 定数（現 apps/web/lib/mcp.ts の FINDING_BODY_MAX_LENGTH 等）、型ガード(assertFindingKind 等)。`pnpm -F @lathe/domain build` GREEN。tsconfig/exports 整備。
2. `packages/mcp/src/server.ts` と `verify.ts` の `../../../apps/web/lib/*` import を @lathe/domain 由来へ置換。`grep -rn "apps/web" packages/mcp/src/` が postgres 直 import(verify.ts 1行)以外 0。
3. `apps/web/lib/mcp.ts` と `apps/web/scripts/analyst-engine.ts` の重複 `stableJson`/`parseStoredAnalysis` を撤去し @lathe/domain を使用（apps/web 既存 import は re-export で不変に）。
4. `pnpm -F web exec tsc --noEmit` GREEN / `pnpm -F web build` GREEN。
5. `pnpm -F @lathe/mcp verify`(handshake/read/submit/placement) が scratch schema で GREEN(N6)。N1 反証: server.ts の @lathe/domain import を一時コメントアウトで verify:placement が RED。
6. `pnpm lint:deps` の I2 warn(packages/mcp → apps/web)が 3→1 以下に減少（postgres の1件は対象外として残す可）。

## やらないこと
- verify.ts の postgres 直 import(I2)は対象外（後続 packages/db-client）。tasks に残課題記録。
- UI(finding-locator)・withScratch/langOf(=r2 残件)・lib/write(r5) は触らない。

## norms
design/engineering-norms.md N1–N8（特に N1 反証・N6 scratch・N7 型ガード）。全項目 GREEN + git commit([r3])まで継続。push/merge しない。

## 残課題
- `packages/mcp/src/verify.ts` の `../../../apps/web/lib/postgres.js` 直 import は本 r3 では対象外として残した。後続 `packages/db-client` スライスで `DEFAULT_DATABASE_URL` / `getPool` / `closePool` を app 外へ移す。
- `apps/web/lib/postgres.ts` と `packages/mcp/src/postgres.ts` の Postgres helper 重複（JSON/JSONB parser、`DEFAULT_DATABASE_URL`、pool lifecycle、`queryRows` / `queryOne`）は本修正では解かない。後続 `packages/db-client` スライスで単一定義へ寄せる。
