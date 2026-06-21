# Lathe DS — mockups（承認済み worked example の現物）

`design/ds/decisions.md` の決定（規約/意味/実現）に対応する**承認済みの画面・部品**を、
版管理された standalone HTML として保存する場所。

**なぜ必要か**: decisions.md の prose（規約/意味/実現）だけでは見た目を再現できない
（実例: 「単一枠 composer」を言葉から再現するのに 8 回描き直した）。確定形をここに固定し、
誰でも再オープン・再現できるようにする。

## 中身

- [`chat.html`](./chat.html) — Chat 機能の確定形（D22–D26）。
  - §1 Composer 単体（単一枠：stacked context ＋ Add context ＋ 入力欄、D26）
  - §2 画面全体 ＋ context panel B（右 dock・永続、D22/D23/D25）
  - §3 全面 chat A（Rail destination・thread 一覧＋会話、D22/D24）
- [`pr.html`](./pr.html) — PR detail の確定形（D28–D29）。過程（session⇄PR attribution、sha/branch strength 区別）＋ Changed files（inline 展開で簡易コード確認）＋ Reviews(compact)。深い diff/review は GitHub。eval/rubric 評価は feature 未存在のため未掲載（D30 ⏳）。
- [`overview.html`](./overview.html) — Overview の確定形（D31）。attention funnel「次にどこを掘るか」（cost outliers G9 / most errors / pending findings の 3 ランク列）＋ Trends（cost by runner / over time / findings by kind）。色は clean red を問題シグナルにのみ配給。**データ実在性（2026-06-21 dev DB 照合）**: cost/error/runner/time は即表示可、findings 系は nascent（枠のみ）。stat・個別行は illustrative、実運用整備は deploy 時。
- [`stats.html`](./stats.html) — SessionViewer の Stats tab（D32）。session 単位の定量プロファイル（per-turn cost / event composition / file churn / subagent runs）= Overview の chart 語彙の session scale 版。
- [`minor-tabs.html`](./minor-tabs.html) — SessionViewer の Skills / Annotations / Raw（D33–D35）。Skills=Tools 同型 comparison-list / Annotations=時系列の導出フラグ＋step jump（kind neutral・error のみ red）/ Raw=ground-truth JSON（3-hue palette・copy）。current-best、実装で調整。
- [`_tokens.css`](./_tokens.css) — mockup プレビュー用トークン（承認時の dark 近似）。

## 開き方

各 `.html` をブラウザで直接開く（Tabler icons / JetBrains Mono は CDN から読み込む）。

## 位置づけ（重要）

- これらは**承認された構造・部品の合成を忠実に保つ**もの。色は承認時の dark プレビュー近似。
- 実 app の**正本トークンは** `apps/web/app/design-system/tokens.css`（light-canonical,
  observability-dense）。chat UI の正式なテーマ対応と、decisions の "実現" が指す
  **🧩 実 component ＋ ➕ rubric 化は実装フェーズ**で行う（lockstep、decisions.md の運用節）。
- つまり現時点の「再現可能」= この mockup を再オープンできること。完全な再現（動く UI＋機械検査）
  は実装で達成する。
