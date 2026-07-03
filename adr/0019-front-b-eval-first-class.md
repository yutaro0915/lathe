# ADR 0019: EDD 前線 B — eval の一級化（形式の確定・機械検証・次前線の eval 記述）

- status: accepted（2026-07-03 ユーザー承認。承認時の確認事項: eval の本質＝系にぶつける**負荷**であること→ §決定 5 の条項として明文化）
- date: 2026-07-03
- 入口文書: `/Users/cherie/LLMWiki/projects/edd-theory/handoff/lathe-rubric-system-decomposition.md`（§2 導入表・§3 evals 形式・§4 前線 B。確定済み決定は再議論しない）
- 理論の正本: edd-theory `theory.md` §中核オブジェクト（eval＝実行可能な問い→受容主張・trials/aggregate は主張の一部）・§開発前線テンプレート（S/C/Y・issue/task/eval の区別、LEDGER-0030/0031）
- 関連: [ADR 0018](./0018-front-a-bindings.md)（前線 A。evals/ と checks 実在検証はここで導入済み）
- 実装規律: 監査役単独 writer・判定挙動の変更なし（gate の追加のみ）・inner loop に出さない

## 対象（前線 B = eval 形式の確定と機械検証、1 前線 1 関心）

前線 A で evals/ は生まれたが、形式は第 1 号の慣習でしかない。B は**形式を確定して機械検証**し、**次の実前線（C）の Development eval をこの形式で記述**する（＝eval を「散文の受け入れ条件」から「実行可能な問いの一級オブジェクト」へ）。

## 決定

### 1. eval 形式 v1（frontmatter 必須要素）

`evals/<id>.md` の frontmatter に以下を必須とする:

| フィールド | 制約 | 根拠 |
|---|---|---|
| `id` | ファイル名（拡張子抜き）と一致・問いの内容ベース | 役割変化でファイルと id を動かさない（handoff §2 確定） |
| `role` | `development` \| `assurance` | theory §中核オブジェクト・§Development → Assurance |
| `frontier` | 空でない文字列（メタデータ） | 前線はディレクトリで切らない（handoff §2 確定） |
| `S` / `C` / `Y` | 各・空でない文字列 | 「状態 S から条件 C の下で観測可能な結果 Y を成立させられるか」（theory テンプレート） |
| `checks` | 実在する rubric id のリスト（空可） | 他集約への参照＝id 結合（版 pin は assurance 移行時） |
| `inline_criteria` | リスト（空可）。**checks と両方空は不可** | タスク固有の受容条件のみ。再利用が生じたら rubric へ昇格（theory §関係の管理）。判定基準ゼロの問いは受容主張になれない |
| `trials` | `{ n: 1 以上の整数, aggregate: all-pass }` | 試行・集約規則は受容主張の一部（theory §中核オブジェクト）。enum は v1 で `all-pass` のみ＝実需で拡張 |

**先送り（YAGNI）**: assurance role の checks 版 pin 書式は、最初の assurance 移行時にその ADR で定義する（未使用の書式を先に固定しない）。

### 2. 機械検証（`meta/eval-schema`、0011 の自己適用パターンの再利用）

- `rubrics/_eval-schema.mjs`: 全 `evals/*.md` を走査し違反を `VIOLATION` 行で出力（CLI）＋ `validateEval` を export（負テスト用）。**frontmatter 構文の解釈は前線 A の `rubrics/bindings/lint.mjs` の parse 関数を import**（二重実装しない）。
- `rubrics/_eval-schema.test.mjs`: in-memory 負テスト（各必須要素の欠落・不正 enum・checks/inline_criteria 両方空・id とファイル名の不一致等を検出。正常 eval は素通り）。
- `rubrics/meta/eval-schema/rubric.json`（v2）: check 1 = `_eval-schema.mjs | grep -c VIOLATION` eq:0、check 2 = 負テストの自己検査。scope は `evals`＋検証器自身。
- 役割分担: **checks が指す rubric の実在**＝前線 A の `meta/bindings`（変更なし）／**eval 自体の構造**＝本 rubric。重複させない。

### 3. eval を 2 本記述（dogfooding）

1. **`evals/eval-format-v1.md`** — 前線 B 自身の Development eval（handoff §4「B 以降は eval ファイル形式そのもので記述」の実行）。S=形式が第 1 号の慣習のみ／C=任意の前線の受け入れ条件を form どおり記述し検証器に与える／Y=適合 eval が素通りし・形式違反が VIOLATION として検出され・checks の実在が判定される。checks: `meta/eval-schema`・`meta/bindings`。
2. **`evals/verifier-evidence-sharing-v1.md`** — **次の実前線 C の Development eval**（handoff §4 C 行の要旨を S/C/Y 化）: S=判定実装が rubric.json に埋め込まれ高価な実行が check 間で重複／C=named verifier（初期 8）導入後、同一変更集合で導入前後を比較／Y=同一 verifier が 1 run に 1 回だけ実行され、複数 rubric が同じ evidence から従来と**同一の判定**を出す。C は未実装のため checks: []・受け入れ条件は inline_criteria（実行回数 1/run・前後判定一致・挙動不変）。**前線 C の ADR はこの eval を受け入れ条件として引用する**。

既存の第 1 号（`rubric-schema-v1.md`）は新形式に適合していることを検証で確認する（必要な微修正は形式追随のみ）。

### 4. 条項: eval は負荷の宣言であって記録ではない（2026-07-03 ユーザー確認）

eval は系にぶつける負荷（theory §開発前線: 挑戦の装置。負荷試験は条件 C を厳しくする一手法にすぎない＝Development eval は全て負荷）。ファイルは負荷そのものではなく**負荷の宣言**であり、形式を固定する目的は負荷の再現可能性と通過時の受容主張の精密さだけにある。従って: **実行の裏付け（checks が gate で回る、または当該前線がその負荷を実行する計画）を持たない eval を書いてはならない——実行されない eval は issue に退化する**（issue＝過去向き・実行できない記録、theory LEDGER-0030/0031）。構造検証（本 ADR の機械検査）はこの本質を守れないため、運用規律として明文化し、監査役レビューと meta-audit の観点に置く。

### 5. 挙動不変の担保

run.mjs 本体・既存 rubric の判定は不変。`meta/eval-schema` は gate の追加（0011/0018 と同型）で、導入 commit 内で全 eval の適合を確認してから有効化＝初期 GREEN。

## 受け入れ条件

`evals/eval-format-v1.md` そのもの（本 ADR 着地時に GREEN であること）:
1. 3 本の eval（第 1〜3 号）が形式検証を素通りする
2. 壊した in-memory fixture（必須要素欠落・不正 role/aggregate・checks/inline_criteria 両方空・id 不一致）が検出される
3. checks の実在判定が前線 A の lint で効いている（`meta/bindings` GREEN）

## 却下した代替

- **eval 検証を bindings lint に同居**: 前線 A の rubric（結合の関心）と B の rubric（構造の関心）が混ざり、版と責務が曖昧になる → 検証器は分離・parse 関数だけ共有。
- **JSON/YAML 専用ファイル化（.md をやめる）**: eval は問いの散文（背景・移設元）を伴う人間可読物。frontmatter＋本文の現形を維持。
- **aggregate の enum を先に拡充**（majority 等）: 実需なし。all-pass のみで開始し、非決定的 verifier の扱いは前線 C/2 の実需で拡張。
- **eval 第 2 号を前線2（run validity）の eval にする**: 前線2 は独立進行で開始未確定。A→B→C→D の順序上、次の実前線＝C を記述する（前線2 の eval はその開始時に）。

## スコープ外

- eval 実行 runner（trials を機械実行する装置）— 実需が生じた前線で。B は形式と検証まで
- assurance 移行の版 pin 書式（最初の移行時）／前線 C の実装（ADR 0020 予定）
- 理論への指摘が生じた場合は ledger.md へ還流（lathe 側で理論を直さない）

## 一次情報

- handoff: `/Users/cherie/LLMWiki/projects/edd-theory/handoff/lathe-rubric-system-decomposition.md` §3・§4
- theory: `/Users/cherie/LLMWiki/projects/edd-theory/theory.md` §中核オブジェクト・§開発前線テンプレート・§関係の管理
