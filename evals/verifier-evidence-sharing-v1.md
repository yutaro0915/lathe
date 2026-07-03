---
id: verifier-evidence-sharing-v1
role: development
frontier: 前線C
S: 判定実装（cmd / judge prompt）が rubric.json に埋め込まれ、lint:deps 等の高価な実行が check 間で重複し、多対多の判定が書けない
C: named verifier（初期 8 = judge-runner・depcruise・e2e-runner・build・typecheck・unit-tests・storybook・scratch-integration）を導入し、同一の変更集合に対して導入前後の gate 実行を比較する
Y: 同一 verifier が 1 run につき 1 回だけ実行され、複数 rubric が同じ evidence（名前つきチャンネル）から従来と同一の判定を出す
checks: []
inline_criteria:
  - 同一 verifier の実行回数が 1 run につき 1 回であること（実行記録で確認）
  - 導入前後で全 check の GREEN/RED 判定が一致すること（同一変更集合での前後比較）
  - run.mjs の判定挙動（GREEN/RED ロジック・発火）が不変であること
trials: { n: 1, aggregate: all-pass }
---

# eval: verifier-evidence-sharing-v1 — 前線 C の Development eval（未通過前提の問い）

- handoff §4 前線 C 行の S/C/Y 化。**前線 C の ADR はこの eval を受け入れ条件として引用する**（eval が前線を駆動する最初の例）
- checks が空なのは C 未実装のため（既存 rubric を名指せない）。負荷の実行は C 着地時の前後比較＝この eval を系にぶつける行為そのもの
- 確定済みの宣言（handoff §2・§5）: named 化の義務条件＝必要条件（チャンネルを少数の安定名で列挙できる）＋ 実行重複（check 間）/ judge 型 / 重い実行 の OR。安価な grep 約 34 check は inline 温存。judge の呼び出しは要求クラス間接
