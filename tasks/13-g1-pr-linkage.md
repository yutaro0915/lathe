---
id: 13
title: G1 PR 連携（projects テーブル + PR 取り込み + session ⇄ PR 紐付け + PR 起点ビュー）
status: todo
assignee: codex (/goal loop)
depends_on: []   # tasks/11/12 と独立。専用 worktree + 専用 DB で並行実行
estimated: large
workflow: loop
audit: A   # スキーマ migration + 外部 API 界面
bound: 40 turns / 4h
---

## What

[ADR 0006](../adr/0006-pr-linkage-key-and-auth.md) / [design/g1-pr-linkage.md](../design/g1-pr-linkage.md) の実装。
S1-5「PR 起点の閲覧」を閉じる（M2 判定: 自分の PR の意図 → 実装 → review → merge が 1 セッションとして見える）。

1. **スキーマ**: `projects`（ADR 0002 モデル: canonical 正規化 remote / display_name）/
   `pull_requests` / `pr_commits` / `session_commits` 新設、`sessions` を projects 参照へ
2. **SHA 抽出**: provider 解析を拡張し、commit イベント本文から SHA を `session_commits` へ
   （claude / codex 両 provider。抽出できない形式は黙って捨てず件数をログ）
3. **GitHub 取り込み**: token 解決は 1 箇所に抽象化（env `GITHUB_TOKEN` 優先 → `gh auth token`
   fallback。ADR 0006 §3）。初回 backfill = GraphQL（PR 本体 + commits + reviews + 差分統計）、
   増分 = REST `issues?since=` + ETag。catch-up sweep に PR 同期を含める
4. **紐付け**: SHA join 主、`git_branch` ⇄ headRefName 補。時間窓は使わない
5. **UI**: session ヘッダ/一覧行に PR chip（`#N merged` 等）→ PR パネル（description /
   linked sessions / reviews / merge 状態）。PR 一覧（PR 起点ビュー）。
   デザインは [ui-design-language.md](../design/ui-design-language.md) 準拠

## 受け入れ条件（すべて機械検証）

| # | 条件 | 検証 |
|---|---|---|
| 1 | migration 適用後も既存パイプライン GREEN | `pnpm -F web ingest` PASS / `coverage` GREEN / 既存 e2e 全件 PASS |
| 2 | SHA 抽出 | 検証スクリプト: 実 transcript の commit イベント母数に対し抽出成功件数を報告し、抽出した SHA が `git cat-file -t` で実在 commit であることを sample 検査（exit 0） |
| 3 | 実 repo backfill | `pnpm -F web verify:pr -- --repo yutaro0915/lathe` が実 API で PR を取得し、`gh pr list --state all` の件数と DB の件数が一致（exit 0） |
| 4 | 紐付けの正しさ | fixture E2E: 既知の SHA 集合を持つ合成 PR + 合成 session で SHA join と branch fallback の両経路が正しく紐付く |
| 5 | 冪等性 | backfill を 2 回実行して pull_requests / pr_commits の件数不変（検証スクリプト exit 0） |
| 6 | rate limit 安全 | 増分 polling が ETag を送り 304 経路を通ることをログ/テストで確認 |
| 7 | UI | 新 E2E: PR 一覧表示 → PR を開くと linked sessions が表示され、session click で session viewer へ。session 側に PR chip |
| 8 | ビルド | `pnpm -F web build` exit 0 / `pnpm -F client build` PASS（client を触った場合） |

## Out of scope

- PR への書き込み（comment 等）一切 / webhook / fine-grained PAT 移行（issue #4）/
  PR レビュー内容の AI 分析（Phase 2）

## Loop 運用（重要: 専用環境）

- 作業 worktree: `/tmp/lathe-g1`（branch `loop/13-g1-pr-linkage`、main から分岐）
- **専用 DB**: `docker-compose.dev.yml` の postgres 定義を流用し **port 55433** で別コンテナ
  （例: `docker run -d --name lathe-g1-postgres -e POSTGRES_USER=lathe -e POSTGRES_PASSWORD=lathe -e POSTGRES_DB=lathe -p 55433:5432 <compose と同じ image>`）。
  **全コマンドを `DATABASE_URL=postgres://lathe:lathe@localhost:55433/lathe` で実行**
  （本体 55432 は他 task が使用中。絶対に触らない）
- e2e の実行時も同 env を通すこと（playwright config が env を引き継ぐか最初に確認）
- GitHub API は read のみ。`gh auth token` が利用可能（確認済み環境）
