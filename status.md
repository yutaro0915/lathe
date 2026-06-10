---
updated: 2026-06-10
current_owner: none
current_stage: tasks/08 approved (codex 起動はユーザーが実施) / G8 design in progress
---

## Current

- task: [08] lathe-client + notify endpoint — **計画済み・未着手**（`tasks/08-lathe-client-push-ingest.md`、受け入れ条件 8 項 + 未決論点 3 点の既定値の人間承認待ち。承認後 codex が `/goal` loop で実施）
- agent: none
- progress: [07] Postgres migration 完了・main へ merge 済み（`c0f8cc4`）。user-stories.md に G8（S1-1 探索モデル未設計）/ G9（S1-3 異常検知無定義）を追加。G8 の prior art 調査（trace explorer UI、disciplined-research）を claude subagent で実行中 → `design/research-g8-trace-explorer-ui.md` に出力予定

## Last completed

- 2026-06-10 [07] Postgres migration — `node:sqlite` / local DB file 依存を Postgres + `pg` に移行。`docker compose -f docker-compose.dev.yml up -d --wait` PASS、`pnpm -F web ingest` PASS、`pnpm -F web coverage` GREEN、`pnpm -F web build` PASS、`pnpm -F web e2e` 49/49 GREEN、`rg -l "node:sqlite" apps/ packages/` 0 件、`rg -l "lathe\\.db" apps/ packages/` 0 件 (codex)
- 2026-06-09 [06] scaffold packages and wiring smoke — `@lathe/shared` / `@lathe/client` skeleton を追加し、`format.ts` を `@lathe/shared` 経由に移動。`pnpm -F web build` PASS、`pnpm -F web coverage` GREEN、`pnpm -F web e2e` 49/49 GREEN (codex)
- 2026-06-09 [05] monorepo block move — app 本体を `apps/web/` へ block move し、root pnpm workspace 化。`pnpm -F web ingest` PASS、`pnpm -F web build` PASS、`pnpm -F web coverage` GREEN、`pnpm -F web e2e` 49/49 GREEN (codex)
- 2026-06-09 ADR 0004 — DB = Postgres（Phase 1 から）+ hybrid dev env（依存だけ Docker・アプリは host）+ dev/prod compose 分離。ROADMAP の DB/deploy 方針を改訂 (claude)
- 2026-06-07 17:06 [04] provider abstraction — `scripts/ingest.ts` を provider loop へ縮小し、Claude/Codex provider、Built 型、DB insert、shared helpers に分解。`pnpm ingest` PASS、`pnpm coverage` GREEN、`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 16:56 [02] extract format utils — shared format helpers を `lib/format.ts` に集約し、components の重複定義を削除。差異は短時間 duration の秒表示と Overview の 0 aggregate 表示を保つ形で統合。`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 16:51 [03] extract UI mappings — runner/event display mapping を `lib/runner-display.ts` / `lib/event-display.ts` に集約。`TYPE_LABEL` は同一内容のため `EVENT_LABEL` に統一。`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 16:46 [01] remove dead code — SessionSidebar / seed script を削除し、PROTOTYPE.md の stale 参照も更新。`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 14:30 [00] handoff — REFACTOR-PLAN.md + tasks/01〜04 + status.md を起こした (claude)

## Open questions / blockers

- [08] 論点 3 点（payload フィールド / 発火 event = Stop / project_id 運搬）は 2026-06-10 ユーザー承認済み。**Codex への task 受け渡しはユーザーが実施**。bound 節の値は起動時に決める
- G8（S1-1 探索モデル）/ G9（S1-3 コスト異常検知）は調査・設計フェーズ。G8 prior art 調査は完了（`design/research-g8-trace-explorer-ui.md`、27 実装・existence proof あり）。次は調査結果のレビュー → 設計の枠組み起こし（disciplined-research の順序）
- schema.sql のコメント劣化は issue #2 に記録済み（https://github.com/yutaro0915/lathe/issues/2）
- （解決済み 2026-06-09 調査）Codex CLI にも Stop hook があり transcript path を stdin で渡す。Codex=scan の前提は棄却（`design/observation-ingest.md`）
- スコープ判断（ユーザー veto 可）: turbo+changesets は YAGNI で後回し（ADR 0003 から sequencing 変更）

## Feedback for Claude

- tasks/01 の grep done criteria は `REFACTOR-PLAN.md` / `tasks/*.md` 自身にも削除対象名が出るため、refactor 指示ファイルを除外して検証した。実装・通常ドキュメント側の `SessionSidebar` / `db/seed` / `"seed": "tsx ..."` は 0 件。
