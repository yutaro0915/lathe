---
id: 10
title: A-1 turn-first explorer（初期視界 = turn 要約行 + rollup + 時間バー + ファイル導線）
status: done
assignee: codex (/goal loop, design/dev-loop.md v2)
depends_on: [08]   # merge 後の main から分岐すること（コード衝突回避）
estimated: large
workflow: loop
audit: B
bound: 40 turns / 4h   # 2026-06-11 ユーザー承認（受け入れ条件 1〜10 とともに）
---

## What

[design/g8-explorer-ui.md](../design/g8-explorer-ui.md) の**決定（§7、2026-06-10）に基づく A-1 の骨格実装**。
判断材料になった画像: `design/mockups/g8/01a-turn-first-collapsed.png` / `01b-turn-first-expanded.png` /
`04a-file-axis.png`（mockup は方向の参考。ピクセル一致は求めない）。

1. **初期視界の変更**: session を開いたとき、transcript は **turn 要約行（ヘッダ）のみ**を表示する
   （現在の「全 step 展開」をやめる）。turn を click すると step 行が展開される（既存の折りたたみ機構の初期値反転 + 拡張）。
2. **turn rollup**: 各 turn 行に集計 chip を表示する:
   `steps / edits / bash / errors / cost / tokens / duration / files（件数）` + 一行要旨
   （user_message 冒頭の機械抽出。AI 要約はしない）。**errors > 0 の turn は行単位で強調**（淡赤背景）。
3. **step 行の時間バー**: 展開された step 行の右端に、session 全体に対する時間位置 + duration 幅の
   小さなバーを表示（mockup 01b / Phoenix TimelineBar 方式）。
4. **ファイル導線（軽量版）**: turn 行（または展開時ヘッダ）に「files」chip を置き、**click で
   diff タブの該当ファイルへ遷移**する（常時サブ行は出さない — §7 決定 3）。diff 側の
   「このファイルを触った steps」リスト（§5-2、既存 `getLinkedEventsForFile` 流用)も実装する。
5. **フィルタ 2 モード化**: 既存 type フィルタに「ハイライト（非マッチ淡色）/ 非表示」の切替を追加。

## Why

S1-1「5 分で把握」のギャップ（G8）への決定済み対応。経緯と prior art は
[g8-explorer-ui.md](../design/g8-explorer-ui.md) / [research-g8-trace-explorer-ui.md](../design/research-g8-trace-explorer-ui.md)。
A-2 / A-3 は不採用（§7）。**見た目の細部（色・密度・チップの並び）は本 task のスコープ外** —
骨格 GREEN 後にユーザー + Claude が対話的に磨く（dev-loop §4「向かない」領域のため loop に含めない）。

## Input（現状の実測。詳細は g8-explorer-ui.md §1 の棚卸し）

- turn グルーピング・折りたたみは実装済み（`SessionViewer.tsx:376-410`、`collapsedTurns` state）。
  初期視界の変更は概ね「初期値の反転」+ turn 行の中身の刷新。
- サブエージェントのネストは `parentId` / `childrenByParent`（SessionViewer.tsx:300-311）。展開時に既存挙動を維持する。
- step⇄hunk リンクは `eventId`⇄`hunkId`（attribution）で双方向実装済み（DiffViewer.tsx:294-304, 1113-1125）。
  ファイル導線はこの既存キーの流用で実装する（新しいリンク機構を発明しない）。
- rollup の素材は bundle に既にある（events の type / durationMs / tokenUsage / costUsd、`event_files`）。
  サーバ集計（db.ts に turn 軸 query 追加）か client 集計かは実装側の判断でよい。
- 既存 E2E は「step が初期表示されている」前提のテストを含む。**テストの意図を保ったまま更新してよい**
  （例: step 参照の前に turn を展開する操作を足す）。テストの削除・skip・実質空化による充足は不可。

## 受け入れ条件（goal の素材。すべて機械検証）

| # | 条件 | 検証 |
|---|---|---|
| 1 | 初期視界 = turn ヘッダのみ | 新 E2E: session を開いた直後、turn ヘッダ行が表示され step 行が 0 件 |
| 2 | turn rollup 表示 | 新 E2E: turn 行に steps / edits / errors / cost / duration / files の値が表示される（実データの件数と一致） |
| 3 | エラー turn の強調 | 新 E2E: error を含む turn 行に強調用の class / 属性が付く |
| 4 | 展開・再折りたたみ | 新 E2E: turn click で step 行が出る → 再 click で消える。サブエージェントのネスト表示が維持される |
| 5 | 時間バー | 新 E2E: 展開した step 行に時間バー要素が存在し、duration に比例する幅（属性/style で検証） |
| 6 | ファイル導線 | 新 E2E: turn の files chip click → diff タブへ遷移し該当ファイルが active になる。diff 側ファイルヘッダに touched steps リストが出て step click で transcript の該当 step へ戻る |
| 7 | フィルタ 2 モード | 新 E2E: ハイライトモードで非マッチ step が DOM に残る（淡色 class）、非表示モードで消える |
| 8 | 既存 E2E 全件 GREEN | `pnpm -F web e2e` 全件 pass（既存テストは意図を保った更新のみ可。削除・skip 不可） |
| 9 | ビルド + 型 PASS | `pnpm -F web build` exit 0 |
| 10 | coverage 非回帰 | `pnpm -F web coverage` GREEN（UI 変更で ingest を壊していないことの番兵） |

## Out of scope

- 見た目の細部チューニング（色・余白・チップ並び・バーの形状）— 骨格 GREEN 後の対話フェーズ
- A-2（アウトライン左ペイン）/ A-3（Timeline ビュー）— 不採用（§7）
- G9 異常検知（chip の置き場所は mockup 04b にあるが、ロジック未設計のため実装しない）
- AI 生成の turn 要約（Phase 2 の領域。本 task は機械抽出のみ）
- SessionViewer.tsx の全面分割（ただし本 task で触る範囲の自然な分割・抽出は可。
  「分割しないと書けない」場合は loop/PROGRESS.md に判断を記録して進める）

## Loop 運用（/goal 設定メモ）

- 作業ブランチ: `loop/10-turn-first-explorer`。**[08] が main へ merge された後の main から分岐**
  （08 レビューは別セッションで進行中。merge 前に始めない）
- goal 文の骨子: 「受け入れ条件 1〜10 がすべて GREEN。1 ターン 1 項目。実装前に既存実装
  （SessionViewer の turn / collapse / filter、DiffViewer のリンク機構）を検索し再利用する。
  placeholder・テスト無効化・既存テスト削除・受け入れ条件コマンド改変による充足は不可。
  bound 節: 40 ターンまたは 4 時間で未達停止、loop/PROGRESS.md に残課題」（bound は 2026-06-11 確定）
- ループ開始前の人間チェック: 受け入れ条件の承認 / [08] の merge 完了確認 / Postgres 起動 /
  `status.md` の `current_owner` 更新
