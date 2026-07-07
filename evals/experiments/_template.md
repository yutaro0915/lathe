---
id: <実験ID（ファイル名と一致させる）>
revision: <改訂内容の一行説明>
task_set: []  # gate を実行する対象 task の issue 番号リスト（例: [100, 101]）
predicted_diff:
  S: <重篤度（Severity）への予想影響（例: "変化なし" / "blocker 検出率が上がる" 等）>
  C: <網羅率（Coverage）への予想影響（例: "変化なし" / "false negative が減る" 等）>
  Y: <効果・歩留まり（Yield）への予想影響（例: "変化なし" / "採否精度が上がる" 等）>
results:
  baseline:
    outcome: ~  # PASS | RED（gate 実行後に記入）
    note: ~     # 実測の補足
  candidate:
    outcome: ~  # PASS | RED（gate 実行後に記入）
    note: ~     # 実測の補足
verdict: ~  # ADOPT | REJECT | PENDING（照合後に記入）
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
