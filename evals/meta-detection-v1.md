---
id: meta-detection-v1
role: development
frontier: meta-loop
S: meta-audit は職人芸——scope 選定が run ごとにモデル任せで、分類判断は記録されず、run 自体に manifest が無く透明性ゼロ（同型の judge 誤検出を 2 回踏んだ #31/#60 が実害）
C: run-health プロファイルで meta-loop を実 runs データ（2026-07-02〜03 の 43 run。#48 regression の 10 連続 escalation・judge 誤検出 2 件・headless 切断 2 件・SIGPIPE 誤ラベル 1 件が既知問題として実在する）に対して実行する
Y: 既知問題群を検出して theory §結果分類の正しい行に類別し、根拠座標・確信度・判断記録つきの finding として出力し、run 全体が manifest（loop_kind=meta）で事後説明できる
checks: []
inline_criteria:
  - 既知問題 5 系統（プロンプト契約 regression / judge 誤検出 / headless 切断 / 機構の誤ラベル / 環境故障）のうち 4 系統以上を finding として検出すること
  - 各 finding の §結果分類の行と変更対象（code/skill/rubric/verifier/eval/harness/前線/体制/価値判断）が、当時の実際の裁定（issue コメント・ADR に記録済み）と一致すること
  - 全 finding に判断記録（なぜその行・その対象と分類したか）と根拠座標（run_key+stage または session_id+seq）が付くこと
  - run が read-only であること（repo 追跡ファイル・DB・gh に書き込みゼロ。成果物は .lathe/meta/ の report のみ）
  - manifest（.lathe/runs/meta-*.json）が生成され、stage・verdict・cost が記録されること
trials: { n: 1, aggregate: all-pass }
---

# eval: meta-detection-v1 — meta-loop は既知の問題を接地データから検出・正しく類別・記録できるか

- outer loop family（[design/outer-loop-family.md](../design/outer-loop-family.md)）の meta-loop に対する Development eval。**meta-loop の ADR はこれを受け入れ条件として引用する**
- 負荷の設計が特殊: **ground truth は合成でなく実履歴**。2026-07-02〜03 の runs には修正済みの既知問題が実在し、当時の分類・裁定が issue コメント・ADR・playbook に記録されている。meta-loop が同じ結論に独立到達できるかを測る（合成 fixture より安く・現実的で・答え合わせが厳密）
- 検出率の閾値（5 系統中 4）は「全検出」を要求しない意図的な緩和——SCOPE の絞り（全バッテリー禁止）と両立させるため。未検出 1 系統は「なぜ見えなかったか」を報告に含めること（それ自体が SCOPE/プロファイル改善の入力）
