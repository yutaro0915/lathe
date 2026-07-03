---
id: rubric-schema-v1
role: development
frontier: 前線1
S: rubric 41 個が v2 形式（漸進移行中）で存在し、meta/rubric-schema が gate で常時実行されている
C: 任意の rubric.json（正常 v2 / 意図的に必須要素を欠いたケース）を rubrics/_schema.mjs に与える
Y: 正常 v2 が違反 0 で通過し、欠落ケースが VIOLATION として検出される（silent failure しない）
checks:
  - meta/rubric-schema
inline_criteria: []
trials: { n: 1, aggregate: all-pass }
---

# eval: rubric-schema-v1 — rubric の形式必須要素を機械強制できるか

- 移設元: [ADR 0011](../adr/0011-rubric-schema-v2.md) 「本 ADR 自体の Development eval（合格条件）」節（前線1 の合格条件を evals/ 第 1 号として一級化。ADR 0018 前線 A）
- 負テストの実体: `rubrics/_schema.test.mjs`（正常 v2 素通り＋ 7 欠陥パターン検出）
- 運用: 役割変化（development → assurance）でもファイルと id は動かさない。assurance 移行時は checks の版を pin する（theory §Development → Assurance）
