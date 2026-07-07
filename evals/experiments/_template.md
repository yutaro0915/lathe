---
id: <実験ID（ファイル名と一致させる）>
revision:                    # 改訂対象（1 件）
  target: <rubrics/... または skills/... のパス>
  diff_ref: <PR 番号・branch 名・commit ref>
task_set: []  # gate を実行する対象 task の issue 番号リスト（例: [100, 101]）
predicted_diff:
  S: <重篤度（Severity）への予想影響（例: "変化なし" / "blocker 検出率が上がる" 等）>
  C: <網羅率（Coverage）への予想影響（例: "変化なし" / "false negative が減る" 等）>
  Y:             # 観測可能な予想結果のリスト（1 件以上、改訂前に固定）
    - <予想結果 1（例: "baseline PASS かつ candidate PASS → gate 挙動に変化なし"）>
results:         # task ごとに 1 行記入（gate 実行後に記入）
  - task: <issue番号>
    baseline: <PASS|RED>
    candidate: <PASS|RED>
    matched_prediction: <true|false>
# ※ task_set: [] の fixture 実験は baseline/candidate 直記も可:
# results:
#   baseline: {outcome: PASS, note: "..."}
#   candidate: {outcome: PASS, note: "..."}
verdict: ~  # adopt | reject | redesign（照合後に記入。全予想 matched_prediction=true → adopt 候補）
landing_ref: ~  # 採用時: 採用 PR 番号（例: "#123"）。不採用時は空欄
---

# experiment: <実験ID> — <改訂内容の一行説明>

## 改訂の背景

<!-- 何を解決しようとしているか -->

## 予想の根拠

- **S**: <!-- 重篤度予想の根拠 -->
- **C**: <!-- 網羅率予想の根拠 -->
- **Y**: <!-- 効果・歩留まり予想の根拠 -->

## 実行ログ

<!-- baseline / candidate 実行時の実測メモ -->

## 採否判断

<!-- verdict の根拠・差し戻す場合は再設計の方向性 -->
