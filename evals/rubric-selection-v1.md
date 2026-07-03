---
id: rubric-selection-v1
role: development
frontier: 前線D
S: rubric.json の scope が「意味上の適用範囲」と「--changed 発火条件」を兼ね、依存経由の波及（packages/domain 変更 → apps/web の利用側）を拾えず、preflight --full（全量実行）が過小発火を補償している
C: 選定層（影響集合 = 変更集合 ∪ 依存グラフの逆依存閉包 ∪ 宣言エッジ）の導入後、既知の変更集合（golden）・依存波及ケース（packages→apps）・全量 gate との比較を実行する
Y: 既知の変更集合で期待 rubric 集合が選ばれ、packages→apps の取りこぼしが旧規則との差分として検出され、発火した rubric の発火規則と発火しなかった rubric の未実施（not-run）が選定 receipt で全て説明される
checks:
  - meta/selection-golden
inline_criteria:
  - golden test（既知の変更集合 → 期待 rubric 集合）が全 pass すること
  - packages/domain のみの変更で、apps/web scope の rubric が依存閉包経由で発火すること（旧規則では発火しない＝差分が golden で固定される）
  - 選定 receipt に「発火した rubric とその規則（direct-scope / dep-closure / declared-edge / invariant / 明示指定）」と「発火しなかった rubric の not-run 一覧」が漏れなく出ること
  - 新選定の発火集合が旧規則（scope ∩ 変更集合）の上位集合であること（gate が緩む方向の変化ゼロ）
trials: { n: 1, aggregate: all-pass }
---

# eval: rubric-selection-v1 — 変更集合から正しい rubric 集合を選定し、選ばなかったものを説明できるか

- 前線 D（発火の選定層）の Development eval。handoff §4 D 行の S/C/Y 化。**D の ADR はこれを受け入れ条件として引用する**
- 負荷の実体: golden test（合成グラフ＋実グラフの波及ケース）と、旧規則との差分比較。着地時（017de74）に checks へ `meta/selection-golden` を追加＝負荷は gate で毎 run 実行される

## 負荷の実行記録（2026-07-03・通過）

- inline_criteria の実測（main 上で監査役が再検証）:
  1. golden 全 pass ✓（合成 6 ケース: direct-scope / 2 段 dep-closure / declared-edge / invariant / 上位集合性 / 明示指定 ＋ 実グラフ波及 assert）
  2. `packages/domain/src/index.ts` のみの変更で `meta/typecheck` ほか 15 rubric が dep-closure 発火（fired=26 / not-run=19。旧規則では apps/web scope は全て不発火）✓
  3. receipt に発火規則（dep-closure は経路つき。例: `packages/domain/src/index.ts→apps/web/scripts/analyst-engine/analysis.ts`）と not-run 全列挙 ✓（`--receipt` の JSON 出力も確認）
  4. 上位集合性は direct-scope 先行判定で構造保証＋golden で固定 ✓
- 実装は Agent(isolation:worktree) 委譲・監査役レビュー着地（ADR 0021 status 参照）。graph 構築省略パス（apps/web/packages 非接触）は 0.03s＝Stop hook の即時性維持
- 理論の正本: theory §適用の選定——「発火 = invariant ∨（適用範囲 ∩ 影響集合 ≠ ∅）∨ eval/task の名指し」「選定は inner loop の経済装置であって、正しさの最終保証ではない（全量実行の関門を最終保証として維持）」「走らせなかった判定は silent skip せず未実施と明示する」
