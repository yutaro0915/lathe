---
id: TASK-21
title: 'fix(driver): 空洞完走の機械拒否 + resume の backend 継承 + escalation filename bug'
status: To Do
assignee: []
created_date: '2026-07-04 18:06'
labels: []
dependencies: []
priority: medium
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## priority
p1-high

## 申請（ADR 0027 intake・PdM 承認済み: 2026-07-05 会話で復旧手順として承認）

2 セッションで計 2 回観測された**空洞完走**の機械拒否（ADR 0028 governance tripwire と関心が重なる可能性あり — intake で照合されたい）:

- (a) IMPLEMENT が**新規 commit ゼロ**で IMPL_DONE を返したら invalid として差し戻す（「変更不要」が正なら NO_CHANGE 等の明示 verdict を新設して区別）。観測: 2026-07-05 task-16 run で 4 秒 IMPL_DONE、並行セッション task-13 run でも同型（ADR 0026 追記に記録）
- (b) REVIEW が直前 REVIEW と**同一 head_sha に数秒で PASS** を返す経路の抑止（同一 sha への再 REVIEW は差分ゼロ検査を先行）
- (c) `--resume` が backend 指定を忘れると default=codex に落ちる（codex 解約済み）。manifest に stage ごとの backend が記録済みなので **resume は直近 backend を継承**する
- (d) resume 時の escalation ファイル名が `issue-[object Object].escalation.md` になる filename bug

出自: 旧 TASK-21 → ADR 0027 受付へ再登記。

---
intake: issue #78 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->
