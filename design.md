# Lathe — Design Brief（Claude Design 引き渡し用）

> このファイルは **Claude Design に design system を作ってもらうための brief**。
> **重要**: 現行 UI（`apps/web/components/*`、スクショ）は「**内容・機能要件の参照**」であって
> **再現対象ではない**。現行 UI は incremental に作った暫定実装であり、ここから design system を
> 逆算しないこと。下記の「要件」と「原則」を満たす design system を**新規に設計**してよい。
> 引き渡す入力: ① 本 brief（機能要件・原則）② スクショ（現行画面 = 内容参照）③ コード（リポジトリ全体）。

## 1. プロダクトは何か

**Lathe = ハーネスエンジニアリング・プラットフォーム**。Claude Code / Codex などの**コーディング
エージェントの実行履歴**を観測し、横断分析して「エージェントの harness（CLAUDE.md / AGENTS.md /
hooks / skills 等）の改善余地」を見つけ、改善を追跡するための基盤。今は単一ユーザーの dogfood 段階。

- 入力: 既存ツールが残した実行履歴（transcript / git 差分 / PR）。
- 出力: 観測ビュー / 改善余地（findings）/ 採否・改善バックログ / コスト・統計。
- 価値: 「自分のエージェントがどこで systematically に無駄を繰り返しているか」を可視化し、
  何を直すべきかを判断し、改善を追跡できる。

## 2. Founding 原則（design system が**必ず**守る非交渉事項）

1. **二重操作性（agent ⇄ human dual-operability）** — このプロダクトの核。
   **agent が使うことは human が使うことと同等以上に重要**。同じ UI を agent も human も使う。
   人間専用 UI を作らない。人間ができる操作はすべて agent もできる（MCP tool が UI をミラー）。
   agent は付属でなく**一級オペレーター**（分析・検知・タスク受領・管理）。chat はどこからでも
   呼べ、agent は「今何をしているか」を確認できる。→ UI は**機械可読な構造**を併せ持つこと
   （意味のある DOM・状態・ラベル。装飾優先で機械可読性を犠牲にしない）。
2. **証拠への接地（evidence-grounded）** — すべての主張・指摘は、根拠（transcript の step・差分・
   コマンド出力）に直接リンクする。主張と証拠が離れない。「無言の切り捨て」をしない（省略は明示）。
3. **高い情報密度（observability tool として）** — 大量のセッション/イベント/数値を一望する道具。
   密度が高く、走査しやすいこと。ただし密度＝雑然ではない。静かで落ち着いた表現。
4. **静かな配色・中立コピー** — 装飾的な色を使わない。色は分類・状態の信号に配給制で使い、
   **error など特権的な状態のみ強い色**。コピーは中立な英語の micro-label（編集的・口語的文言や
   日英混在を避ける）。判定的な数値には必ず根拠/基準を併記する。
5. **ナビゲーションの一貫性** — 全画面は常設のグローバルバー配下。バー/タブ以外の手段でしか
   到達・離脱できない画面を作らない（「今どこか」「どう戻るか」が常に自明）。横断軸（cross-session）
   と単一 session 軸を混ぜない。

## 3. 使い手と Jobs

- **human（harness エンジニア = ユーザー本人）**: 大量のエージェントセッションから、体系的な無駄を
  見つけ、直す価値を判断し、改善を追跡したい。
- **agent**: 同じ画面/データを読み、分析・検知・採否・バックログ操作・改善案起こしを行う（段階導入、
  完全形は後期フェーズ。今は接続余地を残す）。

## 4. 機能要件（surface 別。**現行レイアウトでなく「何を満たすか」**）

グローバルバーの軸: **Sessions / Findings / PR / Overview**（将来 chat レイヤーが全画面に被さる）。

### Sessions（単一 session の観測）
- **IA 決定（2026-06-17 ユーザー）**: セッション一覧は **center panel にリスト表示**する（一覧を見たいとき = 主画面）。
  左は **nav bar のみ**にとどめ、**現行の「左 rail に押し込んだスクロール式一覧」は却下**（面積が過小で走査できない）。
  多くの類似アプリの IA（左 = ナビ、中央 = 一覧/詳細）に倣う。細部（一覧の列・密度・詳細への遷移）は design system 側で詰める。
- セッション一覧（runner/model/コスト/エラー/時刻）から 1 つ選ぶ。
- transcript を **turn 単位**で読む（turn ごとに step/edit/bash/error/cost/token/duration の rollup、
  要旨、エラー turn の強調、step の時間バー）。
- Tools / Git 差分（transcript ⇄ 差分の双方向リンク、step focus）/ Skills / Subagents（子 session）/
  Stats / Raw JSON のタブ。
- 巨大セッションでも軽い（ページング・時系列バケット）。

### Findings（横断軸 = 改善余地）
- 全 session 横断で「failure loop / 未帰属差分 / 過剰コスト / リスク行動」等の finding を提示。
- 各 finding は **深掘り分析**を持つ: 原因仮説 / agent の意図 / 重要性（impact）。
  これらは現象の説明まで（ハーネスの直し方には踏み込まない）。
- 各 finding は**根拠**（該当 session・turn・失敗コマンド・出力）に接地し、そこへジャンプできる。
- **triage → 採否 → バックログ**: pending を 1 クリック + 一言で accept/reject。accept した finding は
  「改善バックログ」（open → addressed/dismissed の状態）に積まれる = 直すべきことの worklist。
- session 内タブにも当該 session 紐付きの findings を出す（横断軸とは別。session スコープ限定）。
- 採否・状態遷移は agent も叩ける同一 API（dual-operability）。

### PR（session ⇄ PR 連携）
- session と GitHub PR の紐付け（commit SHA 主 + branch 補）。
- ※ project 単位で PR を見る視点が必要（現行は単体志向で不足、要改善）。

### Overview（横断集計 → 次に掘る場所への漏斗）
- cost/token 時系列・model 別・where-the-actions-went・biggest sessions。
- **「要注意」**: cost 異常（基準併記）/ エラー多発 session / pending findings を集約した「次に掘る場所」。
- すべてドリルダウンの入口（クリックで該当 session / Findings 軸へ。通常リンク遷移で back 可能）。

## 5. UX 要件（design system が満たすべき横断要件）

- 一覧 → 詳細の master-detail。詳細は深いスクロールの上下往復を強いない（固定ヘッダ + 内側の
  独立スクロール領域に分ける）。sticky 要素が背後と重なって透ける等の不快を作らない。
- 長い出力・差分は**ペイン内スクロール**で吸収（無言切り捨て禁止）。短い内容は短い高さで。
- 状態（採否・backlog 等）は 1 箇所に集約して読みやすく。散らさない。
- レイアウトはオーバーフローを構造的に防ぐ（`minmax(0,…)`・`min-width/height:0` 規律）。
- ジャンプ着地は対象をハイライトし「どこから来て今どこか」を示す。
- 数値は等幅・桁揃え。micro-label は小さい uppercase。

## 6. design system に期待すること（自由にやってよい部分）

- 上記の原則・要件を満たす**トークン（色・タイポ・余白・密度）/ コンポーネント / パターン**を新規に体系化。
- 現行の見た目に縛られない。ただし「観測ツールとしての高密度」「二重操作性」「証拠接地」「静かな配色」は
  動かせない要件。
- ダーク/ライトや密度モードのテーマ余地があると良い。
- 機械可読性（agent が同じ UI を操作できる）を意識した semantic な構造・命名。

## 7. 引き渡し物

- 本 `design.md`（機能要件・原則・非交渉事項）。
- スクショ: 現行画面（Sessions / Findings / PR / Overview）= **内容・要件の参照**（再現対象ではない）。
- コード: リポジトリ全体（Next.js + Postgres、`apps/web/`）。現行実装の構造把握用。
- 補助正本（必要なら参照）: `design/ui-design-language.md`（現行 observability-dense の言語）/
  `design/agent-human-dual-operability.md`（二重操作性）/ `design/phase2-finding-depth-and-backlog.md`
  （findings 深掘り+backlog の要件と却下案）/ `ROADMAP.md`（フェーズと境界）。
  ※ これらも「要件の出所」であって、現行 UI の再現指示ではない。
