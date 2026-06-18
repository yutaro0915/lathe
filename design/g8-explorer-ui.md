---
title: G8 設計枠組み — 探索 UI（session → turn → step）と diff 関連付け
type: design-note
status: draft（レビュー待ち）
updated: 2026-06-10
related: [user-stories.md, research-g8-trace-explorer-ui.md]
---

# G8 設計枠組み: 「5 分で把握」を支える探索モデル

S1-1 の結果節「transcript の生 JSONL を読まずに 5 分で把握する」を成立させる探索 UI の設計枠組み。
入力は (1) prior art 調査 [research-g8-trace-explorer-ui.md](./research-g8-trace-explorer-ui.md)（27 実装、以下 [R]）、
(2) 現 UI 資産の棚卸し（2026-06-10 実施、以下「棚卸し」）。
**調査 → 枠組みの順**（disciplined-research）。本ノートの選択肢は観察事実にアンカーする。

## 1. 現状資産（棚卸し要約）

| 資産 | 現状 | G8 への含意 |
|---|---|---|
| turn グルーピング | user_message 境界で turn 化、turn 単位の折りたたみあり（SessionViewer.tsx:376-410） | 「掘る」ための階層は**既にある**。無いのは「初期視界」と「turn 行の要約」 |
| サブエージェントのネスト | `parentId` で親子、展開/折りたたみ（SessionViewer.tsx:300-311） | ツリーの 3 段目（turn → step → child steps）も既にある |
| step ⇄ diff 双方向リンク | `eventId`⇄`hunkId`（attribution 経由）で実装済み・E2E 検証済み（DiffViewer.tsx:294-304, 1113-1125） | **prior art の大半より進んでいる**（hunk 粒度。[R] Q2 で行粒度は PR レビュー系のみ） |
| TimeRibbon | zoom・クリック選択・密度・event 種の色分け（TimeRibbon.tsx） | Jaeger/Tempo の minimap 定石 [R Q1-b] に相当。**維持** |
| フィルタ・検索 | 15 種 type フィルタ + substring 検索 | [R] の log-level フィルタ / ハイライト・非表示切替に未対応 |
| 集計 | session 一覧行（duration/model/tokens/cost/errors）、sessbar の 6 kstat、Overview の getStats | **turn 単位の集計が無い**。異常検知（G9）も無い |

ギャップの本体: **(a) 初期視界が「全 step 展開のタイムライン」**（5 分把握には情報過多）、
**(b) turn 行に要約が無い**（折りたたむと中身が見えなくなるだけ）、**(c) ファイル軸の探索が無い**、
**(d) 異常の手がかりが無い**（G9）。

## 2. 設計原則（観察事実から。[R] の節番号でアンカー）

- **P1: ツリーと時間軸を排他にしない**。調査した実装はトグル（Langfuse）・同一行併置（Jaeger/Tempo/Phoenix の waterfall）・複数ビュー（Helicone/Weave）で両立 [R Q3]。「ツリー型 vs タイムライン型」の二者択一で設計しない。
- **P2: デフォルトは折りたたみ、全体像から掘る**。Jaeger はデフォルト全 span 折りたたみで「どこが重いか」を先に見せる [R Q1-b]。
- **P3: 集計は 4 箇所に置ける**: 一覧行 / ツリー行内 / ヘッダ・minimap / 事後レポート [R 設計示唆]。「5 分把握」は (一覧行 → ヘッダ → ツリー行) の順に視線が降りる。
- **P4: master-detail + 3 パネルが coding-agent ビューアの反復パターン**（codex-trace の 一覧→turn→詳細、claude-code-trace の master-detail）[R Q1-c]。現 3 列構成と整合。
- **P5: フィルタは「ハイライト or 非表示」を選べる形**（Grafana Span Filters）[R Q1-b]。文脈を消さずに絞れる。

## 3. 枠組み A — 探索モデル（共通基盤 + 選択肢）

### 共通基盤（どの案でも入る。原則 P1〜P3 の直接適用）

1. **初期視界 = turn 単位の要約行（全折りたたみ）**。session を開くと turn ヘッダだけが並び、
   各行に turn rollup（§4）が出る。掘りたい turn だけ展開 → step → サブエージェント children。
   ＝「ディレクトリ構造のように掘る」体験は、**新ビュー追加ではなく初期状態と行内容の変更**で実現できる
   （階層は棚卸しのとおり既存）。
2. **step 行に時間バー併置（waterfall 化）**。各 step 行の右に session 全体に対する時間位置・幅
   （`durationMs`）の小さなバーを置く（Phoenix の `TimelineBar` 方式 [R Q1-a]）。ツリーを掘っても
   時間軸を失わない。TimeRibbon は俯瞰 minimap として維持。
3. **フィルタの 2 モード化**: 現 type フィルタに「ハイライト（非マッチを淡色）/ 非表示」の切替を足す（P5）。

### 選択肢（どこまでやるか）

| 案 | 内容 | 根拠となる実例 | 増分コスト | 失うもの |
|---|---|---|---|---|
| **A-1: 初期視界の変更のみ** | 共通基盤 1〜3 だけ。レイアウトは現 3 列のまま | Jaeger の default-collapsed [R Q1-b] | 小（state 初期値 + turn 行 rollup + バー併置） | 左ペインは session 一覧のまま。「session 内の地図」は持たない |
| **A-2: 左ペインをアウトラインに** | session 選択後、左ペインを session 一覧 → **turn/step アウトライン**に切替（戻るで一覧へ）。中央 = 選択 step 詳細 | codex-trace の 3 パネル（日付→session→turn→詳細）[R Q3]、devtools Elements 型 | 中（左ペインの 2 モード化） | session 横断の文脈（一覧と地図の同時表示は不可） |
| **A-3: ビュートグル** | Tree / Timeline をトグルで切替（両ビューで集計同等） | Langfuse 新 trace view [R Q1-a] | 大（2 ビューの維持コスト） | 実装・保守の二重化。個人ツールには過剰の可能性 |

**推奨順序の提案**（判断はユーザー）: A-1 → 使ってみて「session 内の地図」が要るなら A-2。
A-3 は Langfuse がチームの多用途（debug / cost / eval）向けに持つもので、persona = Yutaro 1 人の
dogfood では A-1/A-2 で足りる可能性が高い。これは [R] の観察（複数ビューは多 persona 製品に出現）からの推論。

## 4. 枠組み B — turn rollup（「5 分把握」の核心データ）

turn ヘッダ行に出す要約。DB は `transcript_events` から turn 境界（user_message の seq 範囲）で
GROUP BY するだけで、新テーブル不要（`countEventsByType` の turn 軸版）。

| 項目 | 内容 | 出典パターン |
|---|---|---|
| steps / edits / bash | type 別件数の超圧縮表示（例: `12 steps · 3 edits · 2 bash`） | Weave の cost per op 行内表示 [R Q1-a] |
| errors | エラー件数。**> 0 なら行を赤系で強調** | Langfuse の log-level 色分け [R Q1-a] |
| cost / tokens | turn 内合計 | 同上 |
| duration | turn の壁時計時間 | Jaeger ヘッダ quick stats [R Q1-b] |
| files | 触ったファイル数 + 上位 1〜2 ファイル名（`event_files` 集計） | agsoft のファイル別履歴 [R Q2] |
| 一行要旨 | user_message の冒頭 + 最後の assistant_message の冒頭 | claude-code-log の Smart Summaries（ただし AI 生成は Phase 2 送り、まずは機械抽出） |

session ヘッダ（sessbar）には「最も高い turn」「エラーのある turn」への**ジャンプチップ**を追加
（P3 の (c) ヘッダ集計。G9 と接続）。

## 5. 枠組み C — ファイル軸の探索（diff 関連付けの拡張)

現状の step⇄hunk 双方向リンクは維持した上で、**ファイルを第 3 の探索軸**にする
（[R] Q2 で coding-agent 文脈の existence proof はファイル単位: agsoft / d-kimuson）。

1. **turn 展開時に「touched files」サブ行**: turn の下に step 列と並べて、その turn が触った
   ファイル一覧（status 色 + 追加/削除行数）。クリックで diff タブの該当ファイルへ
   （キーは既存 `changed_files` + `attributions`。新規 join 1 本）。
2. **ファイル → step 履歴**: diff タブのファイルヘッダに「このファイルを触った step 一覧
   （turn 番号付き）」を出す。既存 `getLinkedEventsForFile`（db.ts:313-334）がほぼそのまま使える。
3. 行粒度アンカー（GitHub PR の `path+line+side` [R Q2]）は**今はやらない**。hunk 粒度の attribution
   で S1-2 は成立しており、行粒度が要るのは PR レビュー文脈（G1 / Phase 2 以降）になってから。

## 6. G9 への接続（このノートでは界面だけ）

「異常に高いセッション」の検知は別ノートで設計するが、**表示面は本枠組みに乗る**:
- 一覧行 / Overview に anomaly chip（P3 の (a)）
- session ヘッダの「最も高い turn」ジャンプ（§4）

baseline の選択肢（project 別中央値 × k / percentile / 絶対閾値）は G9 設計時にユーザー判断。
本枠組みの依存は「session/turn 単位の cost・error 集計が query で取れること」のみで、§4 で満たされる。

## 7. 決定（2026-06-10 ユーザーレビュー。判断材料 = `mockups/g8/` の画像シミュレーション）

1. **採用 = A-1（turn-first）のみ**。共通基盤 3 点（turn 全折りたたみ初期視界 / step 行の時間バー併置 /
   フィルタ 2 モード化）+ §4 turn rollup を実装する。
2. **A-2（アウトライン左ペイン）/ A-3（Tree/Timeline トグル）は不採用**。
   ユーザー評: 画像で見ても何をやりたい画面か分からない。增築の再検討は A-1 を使ってみてから。
3. **ファイル軸（§5）は「常時サブ行」をやめ、軽い導線に変更**: turn 行（または展開時のヘッダ）から
   click で「この turn が触ったファイル / diff」へ飛べるオプション的 affordance とする。
   hover プレビューは任意。§5-2（diff 側のファイル → step 履歴）は維持。
4. **この領域は「作りながら詰める」**（ユーザー認識）。構造（初期視界・rollup の有無・遷移）は
   E2E で機械検証できるが、**見た目の細部は goal loop に向かない**（`skills/lathe-loop` の「goal loop に向かないタスク」例に該当）。
   実装の進め方はこの性質に合わせて分ける。

### 残る未決

- turn rollup の項目セットの最終形（§4 の表から取捨。まず全部入れて削る方向か）
- 実装の進め方の分割: 機械検証可能な骨格（task 化 → loop）と、対話的に磨く細部（dev server + 人間レビュー）の切り分け
- SessionViewer.tsx の分割（1400 行超）を骨格実装と同時にやるか

## 8. 出口

決定 1〜4 を実装 task（tasks/10 以降）へ分割 → 骨格は goal loop、細部は対話的に磨く。
本ノートは task 化後、決定内容を ADR 化（または ROADMAP の Phase 1.5 として追記）して参照頻度を下げる。
