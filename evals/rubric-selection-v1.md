---
id: rubric-selection-v1
role: development
frontier: 前線D
S: rubric.json の scope が「意味上の適用範囲」と「--changed 発火条件」を兼ね、依存経由の波及（packages/domain 変更 → apps/web の利用側）を拾えず、preflight --full（全量実行）が過小発火を補償している
C: 選定層（影響集合 = 変更集合 ∪ 依存グラフの逆依存閉包 ∪ 宣言エッジ）の導入後、既知の変更集合（golden）・依存波及ケース（packages→apps）・全量 gate との比較を実行する
Y: 既知の変更集合で期待 rubric 集合が選ばれ、packages→apps の取りこぼしが旧規則との差分として検出され、発火した rubric の発火規則と発火しなかった rubric の未実施（not-run）が選定 receipt で全て説明される
checks: []
inline_criteria:
  - golden test（既知の変更集合 → 期待 rubric 集合）が全 pass すること
  - packages/domain のみの変更で、apps/web scope の rubric が依存閉包経由で発火すること（旧規則では発火しない＝差分が golden で固定される）
  - 選定 receipt に「発火した rubric とその規則（direct-scope / dep-closure / declared-edge / invariant / 明示指定）」と「発火しなかった rubric の not-run 一覧」が漏れなく出ること
  - 新選定の発火集合が旧規則（scope ∩ 変更集合）の上位集合であること（gate が緩む方向の変化ゼロ）
trials: { n: 1, aggregate: all-pass }
---

# eval: rubric-selection-v1 — 変更集合から正しい rubric 集合を選定し、選ばなかったものを説明できるか

- 前線 D（発火の選定層）の Development eval。handoff §4 D 行の S/C/Y 化。**D の ADR はこれを受け入れ条件として引用する**
- 負荷の実体: golden test（合成グラフ＋実グラフの波及ケース）と、旧規則との差分比較。checks が空なのは D 未実装のため（着地時に選定 golden の gate rubric を checks へ追加して記録する）
- 理論の正本: theory §適用の選定——「発火 = invariant ∨（適用範囲 ∩ 影響集合 ≠ ∅）∨ eval/task の名指し」「選定は inner loop の経済装置であって、正しさの最終保証ではない（全量実行の関門を最終保証として維持）」「走らせなかった判定は silent skip せず未実施と明示する」
