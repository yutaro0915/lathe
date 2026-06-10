---
id: 07
title: Postgres migration (node:sqlite -> pg) + docker-compose.dev
status: done
assignee: codex (/goal loop, design/dev-loop.md v2)
depends_on: [05, 06]
estimated: large
---

## What

DB を `node:sqlite`（`data/lathe.db`）から **Postgres**（`pg` / node-postgres）へ移行し、dev 依存として `docker-compose.dev.yml`（Postgres のみ）を追加する。接続先は env の seam（`DATABASE_URL`）に切り出す。アプリは host で `pnpm dev`、DB だけ Docker（hybrid dev、ADR 0004）。

本 task は dev-loop v2（[design/dev-loop.md](../design/dev-loop.md)）の**初回 goal loop 対象**。完了判定は本ファイルの「受け入れ条件」のコマンド結果のみを根拠とする。

## Why

[ADR 0004](../adr/0004-postgres-from-phase-1-and-hybrid-dev-env.md) 参照。end state（セルフホスト = Docker + Postgres）確定で YAGNI 不成立。schema が 7 table・全 GREEN の clean checkpoint の今が最安。`pg` は pure JS で native build 痛が消える。`jsonb` が Phase 2（finding/meta）に向く。

## Input（現状の実測）

- node:sqlite API は **3 ファイルに集中**:
  - `apps/web/lib/db.ts` — 読み（lazy singleton、`process.cwd()/data/lathe.db` 直書き、L628 に `json_extract` 1 query）
  - `apps/web/scripts/ingest/db.ts` — 書き（`resetDatabase` が schema を流す / `insertBuilt`）
  - `apps/web/scripts/coverage_check.ts` — 検証（`DB_PATH` 直書き）
- `apps/web/db/schema.sql` — 7 table。SQLite 固有: `PRAGMA foreign_keys`（L14）、`INTEGER PRIMARY KEY AUTOINCREMENT`（L100, L108 = event_files / annotations）
- npm scripts: `dev / build / start / ingest / coverage / e2e`（Playwright、現 49/49 GREEN）
- **既知の難所**: `DatabaseSync` は同期 API、`pg` は async。`lib/db.ts` の全関数と呼び出し側（server components / route handlers）の async 化が波及範囲の本体。型は `lib/types.ts` のまま維持する。

## Output

1. **`docker-compose.dev.yml`**（repo root）: `postgres`（公式 image、版は LTS 系を選び根拠をコメント）+ named volume + healthcheck + published port。依存のみ、アプリは入れない（ADR 0004 決定 2/4）。
2. **schema 方言パス**: `apps/web/db/schema.sql` を Postgres 方言へ（`AUTOINCREMENT` → `GENERATED ALWAYS AS IDENTITY`、`PRAGMA` 削除、`meta` 等 JSON 列は `jsonb` 化、`json_extract` → `->>`）。WAL ファイル処理の削除。
3. **3 DB モジュールの `pg` 書換**: 接続は `DATABASE_URL`（env seam、ADR 0004 決定 8）。`process.cwd()/data/lathe.db` 直書きを廃止。dev 既定値は `.env.example` に記載（`localhost:<port>`）。
4. **e2e / coverage の Postgres 化**: `pnpm -F web e2e` と `pnpm -F web coverage` が compose 起動済み Postgres に対して GREEN。ingest → e2e の手順を README（または PROTOTYPE.md の起動節）に 3 行で追記。
5. **`AGENTS.md` の Stack 節更新**（「Next.js + SQLite」→ Postgres。ADR 0004 が「実装が入った時点で更新」と指定）。

## 受け入れ条件（goal の素材。すべて機械検証）

| # | 条件 | 検証コマンド |
|---|---|---|
| 1 | dev 依存 compose で Postgres が healthy | `docker compose -f docker-compose.dev.yml up -d --wait` が exit 0 |
| 2 | ingest が Postgres に書き込める | `pnpm -F web ingest` が exit 0 |
| 3 | 正本 JSONL ⇄ DB の機械照合 GREEN | `pnpm -F web coverage` が exit 0（SQLite 時と同件数） |
| 4 | ビルド + 型 PASS | `pnpm -F web build` が exit 0 |
| 5 | E2E 全件 GREEN | `pnpm -F web e2e` が 49/49 pass |
| 6 | node:sqlite 参照の消滅 | `rg -l "node:sqlite" apps/ packages/` が 0 件 |
| 7 | 接続先が env seam | `rg -l "lathe\.db" apps/ packages/` が 0 件（docs/コメントの履歴言及は除外可）かつ `.env.example` に `DATABASE_URL` 記載 |

## Out of scope

- prod / self-host compose（需要実在化まで保留、ADR 0004）
- CI への postgres service 追加（CI 自体が未導入）
- クラウド実行時の ingest 変種（lathe-client push、ADR 0004 で MVP 外と明示保留）
- Phase 2 の table 追加・query 拡張

## Loop 運用（/goal 設定メモ）

- 作業ブランチ: `loop/07-postgres-migration`（prototype/harness-loop-ui から分岐）
- goal 文の骨子: 「受け入れ条件 1〜7 がすべて該当コマンドで exit 0 / 全件 pass になること。1 ターンに着手する項目は 1 つ。実装前に既存実装を検索すること。placeholder・テスト無効化・受け入れ条件コマンド自体の改変による充足は不可。bound 節: 〔レビューで確定〕ターンまたは〔レビューで確定〕時間を超えたら未達のまま停止し、loop/PROGRESS.md に残課題を書くこと」
- ループ開始前の人間チェック: 本ファイルの受け入れ条件承認 / Docker Desktop 起動確認 / `status.md` の `current_owner` を `claude-loop` へ
- 推奨実装順（参考、loop 側の判断を拘束しない）: compose + schema 方言 → ingest/db.ts → coverage_check.ts → lib/db.ts async 化と呼び出し側 → e2e 通し → 直書きパス掃除 → AGENTS.md
