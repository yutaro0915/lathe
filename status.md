---
updated: 2026-06-10
current_owner: none
current_stage: tasks/07 planned (awaiting acceptance-criteria approval)
---

## Current

- task: [07] Postgres migration — **計画済み・未着手**（`tasks/07-postgres-migration.md`、受け入れ条件 7 項の人間承認待ち）
- agent: none（承認後は claude が `/goal` loop で実施、`design/dev-loop.md` v2。開始時に owner を `claude-loop` へ）
- progress: monorepo A complete（[05] apps/web block move + pnpm workspace、[06] @lathe/shared/@lathe/client scaffold + shared format smoke）。dev-loop v2 設計（`/goal` 駆動・両ゲート型）を design/ に追加

## Last completed

- 2026-06-09 [06] scaffold packages and wiring smoke — `@lathe/shared` / `@lathe/client` skeleton を追加し、`format.ts` を `@lathe/shared` 経由に移動。`pnpm -F web build` PASS、`pnpm -F web coverage` GREEN、`pnpm -F web e2e` 49/49 GREEN (codex)
- 2026-06-09 [05] monorepo block move — app 本体を `apps/web/` へ block move し、root pnpm workspace 化。`pnpm -F web ingest` PASS、`pnpm -F web build` PASS、`pnpm -F web coverage` GREEN、`pnpm -F web e2e` 49/49 GREEN (codex)
- 2026-06-09 ADR 0004 — DB = Postgres（Phase 1 から）+ hybrid dev env（依存だけ Docker・アプリは host）+ dev/prod compose 分離。ROADMAP の DB/deploy 方針を改訂 (claude)
- 2026-06-07 17:06 [04] provider abstraction — `scripts/ingest.ts` を provider loop へ縮小し、Claude/Codex provider、Built 型、DB insert、shared helpers に分解。`pnpm ingest` PASS、`pnpm coverage` GREEN、`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 16:56 [02] extract format utils — shared format helpers を `lib/format.ts` に集約し、components の重複定義を削除。差異は短時間 duration の秒表示と Overview の 0 aggregate 表示を保つ形で統合。`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 16:51 [03] extract UI mappings — runner/event display mapping を `lib/runner-display.ts` / `lib/event-display.ts` に集約。`TYPE_LABEL` は同一内容のため `EVENT_LABEL` に統一。`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 16:46 [01] remove dead code — SessionSidebar / seed script を削除し、PROTOTYPE.md の stale 参照も更新。`pnpm build` PASS、`pnpm e2e` 49/49 GREEN (codex)
- 2026-06-07 14:30 [00] handoff — REFACTOR-PLAN.md + tasks/01〜04 + status.md を起こした (claude)

## Open questions / blockers

- monorepo A は完了。次 sprint は Postgres 化（pg 差し替え + schema 方言 + docker-compose.dev + CI/e2e、ADR 0004）
- #2 観測クラスタ設計（hook payload）は Claude 側で並行設計中。YAGNI（当面 Claude/Codex のみ）+ Langfuse 流の hook 自動設定。Codex 稼働中も新規 design ファイル追加で進める（single-writer 抵触なし）
- 要確認（#2 設計時）: Codex CLI に Claude Code 相当の hook 機構があるか（無ければ Codex は catch-up/scan で取り込む）
- スコープ判断（ユーザー veto 可）: A の packages 抽出は A-2（format.ts 1 本で配線 smoke test）。turbo+changesets は YAGNI で後回し（ADR 0003 から sequencing 変更）

## Feedback for Claude

- tasks/01 の grep done criteria は `REFACTOR-PLAN.md` / `tasks/*.md` 自身にも削除対象名が出るため、refactor 指示ファイルを除外して検証した。実装・通常ドキュメント側の `SessionSidebar` / `db/seed` / `"seed": "tsx ..."` は 0 件。
