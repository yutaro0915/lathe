---
updated: 2026-06-10T17:40+0900
current_owner: claude
current_stage: tasks/09 notify auth hardening 実装済み（branch claude/relaxed-heisenberg-xrvze5、DB 回帰は要 Postgres 環境）/ G8 design draft ready for review
---

## Current

- task: [09] notify 認可ハードニング — **実装完了**（`claude/relaxed-heisenberg-xrvze5`）。[08] follow-up（notify に認可なし）の解消。
- agent: claude
- progress: shared secret（`LATHE_INGEST_TOKEN`、未設定で後方互換スキップ・設定時のみ enforce、定数時間比較）+ transcript path allowlist（realpath→`~/.claude/projects`・`~/.codex/sessions` 等のみ）を defense in depth で実装。client init が token 生成/保存、hook が Authorization 送出（hookVersion 2）。notify.ts 純関数 unit 11/11 PASS、init tmp 検証 PASS、`pnpm -F web build` / `pnpm -F client build` PASS。verify:notify / e2e は本 remote 環境に Postgres 無く未実行（additive・後方互換のため DB 有り環境で GREEN 想定）。
- next: Postgres 起動環境で `pnpm -F web verify:notify`（env 未設定 / 設定の両系）+ `pnpm -F web e2e` を回す → レビュー → merge。

## Last completed

- 2026-06-10 [09] notify auth hardening — `POST /api/ingest/notify` の認可なし（任意ローカルファイル読み取り・DB 上書き）を 2 層で塞いだ。(1) path allowlist: `assertTranscriptPathAllowed`（symlink を realpath 解決、`~/.claude/projects`・`~/.codex/sessions`・`~/.codex/archived_sessions` + `LATHE_TRANSCRIPTS_DIR`/`LATHE_INGEST_ALLOWED_ROOTS` のみ許可）。(2) shared secret: `authorizeIngest`（`LATHE_INGEST_TOKEN` 設定時のみ `Authorization: Bearer` 必須、sha256+timingSafeEqual）。client init が token を生成/再利用して `.lathe/config.json` に保存、hook が送出（`LATHE_HOOK_VERSION` 2）。verify:notify も enforce 時に token 送出。検証: notify.ts 純関数 tsx unit 11/11 PASS、tmp init（hook.mjs `node --check` OK / token 64hex / 再 init 不変 / 既存 .claude hooks 保全）PASS、両 build PASS。**Docker/Postgres 不在のため verify:notify / e2e は未実行**（要 Postgres 環境での再確認）。README/PROTOTYPE/tasks/09/status 更新 (claude)
- 2026-06-10 [08] review + merge — Claude が task 8 をレビュー（重大指摘なし。tx 境界 / fail-open / seq=MIN-1 はサブエージェント初回指摘を実コードで反証）。受け入れ条件 1〜8 を再検証: verify:notify PASS（冪等 counts 不変）、init の既存 hooks 保全 jq PASS、fail-open exit 0、ingest+coverage GREEN、両 build PASS。e2e 48/49 の 1 fail はデータ依存（/diff の既定セッション=changed file 1 件の live セッションで「別ファイル選択」が不成立）で task 8 の回帰ではない。`main` へ ff-merge + push（`f83ead2`）。follow-up: notify endpoint は認可なし（localhost 個人ツール前提、公開デプロイ時は要対応）(claude)
- 2026-06-10 [08] lathe-client + notify endpoint — `packages/client` に `lathe-client init` CLI と fail-open `.lathe/hook.mjs` 生成を追加し、Claude `.claude/settings.json` merge / Codex `.codex/hooks.json` + TOML snippet 生成に対応。本体は `POST /api/ingest/notify` から provider 解析を再利用して該当 session の関連行だけ削除→再挿入する増分 ingest を実装。`pnpm -F web ingest` PASS、`pnpm -F web verify:notify -- --url http://localhost:3210` PASS、`pnpm -F web coverage` GREEN、`pnpm -F client build` PASS、`pnpm -F web build` PASS、`pnpm -F web e2e` 49/49 GREEN (codex)
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

- G8 設計枠組み（`design/g8-explorer-ui.md`）の未決 5 点がユーザーレビュー待ち: 探索モデルの採用範囲（A-1/A-2/A-3）/ turn rollup 項目 / ファイル軸の同時実装 / task 分割 / SessionViewer 分割の同時実施
- G9（コスト異常検知）は未着手。baseline 定義（project 別中央値 / percentile / 絶対閾値）はユーザー判断待ち。表示面の界面は g8-explorer-ui.md §6 に定義済み
- schema.sql のコメント劣化は issue #2 に記録済み（https://github.com/yutaro0915/lathe/issues/2）
- （解決済み 2026-06-09 調査）Codex CLI にも Stop hook があり transcript path を stdin で渡す。Codex=scan の前提は棄却（`design/observation-ingest.md`）
- スコープ判断（ユーザー veto 可）: turbo+changesets は YAGNI で後回し（ADR 0003 から sequencing 変更）

## Feedback for Claude

- tasks/01 の grep done criteria は `REFACTOR-PLAN.md` / `tasks/*.md` 自身にも削除対象名が出るため、refactor 指示ファイルを除外して検証した。実装・通常ドキュメント側の `SessionSidebar` / `db/seed` / `"seed": "tsx ..."` は 0 件。
