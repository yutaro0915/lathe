# Lathe — Phase 1 prototype（引き継ぎドキュメント）

ブランチ **`prototype/harness-loop-ui`** 専用。`main`（= `56b6846` 計画ドキュメント）は変更しない。
このファイルだけ読めば次の担当者が再開できる状態を目標にする。

## これは何か

ハーネスエンジニアリング基盤 Lathe の **機能1（観測 = トランスクリプト / Git 差分ビューア）** の動くプロトタイプ。
**このマシンの実際の Claude Code セッション**（`~/.claude/projects/`）を取り込み、
Next.js + SQLite の Web UI で観測する。提案書の白い実装イメージ `phase-1-*.png` を正本にしている。

> 正本・参照: `../fukuoka-mitou-2026/work/phase-implementation-image-addendum.md`、
> 画像 `../fukuoka-mitou-2026/submit/images/phase-1-session-viewer.png` /
> `phase-1-git-diff-attribution.png`

## 起動 / 検証（Node 24 前提）

```
pnpm install
pnpm ingest        # ~/.claude/projects/-Users-cherie-LLMWiki/*.jsonl を取り込み data/lathe.db を生成
pnpm dev           # http://localhost:3210

pnpm build         # 本番ビルド（型チェック込み）
pnpm coverage      # 正本(JSONL) ⇄ DB の機械照合（GREEN を確認）
pnpm e2e           # Playwright E2E（22 ケース）
```

注意:
- **DB は再生成物**（`data/lathe.db` は gitignore）。clone 後は必ず `pnpm ingest`。
- **dev 稼働中に `pnpm build` / `pnpm e2e` を走らせない**（同じ `.next` を壊す）。E2E/ビルド前に dev を止める。
- `pnpm ingest` 後に dev が起動済みなら**再起動**する（`node:sqlite` 接続が起動時の DB を掴むため）。
- env: `LATHE_TRANSCRIPTS_DIR`（既定 `~/.claude/projects/-Users-cherie-LLMWiki`）。

## 画面（route）

| route | 画面 | 内容 |
|-------|------|------|
| `/` | セッションビューア | 上部 sessbar（セッション名 + model/branch/commit/日付 + duration/turns/tools/edits/tokens）。左: セッション一覧 + 検索 + Event type フィルタ + Model / Errors 絞り込み + 並び替え。中央: 実行タイムライン（既定で最初の発話を選択）。右: 選択イベント詳細。下: 時間リボン。 |
| `/diff` | Git 差分・帰属 | 左: 変更ファイルツリー。中央: 差分（追加緑/削除赤、Unified/Split）。右: Linked Events + 帰属信頼度（high/medium/unattributed）。上部に Session ドロップダウン。 |

タブ（Transcript / Tools / Git / Skills / Subagents / Raw JSON）は**画面遷移**: viewer の Git → `/diff`、diff の他タブ → `/?session=&tab=`。

## できること（すべて動作・E2E 済み）

- セッション切替（一覧クリック / `?session=`、両画面共有）、検索、Model / Errors 絞り込み、並び替え
- タブ切替（中身が変わる / 画面遷移）、`?tab=` で初期タブ復元
- タイムラインのイベント選択 → 右に**所要時間 / Exit / Tokens / Tool calls** のチップ + **出力（stdout/stderr）/ Result / Thinking 全文**（折返し・copy）
- **サブエージェント展開**: ランチャー行の「N steps」を展開すると内部のツール・スキルがインデント表示
- **thinking 閲覧**: 本文のある extended-thinking を `thinking` イベントとして表示（紫 ✲、フィルタチップ、詳細に全文）
- Event type フィルタ（thinking 含む）、Pin / Add Note（localStorage 永続）、Copy（クリップボード）
- **時間リボン**（下部）: 各セグメント幅 = 次ステップまでの実経過時間。全幅・ズーム・ホバーで所要時間・実時刻軸
- 差分: ファイル選択 / フォルダ折りたたみ / Unified⇄Split / Hunk 前後 / Linked Event 選択 / Raw JSON

## データモデル / 取り込み

`db/schema.sql`（SQLite, `node:sqlite`）:
`sessions / transcript_events(parent_id で sub-agent 子ステップ) / changed_files / diff_hunks /
attributions / event_files / annotations`。型は `lib/types.ts`、read 層は `lib/db.ts`（`getSessionBundle`）。

`scripts/ingest.ts`（`pnpm ingest`）が実 JSONL を取り込む:
- 1 transcript = 1 session（最近の全セッション、上限は実質撤廃）。
- イベント: user/assistant テキスト・**thinking（本文ありのみ）**・tool_use（Bash/Edit/Write/Read/Skill/MCP/…）。
- **所要時間** = tool_use → tool_result のタイムスタンプ差。サブエージェントは結果の `<usage>` から duration / tokens / tool_uses を抽出。
- **差分と帰属**は実ツール呼び出しから復元（`Edit` の old→new / `Write` の content を hunk 化し、その tool_use イベントに high 帰属）。
- **サブエージェント**: `<session>/subagents/agent-<id>.jsonl` を `meta.json.toolUseId` で親に紐付け、子イベント（`parent_id`）として取り込む。
- `error_count` = 非ゼロ終了のツール呼び出し + error イベント数（**セッションの成否判定ではない**。バッジは `N errors`、0 なら非表示）。
- Cost は transcript から導けないため空。

`scripts/coverage_check.ts`（`pnpm coverage`）= 正本(JSONL) ⇄ DB の機械照合。MISSING/DROPPED が無ければ GREEN。
直近3分以内に更新中の transcript は「live」として除外し明示（並行書き込み対策）。

## ファイル構成

```
app/
  layout.tsx            # 共通シェル + 上部ナビ
  page.tsx              # / : サーバラッパー → components/SessionViewer
  diff/page.tsx         # /diff : サーバラッパー → components/DiffViewer
  globals.css           # 白(light)デザインシステム
components/
  SessionViewer.tsx     # セッションビューア（client、全インタラクション）
  DiffViewer.tsx        # Git 差分・帰属（client）
  TimeRibbon.tsx        # 共有の時間リボン
db/
  schema.sql            # スキーマ（正本）
  seed.ts               # 合成デモデータ（pnpm seed、オフライン用フォールバック）
lib/
  types.ts  db.ts       # 型 / read 層
scripts/
  ingest.ts             # 実トランスクリプト取り込み（pnpm ingest）
  coverage_check.ts     # 網羅性照合（pnpm coverage）
e2e/app.spec.ts         # Playwright E2E（22 ケース）
playwright.config.ts
```

## 既知の制約 / 申し送り

- **未 push**: コミットはローカルのみ（`prototype/harness-loop-ui`、origin/main より先行）。リモート反映はユーザー判断。
- **thinking は大半が redacted**（Claude Code が署名のみに）。本文のある分だけ表示。
- **`node:sqlite` を使用**（`AGENTS.md` は `better-sqlite3` 想定だが Node 24 で prebuilt 不在のため）。接続部のみで差し替え可。
- **Cost / commit SHA など transcript に無い値は出さない**（捏造しない）。
- 取り込み対象は **Claude Code のみ**（Codex / Cursor は別形式で未対応）。
- スコープは Phase 1（観測）まで。Phase 2 以降（AI 分析 / ハーネス評価 / 改善ワークベンチ / エージェント実行 / 統合）は未着手。

## 次の一歩（再開時の候補）

- Phase 2: AI 分析（finding 抽出、MCP ツール経由の根拠リンク）。`README.md` の機能2に対応。
- 実トランスクリプトの増分取り込み / 監視。
- Codex・Cursor トランスクリプト形式への対応。
- リモート push + OSS 化検討（提案書提出後）。
