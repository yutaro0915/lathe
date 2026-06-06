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
pnpm ingest   # 実際の Claude Code トランスクリプト（~/.claude/projects/...）を取り込む
pnpm dev      # http://localhost:3210
```

`data/lathe.db` は **実トランスクリプト**から生成される（mock ではない）。
取り込み元・件数は env で調整可能:

```
LATHE_TRANSCRIPTS_DIR=<dir>   # 既定: ~/.claude/projects/-Users-cherie-LLMWiki
LATHE_MAX_SESSIONS=12         # 取り込む直近セッション数
LATHE_MAX_EVENTS=500          # 1 セッションあたりのイベント上限
```

`pnpm seed` は実データが無い環境向けの合成デモデータ（オフライン用フォールバック）。
`pnpm build` で本番ビルド、`pnpm start -p <port>` で本番起動。
取り込み後に dev サーバを起動中なら、新 DB を読ませるため**再起動**する
（`node:sqlite` 接続が起動時の DB ファイルを掴むため）。

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
scripts/ingest.ts # 実 Claude Code トランスクリプト（JSONL）を読んで DB を生成。
                  #   Edit の old_string→new_string / Write の content から
                  #   実際の diff hunk を復元し、それを生成したツールイベントに帰属する。
db/seed.ts        # 合成デモデータ（オフライン用フォールバック）
lib/types.ts      # ドメイン型（schema と 1:1）
lib/db.ts         # node:sqlite 接続（singleton）+ 型付き read ヘルパー
app/globals.css   # 白（light）デザインシステム — IDE / devtools 風
app/layout.tsx    # 共通シェル + 上部ナビ
app/page.tsx      # セッションビューア（Server Component, DB 駆動）
app/diff/page.tsx # Git 差分・帰属（同上）
```

ページはすべて Server Component（`export const dynamic = 'force-dynamic'`）で、
リクエスト時に SQLite を読んで描画する。

## データは実トランスクリプト（mock ではない）

`pnpm ingest` が `~/.claude/projects/.../*.jsonl`（このマシンの実 Claude Code セッション）を読み、
セッション・イベント・変更ファイル・差分・帰属を生成する。

- **差分と帰属は実ツール呼び出しから復元**: `Edit` の `old_string`→`new_string`、`Write` の
  `content` を hunk 化し、その hunk を生成した実イベント（tool_use）に帰属させる。
  「Direct edit（high）」はその場でファイルを書いた Edit/Write イベント由来。
- **イベント種別・出力・exit code・トークン**は JSONL の `tool_use` / `toolUseResult` /
  `usage` から取得。Cost は transcript から導けないため捏造せず空（`—`）。
- **取り込み量の上限（silent cap を避けるため明記）**: 直近 `LATHE_MAX_SESSIONS`（既定 12）
  セッション、各 `LATHE_MAX_EVENTS`（既定 500）イベント、変更ファイル 60 / hunk 60 行で打ち切り、
  打ち切り時はタイムライン末尾に明示する。トークンは cache_read（同一プレフィクスの再読込）を
  除外し input+output+cache_creation を集計。

## スコープ

- 範囲内: Phase 1 の 2 画面、DB スキーマ、**実トランスクリプト取り込み**、差分→イベント帰属の信頼度表示。
- 範囲外: Phase 2 以降（AI 分析 / ハーネス評価 / 改善ワークベンチ / エージェント実行 / 統合運用）。
  README.md の 6 機能を順に積む際の Phase 1 土台として使う。

## DB について（better-sqlite3 → node:sqlite）

`AGENTS.md` は `better-sqlite3` 想定だが、検証環境の Node 24 で prebuilt が無く
native build がスキップされたため、Node 24 同梱の `node:sqlite`（`DatabaseSync`）を使う。
同期 API がほぼ同型で、`lib/db.ts` の接続部だけで差し替え可能。
実行時の `ExperimentalWarning: SQLite` は無害。

## 旧版について

初回は誤って提案書のネイビーの概念図（`lathe-scene-render` の 5 シーン）で作ってしまい破棄した。
正しい正本は白い `phase-1-*.png`。本ブランチは白版で作り直したもの。
