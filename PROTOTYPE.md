# Lathe prototype — Phase 1（トランスクリプト / Git 差分ビューア）

ブランチ `prototype/harness-loop-ui` 専用。`main` は計画ドキュメントのみで変更しない。

提案書の **白い実装イメージ（`phase-1-*.png`）** を正本に、Phase 1 の 2 画面を
Next.js + SQLite で動く read-only ビューアとして実装したもの。
コーディングエージェントの実行過程を「会話ログ」ではなく、会話・ツール実行・
サブエージェント・スキル・ファイル変更が結びついた実行記録として読める状態にする。

> 仕様の正本: `projects/fukuoka-mitou-2026/work/phase-implementation-image-addendum.md`
> 画像: `projects/fukuoka-mitou-2026/submit/images/phase-1-session-viewer.png` /
> `phase-1-git-diff-attribution.png`

## 起動

```
pnpm install
pnpm seed     # data/lathe.db を生成（毎回まっさら）
pnpm dev      # http://localhost:3210
```

`pnpm build` で本番ビルド、`pnpm start -p <port>` で本番起動。

## 画面（route）

| route | 画面 | 内容 |
|-------|------|------|
| `/` | セッションビューア | 左: セッション一覧 + Event type フィルタ。中央: 実行タイムライン（会話/ツール/編集/Bash/サブエージェント/スキル/コミット/テストを色分け）。右: 選択イベント詳細 + Linked files + Run JSON。下: タイムライン密度ミニマップ。 |
| `/diff` | Git 差分・帰属 | 左: 変更ファイルツリー（+/- 数）。中央: 差分（追加緑/削除赤）。右: その差分を生んだイベント（Linked Events）と帰属の信頼度。下: セッション変更ミニマップ。 |

帰属の信頼度: **high（Edit/Write 由来・緑）/ medium（シェル経由の推定・橙）/ unattributed（未コミット変更等・灰）**。
未帰属を無理にエージェントへ紐付けない、という Phase 1 の方針をそのまま UI に出している。

## 構成

```
db/schema.sql     # Phase 1 entities（sessions / transcript_events /
                  #   changed_files / diff_hunks / attributions /
                  #   event_files / annotations）
db/seed.ts        # 実データ: 主セッション「Lathe rebuild from scratch」
                  #   （42 events / 6 changed files / 9 hunks / 9 attributions）+ 他5件
lib/types.ts      # ドメイン型（schema と 1:1）
lib/db.ts         # node:sqlite 接続（singleton）+ 型付き read ヘルパー
app/globals.css   # 白（light）デザインシステム — IDE / devtools 風
app/layout.tsx    # 共通シェル + 上部ナビ
app/page.tsx      # セッションビューア（Server Component, DB 駆動）
app/diff/page.tsx # Git 差分・帰属（同上）
```

ページはすべて Server Component（`export const dynamic = 'force-dynamic'`）で、
リクエスト時に SQLite を読んで描画する。

## スコープ

- 範囲内: Phase 1 の 2 画面、それを支える DB スキーマ + 実データ seed、差分→イベント帰属の信頼度表示。
- 範囲外: Phase 2 以降（AI 分析 / ハーネス評価 / 改善ワークベンチ / エージェント実行 / 統合運用）。
  実トランスクリプトの ingest（JSONL 取り込み）も未接続で、現状は seed データで動かす。
  README.md の 6 機能を順に積む際の Phase 1 土台として使う。

## DB について（better-sqlite3 → node:sqlite）

`AGENTS.md` は `better-sqlite3` 想定だが、検証環境の Node 24 で prebuilt が無く
native build がスキップされたため、Node 24 同梱の `node:sqlite`（`DatabaseSync`）を使う。
同期 API がほぼ同型で、`lib/db.ts` の接続部だけで差し替え可能。
実行時の `ExperimentalWarning: SQLite` は無害。

## 旧版について

初回は誤って提案書のネイビーの概念図（`lathe-scene-render` の 5 シーン）で作ってしまい破棄した。
正しい正本は白い `phase-1-*.png`。本ブランチは白版で作り直したもの。
