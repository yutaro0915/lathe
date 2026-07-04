---
id: TASK-24
title: 'hardening(intake): catch-up sweep + merge の checks 待ち厳密化'
status: Done
assignee: []
created_date: '2026-07-04 18:15'
updated_date: '2026-07-04 20:06'
labels: []
dependencies: []
priority: medium
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 申請（PdM 指示 2026-07-05・intake live-fire で観測した注意点の機械化）

intake Action（.github/workflows/intake.yml）の堅牢化 2 点:

1. **catch-up sweep**: GitHub の concurrency queue は待機 1 本しか保持せず、バースト到着（3 issue 同時等）で中間の run が cancelled になり登記漏れする（2026-07-05、#77 で実発生 → label 手動付け直しで回復）。`schedule`（例: 1 時間毎）+ `workflow_dispatch` トリガを追加し、**open かつ task-request label 付きの issue を全部処理する sweep** を実装する（lathe ingest と同じ push 主 + pull 補の型。既存の労働単位ごとの直列化・衝突検査はそのまま効く）。
2. **merge の checks 待ち厳密化**: 現行は「即 merge → 失敗時のみ checks 待ち」で、checks が未報告のまま merge され得る。checks が存在する場合は完了を待ってから merge する（backlog-only diff では実害が薄いが、ゲート意味論を正しく保つ）。

受け入れ: バースト 3 件投函 → sweep 込みで 3 件とも登記されること／checks 報告後にのみ merge されること。

---
intake: issue #88 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->
