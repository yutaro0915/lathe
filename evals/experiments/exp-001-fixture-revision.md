---
id: exp-001-fixture-revision
revision: "meta/exp-fixture の pass_to_task・origin 文言を簡潔化（v1 → v2）。機能変更なし"
task_set: []  # fixture rubric の gate 動作を直接確認する（task 集合はなし）
predicted_diff:
  S: 変化なし（cmd check の内容 "echo '0' → eq:0" は変更しないため blocker 検出率に影響しない）
  C: 変化なし（checks 定義の追加・削除なし。網羅対象が変わらない）
  Y: 変化なし（文言のみの改訂。gate の PASS/RED 判定ロジックに変更なし）
results:
  baseline:
    outcome: PASS
    note: "node rubrics/run.mjs meta/exp-fixture → exit 0（fixture-always-pass が echo '0' → eq:0 で GREEN）"
  candidate:
    outcome: PASS
    note: "candidate rubric（v2: pass_to_task 文言を簡潔化）を適用しても同一 check が GREEN。機能変更なし"
verdict: ADOPT
landing_ref: "#271"  # exp-fixture rubric は本 PR と同一スライスで landing
---

# experiment: exp-001-fixture-revision — fixture rubric 文言簡潔化（v1 → v2）

## 改訂の背景

`rubrics/meta/exp-fixture/rubric.json` の `pass_to_task` と `origin` フィールドが
冗長な説明文になっていた。機能（cmd check: `echo '0'`・`expect: eq:0`）は変えず、
文言を簡潔化して rubric の可読性を上げる改訂（v1 → v2）。

本実験は「実験 loop の一巡が回ること」を検証する fixture 実験でもある（issue #129 検証 AC）。

## 予想の根拠

- **S**: cmd check の条件（`echo '0'` → `eq:0`）は v1/v2 で同一のため、blocker 判定の挙動が変わらない
- **C**: checks 配列の要素数・id ともに変化なし。v1/v2 で同じ gate 対象を網羅する
- **Y**: 文言のみ変更のため、gate の PASS/RED 出力に差はない

## 実行ログ

- baseline（v1）: `node rubrics/run.mjs meta/exp-fixture` → exit 0（GREEN）
- candidate（v2）: rubric.json を v2 内容に差し替えて同コマンドを実行 → exit 0（GREEN）

## 採否判断

全 S / C / Y 予想（いずれも「変化なし」）が観測（baseline PASS / candidate PASS）と一致。
`verdict: ADOPT`。改訂 rubric（v2）は本スライスで landing。
