# ADR 0038: loop-domain 導入と境界則 — driver を「新サービス」ではなく「ドメインパッケージ」として lathe に統合する

- status: accepted（2026-07-08 PdM 裁定「DDD については承認するから通していい」— 教材 Discussion #284
  ＋対話での詳説〔3 原則・5 難所〕を経て issue #278 の方向性を承認。本 ADR は境界則を文書化する）
- date: 2026-07-08
- 関連: #278（本 ADR の由来 issue・plan 本文）／#141（vision root）／ADR 0031（task 状態の導出）／
  ADR 0036（harness-release loop）／ADR 0009（agent-as-core-module、ports/adapters 先例）／
  `design/architecture.md`（既存の単一 bounded context 宣言）／`design/loop-domain-architecture.md`（本 ADR の設計ドラフト）

## 背景

driver（`scripts/*.mjs`。実測 26 モジュール・6,971 行、issue #278 本文の記載「15 モジュール・
9,168 行」とは差異あり — 教材 `explains/2026-07-08-issue278-loop-domain-design.md` 参照）は lathe
本体（`apps/web`、観測・分析 UI）から独立した実行機構として育ってきた。#141（vision root）が
lathe を「観測ツール」から「統治された開発ループのハーネス」へ再定義する構想の最初の設計子として、
driver を lathe 本体へ統合する前段の**アーキテクチャの骨格**を本 ADR で確定する。

現状の課題:

- driver のロジックは `scripts/*.mjs` に散在し、`apps/web` とは別の依存グラフ・別の依存強制
  （dependency-cruiser は `scripts/` を対象外にしている）で育っている。
- prompt は散文（テンプレート文字列）であり、#189 のような型事故（書式クラッシュ）の温床になっている。
- driver の実行履歴（Run/stage）は `.lathe/runs/*.json` という manifest ファイルが正であり、
  DB（`runs`/`run_stages`）はその再構築可能な二次コピーにすぎない（データ層が二重）。

## 決定

### 1. 別プロセスの API サーバは新設しない

driver を lathe に統合する手段として「新サービス」（別プロセスの API サーバ）は選ばない。
運用対象（デプロイ・障害対応・認証）を増やさない、という `AGENTS.md` の「機構は追加より削除」原則
に従う。代わりに **`packages/loop-domain` というドメインパッケージ＋既存 Postgres** に統合する。
`apps/web`（UI）と executor（`scripts/*.mjs` 系）が同じ `loop-domain` を import し、Postgres が
両者の合流点になる。

### 2. `packages/loop-domain` は I/O ゼロの純ドメイン

- 何も import しない: `node:fs` / `node:child_process` / `pg` / gh CLI 起動経路のいずれも禁止。
- 内容は型・状態機械・prompt 契約（構造化データとして。散文の埋め込み文字列テンプレートではない）・
  見積り規則。
- 既存 `packages/domain`（`@lathe/domain`。観測・分析ドメインの finding/evidence 型）とは**別
  パッケージ**であり、両者を混同しない。名前は `loop-domain` のまま短縮・統合しない。

### 3. クリーンアーキテクチャは「本質だけ」— 三輪、依存は常に外→内

- 最内周 = `packages/loop-domain`（何も import しない）。
- 中間 = ports（`TaskSource` / `RunStore` / `AgentBackend` / `Clock` の interface。実装は持たず
  `packages/loop-domain` 内に型として同居させる — 別パッケージに分割しない）。
- 外側 = アダプタ（gh CLI / Postgres / claude CLI / Next.js UI）。ports を実装する。
- **機械強制**: 既存 `.dependency-cruiser.js` の `pure-core-no-io` ルール（`packages/shared/src/`・
  `packages/domain/src/` に適用済み）の `from.path` 正規表現に `packages/loop-domain/src/` を追加する
  1 条項で足りる（新規ルール新設ではなく既存パターンの拡張）。詳細は `design/loop-domain-architecture.md`
  §4。

### 4. GitHub 依存の扱い（最重要の境界則）

- **`packages/loop-domain` は GitHub 非依存**。domain は `TaskSnapshot`（型）を受け取って処理する
  だけで、取得元（gh CLI か API か）を知らない。GitHub 呼び出しは `TaskSource` port のアダプタ側
  にのみ存在する。
- **task 状態の正は GitHub のまま**（ADR 0031「保存せず導出」を変更しない）。
- **lathe DB が「駆動」context として所有するのは `LoopDefinition`（版つき・ADR 0036 の版固定に
  対応）と run telemetry のみ**。task の open/close・label・plan 本文・裁定を lathe DB に複製する
  テーブルは作らない — **二重台帳の禁止**（ADR 0031 §背景が指摘した「同じ事実を二重記録すること」
  の再発を、driver 統合でも起こさない）。

### 5. context 境界（4 つ、issue #278 本文の確定表を正本として採用）

| context | 所有 | 正 |
|---|---|---|
| 観測 | sessions・events・findings | lathe DB（実装済み） |
| 駆動 | LoopDefinition・Run・stage イベント | lathe DB（新規。既存 `runs`/`run_stages` は現状 manifest ファイルの二次コピーであり、本 ADR はこれを DB 一次化へ移行する） |
| 統治 | plan 契約・検査文言・rubric | repo＋DB（契約のデータ化。範囲は本 ADR では未確定 — 後続の設計課題） |
| task | issue 状態・plan・裁定 | GitHub（導出のみ） |

### 6. データフロー

- orchestrator: gh アダプタ → `TaskSnapshot` → `domain.classify` → dispatch。
- executor: domain が段を決め、claude アダプタ（`AgentBackend`）が実行。`RunStore`（DB）に段イベント
  を追記する——これが `.lathe/runs/*.json` manifest ファイルの**後継**になる。
- UI: DB を読むだけ。**UI からプロセスを直接起動しない** — 意図を DB に書く（Ready への移動・
  `hold` label と同じ「入力は状態を書くだけ」という思想、ADR 0031/0037 と同型）。

### 7. `design/architecture.md` との関係

`design/architecture.md` §1 は「ユビキタス言語は lathe 全体で 1 つ（単一 bounded context）」と
宣言しているが、同書の scope は `apps/web` の観測・分析ドメインであり、driver/loop の実行機構
（GitHub issue を task として扱い、agent を dispatch する側）はそもそも同書の対象に含まれて
いなかった。本 ADR は architecture.md の単一 BC 宣言を**撤回しない** — `loop-domain` は
architecture.md が扱う BC とは別の、並存する context として位置づける。architecture.md 本体の
改訂（モジュール対応表への `loop-domain` 追記等）は本 ADR の scope 外とし、別途文書 task で行う。

## 版計画（ADR 0036 対象版 v1 の定義）

ADR 0036（harness-release loop）は「loop 本体・ゲート・配車・状態面の意味論に触る改修」を対象に、
scope を全スライス事前確定した上で outer が一括実装することを求める。**本 ADR が定義する
loop-domain 移行はまさにこの対象**（executor・orchestrator の実行経路そのものを変える）であり、
実装フェーズは**通常の task loop ではなく harness-release loop で回す**。

対象版 v1 のスライス（`design/loop-domain-architecture.md` §7 の移行順序をそのまま採用）:

| wave | 内容 | 受け入れ条件 |
|---|---|---|
| ① | `loop_definitions` テーブル＋ run ingest の schema 追加 | migration 適用 GREEN・既存 ingest 回帰なし |
| ② | 読み取り専用 Loops UI | `loop_definitions`/`runs` の表示のみ・書き込み経路なし |
| ③ | executor が定義を DB から読む（散文 prompt の追放、#189 型事故の構造的封じ） | 無人一巡 GREEN（ADR 0036 の受け入れ条件形式）・`schema.sql` の manifest 正本コメント更新 |
| ④ | 編集 UI | 意図が DB 経由でのみ実行に反映される（プロセス直起動なし） |

版の完了条件（ADR 0036 §4 のひな形どおり）: 全スライス着地 → 常駐（orchestrator/driver）の再読込
→ 機械検証（無人一巡 GREEN）→ 完了記録を版 issue に残して close。**各 wave の起票・詳細 plan 化は
本 ADR の scope 外**（本 ADR は版の輪郭を定義するのみで、実装 issue は個別に起票する）。

## 却下した代替

- **別プロセスの API サーバ新設**: 運用対象（デプロイ・監視・認証）が増える。「機構は追加より削除」
  に逆行するため却下。
- **lathe DB に task 状態テーブルを新設**: ADR 0031 が廃した二重台帳を driver 統合で再導入すること
  になるため却下。task 状態は GitHub 導出のみを維持する。
- **big-bang 一括移行**（schema・UI・executor・編集 UI を 1 PR で切替）: ADR 0036 の実測根拠
  （#201 を loop 自身に回した際の破綻）が示すとおり、改修対象自身が不完全な状態で走行させると
  改修作業自体が壊れる。4 wave の段階移行を採用する。

## 影響と移行

- 本 ADR 自体はコード変更を伴わない（design/ADR 起草のみ、issue #278 の scope）。
- 各 wave は harness-release loop の一括実装対象として、版 issue（本 ADR を根拠 plan とする）を
  別途起票してから実施する。
- `design/architecture.md` のモジュール対応表・依存図への `loop-domain` 追記は、本 ADR 受理後の
  別文書 task とする（本 ADR の scope 外、§7 参照）。
