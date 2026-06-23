# design: rubric schema v2 詳細仕様

- status: draft（実装前にユーザーレビュー）
- 正本 ADR: [adr/0010-rubric-schema-v2.md](../adr/0010-rubric-schema-v2.md)
- date: 2026-06-23

ADR 0010 の決定を実装可能な仕様に落とす。EDD 前線1 = **正しさの SSOT（rubric）の形式標準化**。判定挙動は不変（記録のみ）。

## 1. スキーマ定義（v2）

`schema_version: "2"` を持つ `rubric.json` を v2 とする。無いものは v1（従来挙動、検証スキップ）。

### rubric レベル

| フィールド | 型 | 必須 | 意味 |
|---|---|---|---|
| `schema_version` | `"2"` | ✓ | v2 識別子 |
| `id` | string | ✓ | ディレクトリ相対パスと一致（`run.mjs` の `id` 導出と突合。ズレ検出） |
| `title` | string | ✓ | 人間可読の題 |
| `version` | string | ✓ | この rubric の版（`"1"` 始まり。閾値・check の改訂で +1。ratchet 系は必須の追跡点） |
| `scope` | string[] | ✓ | `--changed` で覆う発火条件（≥1） |
| `pass_to_task` | string | — | 実装者向け要約 |
| `origin` | string | — | 由来（事故・日付） |
| `checks` | Check[] | ✓ | ≥1 |

### check レベル

| フィールド | 型 | 必須 | 意味 |
|---|---|---|---|
| `id` | string | ✓ | check 識別子（rubric 内一意） |
| `value` | string | ✓ | 正しさの意味＝「これを守ると何が守られ、破ると何が壊れるか」 |
| `severity` | `"blocker"\|"major"\|"minor"` | ✓ | 重大度（**記録のみ**。前線1 では判定に使わない） |
| `verify` | Verify | ✓ | 判定方法 |
| `evidence` | string | — | 観測すべき証拠の明示（例: 「oxlint の max-lines 違反行リスト」） |
| `examples` | `{pass: string[], fail: string[]}` | — | 合格例・不合格例（judge 系は推奨） |

### verify レベル

| フィールド | 型 | 必須 | 意味 |
|---|---|---|---|
| `kind` | `"cmd"\|"judge"` | ✓ | 判定方法の型（暗黙→明示） |
| `cmd` | string | `kind=cmd` で ✓ | shell コマンド |
| `judge` | `{prompt: string, input_cmd: string}` | `kind=judge` で ✓ | agent-judge |
| `expect` | string | ✓ | `exit0\|empty\|eq:N\|le:N\|ge:N\|contains:X` |
| `metric` | `"count"\|"measure"` | ✓ | `expect` の意味づけ（下記） |
| `tolerance` | string | — | 許容差・閾値の根拠（`means` の散文の構造化先） |
| `exemptions` | Exemption[] | — | 免除リスト（`means` の散文の構造化先） |

### Exemption

| フィールド | 型 | 必須 | 意味 |
|---|---|---|---|
| `target` | string | ✓ | 免除対象（パス・規則・違反種別） |
| `reason` | string | ✓ | 免除理由（grandfather / deferred 等） |
| `until` | string | — | 解消予定（slice 名 / date）。無ければ恒久 |

## 2. severity の意味（記録上）

前線1 では judge/集計に使わず**記録のみ**。意味の定義は固定し、前線2（run validity）で判定挙動に接続する。

- `blocker`: 違反は受容不能。merge を止めるべき（現状の hard gate 相当）
- `major`: 重要だが状況により許容余地あり（前線2 で soft gate 化の候補）
- `minor`: 望ましいが必須でない

移行の既定: 現 18 rubric は全て hard なので原則 `blocker`。閾値で許容を表現していたもの（例: `boundaries` i2 の `le:1`）は `major` にできる。確定は移行時の判断（記録なので後から版を上げて修正可能）。

## 3. metric の意味論（count / measure）

同じ `le:N` でも意味が違うのを区別する。

- `count`: verify が **違反の個数**を返す。`expect` は `eq:0`（違反ゼロ）/ `le:N`（N 件まで許容）。例: `file-size` の `grep -c`、`no-generic` の judge `VERDICT:<int>`、`boundaries` i2 の `le:1`（deferred 1 件許容）
- `measure`: verify が **メトリクスの実測値**を返す。`expect` は `le:N` / `ge:N`（閾値）。例: `ds-v1-single` の `wc -l`（行数 ≤80）、`e2e` の件数 `ge:100`

これにより「違反 1 件まで（count）」と「メトリクス ≤1（measure）」が機械的に区別できる。

## 4. 検証器（`_schema.mjs` + `meta/rubric-schema`）

`run.mjs` 本体は **touch しない**（判定挙動完全不変）。スキーマ検証は新規追加物だけで構成する。

### `rubrics/_schema.mjs`（新規スクリプト）

- `rubrics/` 配下の全 `rubric.json` を走査。
- `schema_version` 無し = v1 → スキップ。`"2"` = v2 → 検証。
- v2 の検証項目:
  1. rubric 必須（`id`/`title`/`version`/`scope`(≥1)/`checks`(≥1)）。`id` がディレクトリ相対パスと一致。
  2. 各 check 必須（`id`/`value`/`severity`∈enum/`verify`）。
  3. verify: `kind`∈{cmd,judge}、`kind=cmd`→`cmd` 存在、`kind=judge`→`judge.prompt`+`judge.input_cmd` 存在、`expect` が既知演算子、`metric`∈{count,measure}。
  4. `exemptions` があれば各 `{target, reason}` 必須。
- 出力: 違反 1 件ごとに `VIOLATION <rubric-id> <check-id> <理由>` を 1 行。最終行に件数を出さず、`meta/rubric-schema` 側で `grep -c` する。
- 終了コードは常に 0（出力行で判定。`run.mjs` の cmd 評価方式に合わせる）。

### `rubrics/meta/rubric-schema/rubric.json`（新規 rubric、v2 で自記述）

```jsonc
{
  "schema_version": "2",
  "id": "meta/rubric-schema",
  "title": "rubric は schema v2 の必須要素を満たす（自己適用）",
  "version": "1",
  "scope": ["rubrics"],
  "origin": "EDD 前線1 / ADR 0010 (2026-06-23)",
  "checks": [
    {
      "id": "v2-required-fields",
      "value": "正しさの SSOT である rubric 自身が必須要素(value/severity/verify.kind/expect/metric/version 等)を満たすこと。守ると rubric が理論の必須要素を機械保証し、欠落した曖昧な規範が gate に混入しない。",
      "severity": "blocker",
      "verify": {
        "kind": "cmd",
        "cmd": "node rubrics/_schema.mjs | grep -c '^VIOLATION' || true",
        "expect": "eq:0",
        "metric": "count",
        "tolerance": "v2 rubric の必須要素欠落 = 0。v1(schema_version 無し)は検証対象外(漸進移行)。"
      },
      "evidence": "_schema.mjs が出力する VIOLATION 行(rubric-id / check-id / 欠落理由)",
      "examples": {
        "pass": ["severity と version と verify.kind/metric を全て持つ v2 rubric"],
        "fail": ["severity を欠く v2 rubric", "kind=judge なのに judge.input_cmd が無い", "id がディレクトリと不一致"]
      }
    }
  ]
}
```

注: `scope: ["rubrics"]` なので、rubric を変更する PR でのみ発火する（`--changed` 封じ込め）。

## 5. 移行方針

- **判定**: `schema_version` の有無で v1/v2 を分岐。`run.mjs` は v1/v2 とも従来どおり checks を実行（`kind`/`metric` 等の新フィールドは判定に影響しない＝挙動不変）。
- **新規 rubric**: v2 必須。
- **既存 18 rubric**: scope 着地ごとに漸進変換（ratchet 文化）。一括変換はユーザー指定時のみ（18 件 = 中規模・機械的）。
- **ratchet で締める**: 当初 `meta/rubric-schema` は v2 のものだけ検証。全件 v2 化が進んだら `_schema.mjs` に「v1 残存数」check を足し、天井を 0 へ締める（`ds-v1-single` と同型）。

## 6. 変換例（v1 → v2）

### 例 A: `boundaries` i2（deferred 1 件を exemptions へ）

v1（抜粋）:
```json
{ "id": "i2-package-no-app", "value": "...(I2)...",
  "verify": { "cmd": "pnpm lint:deps 2>&1 | grep -c 'I2-package' || true",
    "expect": "le:1", "means": "depcruise I2 違反 ≤1（verify.ts の postgres 直 import は別 slice へ deferred）" } }
```
v2:
```jsonc
{ "id": "i2-package-no-app", "value": "...(I2)...",
  "severity": "major",                          // 1 件許容＝事実上 soft。前線2 で判定接続
  "verify": {
    "kind": "cmd", "metric": "count",
    "cmd": "pnpm lint:deps 2>&1 | grep -c 'I2-package' || true",
    "expect": "le:1",
    "tolerance": "既知の deferred 1 件まで許容",
    "exemptions": [{ "target": "apps/web/scripts/verify/*.ts の postgres 直 import",
                     "reason": "別 slice へ deferred", "until": "verify 層分離 slice" }] },
  "evidence": "depcruise の I2-package 違反行" }
```

### 例 B: `file-size`（grandfather を exemptions + tolerance へ）

`means` の「既存 god-file は grandfather で許容、新規/悪化した >500 だけ違反」を:
```jsonc
{ "severity": "blocker", "verify": {
    "kind": "cmd", "metric": "count", "cmd": "pnpm lint:ox 2>&1 | grep -c 'max-lines)' || true",
    "expect": "eq:0", "tolerance": "新規/悪化した >500 行ファイルのみ違反",
    "exemptions": [{ "target": "既存 god-file（oxlint baseline 登録済み）",
                     "reason": "grandfather（2000 行級 6 本の段階的解消対象）", "until": "分割完了" }] } }
```

### 例 C: `ds-v1-single`（ratchet 履歴を version + tolerance へ）

`origin` の `1008→988→…→80` 履歴は version の追跡対象にし、`means` の運用規則を tolerance へ:
```jsonc
{ "version": "11",                               // ratchet の段数 = 版（slice ごとに +1）
  "checks": [{ "severity": "blocker", "verify": {
    "kind": "cmd", "metric": "measure", "cmd": "wc -l < apps/web/app/globals.css 2>/dev/null || echo 0",
    "expect": "le:80",
    "tolerance": "現天井 80 行。slice 着地ごとに auditor が締め 0 へ。増やしたら RED" }] }],
  "origin": "r4 で :root 一本化 (2026-06-18)。ratchet 履歴は git log + version で追う" }
```
履歴の長文は `origin` から外し、version と git 履歴で追えるようにする（rubric 本文を肥大させない）。

## 7. Development eval（この前線の合格条件）

1. 任意の `rubric.json` に対し、v2 必須要素の充足を `_schema.mjs` が機械判定でき、欠落を `VIOLATION` 行として出力できる。
2. `meta/rubric-schema` が GREEN（v2 rubric が必須要素を満たす）。
3. **検証器自体の検証**（silent failure 対策、EDD run validity の先取り）: 既知の正常 v2 rubric を流すと PASS、意図的に要素を欠いた fixture rubric を流すと VIOLATION。`_schema.mjs` の負テストとして `rubrics/_schema.test.mjs`（or 既存 verify 群）に組み込む。

## 8. 実装の振り分け（lathe 規律）

- `_schema.mjs` + `meta/rubric-schema/rubric.json` + 負テスト = **gate インフラ。監査役（Claude）が単独 writer**（`run.mjs` 本体は不変なので no-gate-tampering 非抵触＝gate の改変でなく追加）。
- 既存 18 rubric の v2 移行 = rubric 編集 = **監査役（Claude）**。worktree 隔離で main 単独 writer。
- `run.mjs` は touch しない（判定挙動不変が ADR 0010 の核）。
