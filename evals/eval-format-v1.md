---
id: eval-format-v1
role: development
frontier: 前線B
S: evals/ は前線 A で生まれたが、形式は第 1 号の慣習でしかなく機械検証が無い
C: 任意の前線の受け入れ条件を eval 形式（S/C/Y・checks・inline_criteria・trials）で記述し、_eval-schema と bindings-lint に与える
Y: 適合 eval が違反 0 で素通りし、形式違反（必須要素欠落・不正 enum・判定基準ゼロ・id とファイル名の不一致）が VIOLATION として検出され、checks の実在が判定される
checks:
  - meta/eval-schema
  - meta/bindings
inline_criteria: []
trials: { n: 1, aggregate: all-pass }
---

# eval: eval-format-v1 — 前線の受け入れ条件を eval 形式で書き、機械検証できるか

- 前線 B（[ADR 0019](../adr/0019-front-b-eval-first-class.md)）自身の Development eval（dogfooding: B 以降の前線は受け入れ条件を eval 形式そのもので記述する、handoff §4）
- 負荷の実体: 壊れた eval（in-memory fixture）を検証器に食わせる（`rubrics/_eval-schema.test.mjs`、gate で毎 run 実行）。checks の実在判定は前線 A の `meta/bindings` が担う
