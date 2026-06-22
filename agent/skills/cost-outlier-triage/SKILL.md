---
name: cost-outlier-triage
description: Triage high-cost lathe sessions. Use when the user asks about expensive sessions, cost spikes, cost outliers, or "where the money went". Finds the top sessions by cost, inspects the worst one, and explains what drove the cost.
---

# Cost outlier triage

ユーザーが高コストセッション・コスト急増・コスト外れ値について尋ねたら、この手順で調べる。

1. `list_sessions` を呼び、`cost_usd` 上位のセッションを特定する。
2. 最上位の外れ値について `get_session_bundle` を呼び、中身を確認する（ターン数・使用モデル・エラー・並列サブエージェントの有無）。
3. コストの主因を説明する（長いトランスクリプト / 高価なモデル / リトライ・エラー / 並列サブエージェント）。
4. 中央値と比較し、外れ値がどれだけ極端かを示す。
5. `次の一手:` として、最も有用な次の調査を 1 つ挙げる。

注意: `list_sessions` は既定で先頭 50 件のページを返す。母集団全体の最大値を断定する前に、ページの範囲を明示する（例「取得した 50 件のうち最大」）。
