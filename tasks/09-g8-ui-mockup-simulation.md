---
id: 09
title: G8 探索 UI の画像シミュレーション（現アプリ見た目ベース・複数案）
status: done
assignee: codex（単発タスク。goal loop ではない）
depends_on: []   # tasks/08 と独立。ただし git 操作の注意（下記）あり
estimated: medium
---

## What

[design/g8-explorer-ui.md](../design/g8-explorer-ui.md) の探索 UI 案（A-1 / A-2 / A-3 / ファイル軸 + G9）を、
**現アプリの実際の見た目をベースにした画像生成**でシミュレートする。文章だけでは判断できないため、
「今の画面がこう変わる」が一目で分かる比較画像を作り、ユーザーが採用範囲（未決 5 点）を決める材料にする。

**実装はしない。コードは一切変更しない。** 成果物は画像と NOTES.md のみ。

## Why

G8 の未決 5 点（採用範囲 / turn rollup 項目 / ファイル軸 / task 分割 / SessionViewer 分割）の判断材料。
設計ノートの文章 + prior art 表だけでは「自分のアプリでどう見えるか」が想像できない、というユーザー要請（2026-06-10）。

## Input

- [design/g8-explorer-ui.md](../design/g8-explorer-ui.md) — 案の定義（§3 探索モデル、§4 turn rollup、§5 ファイル軸、§6 G9 表示面）
- [design/research-g8-trace-explorer-ui.md](../design/research-g8-trace-explorer-ui.md) — 参照する見た目の実例（Phoenix の行内時間バー、Jaeger の全折りたたみ、codex-trace の 3 パネル等）
- 現アプリの起動: `docker compose -f docker-compose.dev.yml up -d --wait` → （DB が空なら）`pnpm -F web ingest` → `pnpm -F web dev`。実データ入りで起動すること
- 対象画面: ① session viewer（transcript タブ、turn ヘッダが見える状態）② git diff タブ ③ /overview

## 手順

### Step 1 — 基準スクリーンショットの取得（最重要）

実アプリを起動し、**実データの入った状態**で上記 ①②③ のスクリーンショットを撮る（幅 1600px 以上）。
これが全シミュレーションの「正」。生成画像は必ずこの基準画像の**視覚言語（配色・タイポグラフィ・密度・
余白・既存コンポーネントの形）を維持**すること。新しいブランドカラーや別フォントを発明しない。
基準画像も成果物として保存する（`00-baseline-*.png`）。

### Step 2 — 各案のシミュレーション画像を生成

基準画像をベースに、以下の変更だけを加えた画像を生成する。1 画像 = 1 案の 1 状態。
**画像の左上に案ラベルのバッジを焼き込む**（例: `案1 / A-1 turn-first`）。

#### 案 1 — A-1「turn-first」（初期視界の変更のみ）

対象: 画面①。2 枚生成。

- **1a（初期視界）**: タイムラインが **turn 要約行だけ**になった状態。各 turn 行は 1 行で:
  `▸ Turn 3 「ユーザー発話の冒頭 30 字…」 12 steps · 3 edits · 1 error · $0.42 · 1m30s · db.ts +2`
  エラーを含む turn は行ごと赤系に強調。レイアウト（3 列・sessbar・TimeRibbon・フィルタ列）は現状のまま。
- **1b（1 turn 展開）**: 1a から 1 つの turn を展開した状態。step 行は現行の見た目を維持しつつ、
  **各 step 行の右端に小さな時間バー**（session 全体に対する位置 + durationMs 幅。Phoenix の
  TimelineBar 方式）を追加。サブエージェント child のネストは現行どおり。

#### 案 2 — A-2「左ペインのアウトライン化」

対象: 画面①。1 枚生成。

- 左ペインが session 一覧ではなく、**選択中 session の turn/step ツリー**（ファイラ風の開閉三角、
  インデント、turn ノードに件数/コストの小さな付記）になった状態。最上部に「← Sessions」の戻り導線。
- 中央 = 選択 step の詳細（現 aside の内容を主役化）。右 aside は廃止または中央に統合した形。
- 参考実例: codex-trace の 3 パネル / devtools Elements パネル。

#### 案 3 — A-3「Tree / Timeline トグル」

対象: 画面①。1 枚生成（Timeline 側のみ。Tree 側は案 1 と同一のため省略）。

- sessbar 付近に `[ Tree | Timeline ]` トグルを追加し、**Timeline ビュー**を表示した状態:
  各 turn / step が横バー（開始位置 = 時刻、幅 = duration、色 = event 種、エラー = 赤）で
  縦に並ぶ waterfall。Langfuse timeline / Jaeger を参考に、ただし配色は現アプリに合わせる。

#### 案 4 — ファイル軸 + G9 オーバーレイ（§5 + §6。案 1 への追加として描く）

2 枚生成。

- **4a（ファイル軸）**: 対象画面①。案 1b の展開 turn の直下に **「Files touched」サブ行**:
  ファイル名 + status 色（modified/added/deleted）+ `+12 −3`。1 ファイルに hover/選択風の強調を付け、
  「diff へ」の遷移を示唆する矢印 chip。加えて対象画面②で、diff のファイルヘッダに
  「このファイルを触った steps: Turn 2 / step 14, Turn 5 / step 31」のリストを追加した状態（同一画像内で
  上下分割 or 別画像可）。
- **4b（G9 anomaly）**: 対象画面③（overview）+ 画面①の session 一覧部。session 一覧行に
  anomaly chip（例: `▲ cost p95 超`）、sessbar に「最も高い turn へ →」「エラー turn へ →」の
  ジャンプチップが付いた状態。検知ロジックは未設計のため、**chip の見た目と置き場所だけ**を示す
  （閾値の数字をもっともらしく書かない。`▲ 異常候補` 程度の表現でよい）。

### Step 3 — 比較シートと NOTES

- **contact sheet 1 枚**: baseline と全案のサムネイルを並べた比較画像（横並び、各サムネイルにラベル）。
- **NOTES.md**: 案ごとに「基準画像から変えた点」を箇条書き 5 行以内 + 生成時に迷った点・
  設計ノートと矛盾しそうな点（あれば）。ユーザーが画像を見ながら読む前提で簡潔に。

## Output（配置）

```
design/mockups/g8/
├── 00-baseline-transcript.png / 00-baseline-diff.png / 00-baseline-overview.png
├── 01a-turn-first-collapsed.png
├── 01b-turn-first-expanded.png
├── 02-outline-pane.png
├── 03-timeline-toggle.png
├── 04a-file-axis.png
├── 04b-anomaly-chips.png
├── 99-contact-sheet.png
└── NOTES.md
```

## 受け入れ条件

| # | 条件 |
|---|---|
| 1 | 上記 10 ファイルが `design/mockups/g8/` に存在する |
| 2 | 全シミュレーション画像の左上に案ラベルバッジがある |
| 3 | 基準画像が実アプリ・実データのスクリーンショットである（モック起こしでない） |
| 4 | 生成画像が基準画像の配色・タイポグラフィを維持している（別物の UI を発明していない） |
| 5 | NOTES.md に案ごとの変更点列挙がある |
| 6 | コード変更が 0（`git status` で `design/mockups/g8/` 以外に変化がない） |

## 注意（git / 並行作業）

- **tasks/08 の goal loop が `loop/08-push-ingest` で稼働中**。本タスクは新規ファイル追加のみなので
  並行可能だが、**git commit / branch 操作は行わない**こと（成果物は untracked のまま置く。
  回収・commit はユーザーまたは Claude が 08 の状況を見て行う）。
- dev server / docker は使用後そのままでよい（08 のゲートが Postgres を使うため、**コンテナを落とさない**）。

## Out of scope

- 実装・コード変更（採用案決定後に別 task として受け入れ条件付きで切る）
- G9 の検知ロジック設計（baseline 定義はユーザー判断待ち）
- ダークモード等のテーマ違いの網羅（基準画像のテーマ 1 つでよい）
