# ADR 0010: rubric schema v2 — 正しさの記録要素を構造化し rubric を自己検証する

- status: accepted（2026-06-23、大枠承認済み。詳細仕様は [design/rubric-schema-v2.md](../design/rubric-schema-v2.md)、実装前にユーザーレビュー）
- date: 2026-06-23
- 関連: EDD v1 作業理論（LLMWiki hub: `wiki/queries/edd-v1-theory-2026-06-21.md`）/ ROADMAP「計画運用 — rolling wave と監査」/ [0005](./0005-harness-artifact-model.md)（harness artifact model）/ `rubrics/run.mjs`
- 位置づけ: **EDD（Eval-Driven Development）を lathe で段階的に実践する第一前線**

## 背景: なぜ今 rubric の形式を標準化するか

lathe は自身の開発を `rubrics/`（コード規範ゲート・`run.mjs`・CI・rolling wave）で律している。これは EDD v1 理論の **Rubric（正しさの実行可能な SSOT。単位は「成果物を拒絶する独立した理由」）** の実装にあたる。だが現状 18 rubric は理論の必須要素を部分的にしか持たない。

理論の「rubric に含めるべき要素」× 現状の対照:

| 必須要素 | 現状の格納先 | 状態 |
|---|---|---|
| 正しさの意味 | `check.value` | ◯（慣習必須・機械強制なし） |
| 適用条件 | `rubric.scope` | ◯ |
| 観測すべき証拠 | `verify.cmd`/`judge.input_cmd` に暗黙 | △ 明示フィールド無し |
| 判定方法 | `verify.cmd` / `verify.judge` | ◯（型タグ無しで暗黙） |
| 合格条件・許容差 | `verify.expect` + `means` 散文 | △ 許容差・免除が散逸 |
| 重大度 severity | なし（全 hard、閾値で代用） | ✕ |
| 合格例・不合格例 | judge.prompt の散文のみ | ✕ |
| 版 version | なし（origin 日付・ratchet は散文） | ✕ |

加えて:

- `means` の自然文に **許容差・免除（grandfather）・可変閾値の履歴（ratchet）が埋もれ**、構造化されていない（例: `file-size` の grandfather、`ds-v1-single` の 1008→80 ratchet 履歴、`boundaries` i2 の deferred 1 件）。
- `run.mjs` はスキーマ検証をせず、`value` 欠落も RED 時に表示するだけで弾かない。

EDD v1 では eval/rubric を「正しさ」、harness（run validity）を「手続きの正しさ」として**直交する 2 軸に分離**する。本 ADR はその第一歩 = **正しさの SSOT（rubric）の形式を理論の必須要素に揃える**ことに限定する。手続きの正しさ（run validity / invalid 三値 / soft gate）は次の前線（別 ADR）。

## 決定

### 1. rubric schema v2 を導入する（記録要素の構造化）

rubric / check / verify の各レベルに記録フィールドを追加する。完全定義は [design/rubric-schema-v2.md](../design/rubric-schema-v2.md)。新規フィールドの要約:

- **rubric レベル**: `schema_version`（v2 識別）/ 明示 `id`（ディレクトリ一致を検証）/ `version`（改訂で上げる）
- **check レベル**: `severity`（blocker/major/minor、**記録のみ**）/ `evidence`（観測すべき証拠の明示・任意）/ `examples`（pass/fail・任意）
- **verify レベル**: `kind`（cmd/judge の型を明示）/ `metric`（count/measure。`eq:0` のカウント系と `le:80` のメトリクス系を区別）/ `tolerance`（許容差の根拠・任意）/ `exemptions`（grandfather・deferred を `{target, reason, until?}` で構造化・任意）

### 2. 判定挙動は不変（記録のみ）

`severity` 等は記録メタデータとして追加し、`meta/rubric-schema` 検証器で必須化する。**`run.mjs` の GREEN/RED 判定ロジックは変えない**。soft/hard gate・pass/fail/invalid 三値化は前線2（run validity）の別 ADR で扱う。

理由: EDD の「1 前線 1 関心」。形式（正しさの SSOT の構造）と手続き（run validity）を同時に変えると、検証範囲が広がり、手続きの誤りと正しさの誤りが同じ変更に混ざる。

### 3. rubric を rubric で検証する（`meta/rubric-schema`、自己適用）

`meta/rubric-schema/rubric.json` を新設し、全 `rubric.json` が v2 必須要素を満たすかを機械判定する。検証ロジックは `rubrics/_schema.mjs`（新規スクリプト）に置き、`meta/rubric-schema` の `verify.cmd` から呼ぶ。**`run.mjs` 本体は touch しない**（gate エンジンの改変でなく gate の追加）。これは EDD の dogfooding = rubric 体制自身を rubric で律する。

### 4. v1/v2 共存、漸進移行

`schema_version` 無し = v1 として従来挙動。新規 rubric は v2 必須。既存 18 rubric は scope 着地ごとに漸進変換（lathe の ratchet 文化）。`meta/rubric-schema` は最初「v2 のものだけ厳格検証」とし、全件 v2 化が進むにつれ「全 rubric が v2」へ天井を締める（ds-v1 と同型の ratchet）。

## EDD v1 理論との対応

| 理論の軸 | 本 ADR（前線1） | 別前線 |
|---|---|---|
| Rubric = 正しさの SSOT | **形式を必須要素へ標準化**（本 ADR） | — |
| harness = 手続きの正しさ（run validity） | 触らない（判定挙動不変） | 前線2（別 ADR） |
| Development eval = 能力差分の問い | 触らない | 前線3 |

本 ADR 自体の Development eval（合格条件）: 任意の `rubric.json` に対し v2 必須要素の充足を `_schema.mjs` が機械判定でき、欠落を弾ける。加えて検証器自体を検証する（既知の正常 v2 rubric が PASS、意図的に要素を欠いた rubric が VIOLATION = silent failure 対策）。

## ROADMAP との関係

本 ADR は `rubrics/` 体制（rolling wave のゲート = **lathe 自身の開発を律する harness**）の形式改善であり、ROADMAP の Phase 機能（特に Phase 4 = プロダクトとして観測対象 agent を採点する rubric/judge）とは**別軸・別レイヤー**。論点 #14（ハーネス意味論の一般化: rubric/eval がプロダクトのハーネス要素か）とも異なる（こちらは lathe の自己開発インフラ）。Phase 体系に割り込まず、開発インフラの改善として独立 branch で進める。

## 却下した代替

- **判定挙動まで含める**（severity で soft/hard、invalid 三値を同時導入）: 前線1と2の統合。1 前線 1 関心に反し、手続きの誤りと正しさの誤りが混ざる。却下（前線2 で扱う）。
- **スキーマ検証を `run.mjs` に直書き**（meta rubric にしない）: rubric 体制の自己適用（dogfooding）の機会を逃し、gate エンジンの改変が no-gate-tampering と緊張する。却下（`_schema.mjs` + `meta/rubric-schema` で gate の追加にする）。
- **一括移行**: lathe の ratchet 文化（漸進）と不整合。18 件一括は大きな単一 PR で `pr-split` rubric と緊張する。漸進を既定（一括はユーザー指定時のみ）。

## スコープ

- 本 ADR = rubric schema v2（記録要素の構造化）+ `_schema.mjs` + `meta/rubric-schema` 検証器 + v1/v2 共存 + 漸進移行。
- スコープ外: run validity / invalid 三値 / soft gate（前線2、別 ADR）/ Development eval の一級概念化（前線3）/ プロダクトの eval/judge（ROADMAP Phase 4）。

## 一次情報（出典）

- EDD v1 作業理論: LLMWiki hub `wiki/queries/edd-v1-theory-2026-06-21.md`（cherie 作業理論、未完成・生きたドキュメント）
- 現 rubric 実装: `rubrics/run.mjs`、`rubrics/*/rubric.json`（18 個）
- rolling wave / ゲート運用: `ROADMAP.md`「計画運用 — rolling wave と監査」
