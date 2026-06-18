---
id: 31
title: r5-data-layer — lib/write + lib/read 導入（I1 是正・CQRS-light）。r3 後の状態前提
status: completed
workflow: loop
audit: A
estimated: medium
bound: 24 turns
depends_on: [r3]
assignee: codex
---
## What
design/convergence-plan.md r5 + critique 訂正(D1)。**生 SQL は lib/db と ingest/db のみ(I1)**。lib/write は Application(write) で **lib/db の関数を呼ぶ＝生 SQL を持たない**。

## 前提（r3 の結果）
- MCP サービス(submitFinding/queryFindings 等)の home は @lathe/mcp/service。apps/web/lib/mcp.ts は re-export(1行)。**submitFinding を再 home しない**。
- depcruise I1 ルール = lib/db・ingest/db 以外が @/lib/postgres(queryOne/queryRows/getPool) を import すると warn。

## 受け入れ条件（全 GREEN まで継続）
1. apps/web/lib/write.ts を新設（Application write）。verdict コマンド(accept/reject 登録・取消)を **lib/db の関数経由**で実装。**lib/write は @/lib/postgres を import しない**（生 SQL を持たない）。必要な DB 操作は lib/db に関数を足してそれを呼ぶ。
2. app/api/findings/[id]/verdict/route.ts の生 SQL を撤去し lib/write 経由に。**N1 反証**: route に @/lib/postgres 直 import を一時復活させると depcruise I1 warn が出る／戻すと消える、を確認。verdict 関連 e2e GREEN。
3. apps/web/lib/read.ts を新設（薄い query facade）。lib/db.ts の UI 読み取り関数を lib/read 経由で公開し caller の import を @/lib/read に向ける。**lib/db.ts 本体(1612行)の完全分割は対象外**（grandfather 維持）。
4. analyst-engine.ts の backfill UPDATE(getPool 直、約1368行目)のみ lib/write/lib/db 経由化。**N3 missing-only を維持**（既存 analysis を上書きしない）。smoke の getPool(約14件)は対象外（scripts/=I1 機械強制外、tasks に残課題記録）。
5. pnpm -F web exec tsc --noEmit GREEN / pnpm -F web build GREEN / pnpm -F @lathe/mcp verify(scratch,N6) GREEN / verdict e2e GREEN。lint:deps の I1 が verdict route 分だけ減る。

## やらないこと
- lib/db.ts 本体の完全分割(後続)・submitFinding の再 home・UI 変更・analyst の構造分割(r8)・lib/write への raw SQL 配置(D1 違反)。

## norms
design/engineering-norms.md N1–N8（特に N1 反証・N2 no fallback・N3 missing-only・N6 scratch）。全項目 GREEN + git commit([r5])まで継続。push/merge しない。
