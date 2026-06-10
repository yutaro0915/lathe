---
id: 08
title: lathe-client + POST /api/ingest/notify（push 主・pull 補の ingest）
status: done
assignee: codex (/goal loop, design/dev-loop.md v2)
depends_on: [07]
estimated: large
---

## What

[ADR 0001](../adr/0001-ingest-via-hook-and-server-side-jsonl.md) で決定済みの **D 案（hook トリガー + サーバ側 jsonl 読み）** の残実装。

1. `@lathe/client`（`packages/client/`、現状 skeleton 1 行）を実装する。`lathe-client init` が対象 repo に hook を登録し、本体 URL と project identity を保存する。
2. 本体側に `POST /api/ingest/notify` を実装する。hook から識別子（`session_id` / `transcript_path` / `project_id` / `cwd` / `agent` 等）だけを受け、**該当セッションのみ**を transcript ファイルから読んで Postgres に増分 ingest する。
3. 既存の全量 ingest（`pnpm -F web ingest`）は **catch-up sweep として残す**（廃棄しない。ADR 0001 Consequences）。

これが入ると S1-4（自動取り込み: 手動 `pnpm ingest` なしで反映）が成立する。

## Why

[ADR 0001] 参照（2026-06-07 accepted、「実装は Phase 1 リファクタ完了後の next sprint」→ [05][06][07] 完了済みの今がその時点）。pure push（B 案）は thinking が hook payload に来ないため棄却済み。Langfuse が同方式（hook トリガー + transcript 読み）を実証している。

## Input（確定事実。詳細は [design/observation-ingest.md](../design/observation-ingest.md)）

- **Claude Code**: `Stop` / `SessionEnd` hook が **stdin JSON** で `session_id` / `transcript_path` / `cwd` を渡す。登録先は `.claude/settings.json`（`hooks.<Event>[].hooks[]{type:"command", command}`）。SessionEnd は timeout 1.5s・cleanup 用。
- **Codex**: lifecycle `Stop` hook が **stdin JSON** で rollout transcript path を渡す（Langfuse plugin が使う経路）。SessionEnd 相当は無い。設定は user-level `~/.codex/config.toml`。
- **両 agent 対称**に「path を運ぶ薄い hook」で扱える。push/scan の二分法は不要（2026-06-09 調査済み）。
- 現 ingest は CLI 全量 reset 型（`apps/web/scripts/ingest/db.ts` の `resetDatabase` + `insertBuilt`、tx 境界あり）。**単一セッションの増分・冪等 ingest は未実装** — 本 task の実装本体。
- transcript 解析ロジックは `apps/web/scripts/ingest/providers/{claude,codex}.ts` に実装済み。notify 経路はこれを**再利用**する（再実装しない）。
- `packages/client/src/index.ts` は 1 行の skeleton。`@lathe/shared` の利用パターンは [06] 参照。

## 設計上の論点（**2026-06-10 ユーザー承認済み**）

[observation-ingest.md](../design/observation-ingest.md) 末尾の 3 点。以下で確定:

1. **payload フィールド**: `{ agent, session_id, transcript_path, cwd, project_id?, event }`（本文は運ばない。ADR 0001）
2. **発火 event**: Claude Code = `Stop`（毎ターン、増分反映）。Codex = `Stop`。SessionEnd は使わない（timeout 1.5s が fire-and-forget でも詰まりうるため）
3. **project_id**: `lathe-client init` 時に解決して保存し、hook が毎回運ぶ（ADR 0002 のモデルに従う）

## Output

1. **`packages/client/`**: `lathe-client init` CLI。`.claude/settings.json` への Stop hook 登録（既存 hooks を壊さない merge）、Codex 用 hook 設定の生成、本体 URL / project_id の保存。hook 本体は「stdin JSON → 識別子 POST」だけの薄いスクリプト（fail-open: 本体が落ちていても agent をブロックしない）。
2. **`POST /api/ingest/notify`**（Next.js route handler）: 受領 → 該当 transcript のみ読み → **当該セッションを冪等に upsert**（同一 session_id の再 notify で重複しない）。ビジネスロジックは route handler 直書きにせず、`apps/web/scripts/ingest/` 側の関数として切り出して呼ぶ（将来のサービス分離の継ぎ目）。
3. **増分 ingest 関数**: 全量 reset を経由せず単一セッションを insert/update する経路。既存 provider 解析を再利用。
4. **catch-up sweep の維持**: `pnpm -F web ingest`（全量）は従来どおり GREEN。
5. **README / PROTOTYPE.md の起動節更新**: `lathe-client init` → セッション終了 → 自動反映、の 3 行手順。

## 受け入れ条件（goal の素材。すべて機械検証）

| # | 条件 | 検証コマンド |
|---|---|---|
| 1 | notify が単一セッションを ingest する | dev server 起動後、実在 transcript で `curl -sf -X POST localhost:3000/api/ingest/notify -d @payload.json` が 2xx、直後に DB へ該当 session_id が存在（検証スクリプト exit 0） |
| 2 | 冪等性 | 同一 payload を 2 回 POST → sessions / transcript_events の件数が 1 回目と不変（検証スクリプト exit 0） |
| 3 | 増分性 | notify 前後で**他セッション**の行数が不変（全量 reset を踏んでいない）（検証スクリプト exit 0） |
| 4 | init が hook を登録する | tmp dir で `lathe-client init` 実行 → `.claude/settings.json` に Stop hook エントリが存在し、既存 hooks 設定が保存されている（`jq` 検査 exit 0） |
| 5 | fail-open | 本体停止状態で hook スクリプトに stdin JSON を流しても exit 0（agent をブロックしない） |
| 6 | catch-up sweep 維持 | `pnpm -F web ingest` exit 0 かつ `pnpm -F web coverage` GREEN |
| 7 | ビルド + 型 PASS | `pnpm -F web build` exit 0 / `pnpm -F client build`（または同等）exit 0 |
| 8 | E2E 全件 GREEN | `pnpm -F web e2e` が 49/49 pass（回帰なし） |

検証スクリプト（条件 1〜3 用）は `apps/web/scripts/` 配下に置き、受け入れ条件コマンド自体の改変による充足は不可。

## Out of scope

- PR ⇄ セッション紐付け（G1、別 task）
- マルチ PC / クラウド実行の push 変種（ADR 0004 で MVP 外と明示保留）
- 探索 UI 再設計（G8）・コスト異常検知（G9）
- npm への `lathe-client` 公開（`private:true` のまま）
- reverse proxy / サービス分離（継ぎ目は package 切り出しまで）

## Loop 運用（/goal 設定メモ）

- 作業ブランチ: `loop/08-push-ingest`（main から分岐）
- goal 文の骨子: 「受け入れ条件 1〜8 がすべて該当コマンドで exit 0 / 全件 pass。1 ターン 1 項目。実装前に既存実装（providers / ingest/db.ts）を検索し再利用する。placeholder・テスト無効化・受け入れ条件コマンド改変による充足は不可。bound 節: 〔レビューで確定〕ターンまたは〔レビューで確定〕時間で未達停止、loop/PROGRESS.md に残課題」
- ループ開始前の人間チェック: ~~未決論点 1〜3 の既定値承認~~（2026-06-10 承認済み）/ Docker Desktop + Postgres 起動（`docker compose -f docker-compose.dev.yml up -d --wait`）/ `status.md` の `current_owner` を `codex-loop` へ / bound 節の値を起動時に決める
- 推奨実装順（参考）: 増分 ingest 関数（冪等 upsert）→ notify route handler → 検証スクリプト → client CLI（init + hook script）→ fail-open → docs
