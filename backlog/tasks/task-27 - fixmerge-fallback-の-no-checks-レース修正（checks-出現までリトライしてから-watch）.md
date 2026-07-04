---
id: TASK-27
title: 'fix(merge): fallback の no-checks レース修正（checks 出現までリトライしてから watch）'
status: Done
assignee: []
created_date: '2026-07-04 19:28'
updated_date: '2026-07-04 19:42'
labels: []
dependencies: []
priority: medium
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## priority
p1-high（label 未作成のため body 記載）

## 申請（intake・原因と解決が明確な機械修正。2026-07-05 TASK-23 #97 で実証）

`scripts/merge.mjs` の auto-merge fallback（TASK-26 追加、merge.mjs:458-483 付近）が PR 作成直後に `gh pr checks <branch> --watch` を実行するため、CI check がまだ登録されていない瞬間に `no checks reported` で非ゼロ終了し、merge.mjs が「CI 失敗」と誤読して die する（TASK-23 は CI が実際は pass だったのに merge 拒否＝false negative）。

## やること
- fallback の checks 待ちを race-safe に: `--watch` の前に checks 出現までポーリング（"no checks reported" の間 sleep してリトライ、上限 ~2 分）。1 つ以上現れてから `--watch`。
- タイムアウト時は明示 die（無限ループ禁止）。`--auto` primary と gate（CI green 後のみ merge）は不変。
- unit 追随（no-checks→出現→green の遷移モック）。

## 受け入れ
- PR 作成直後でも fallback が checks 登録を待ってから watch し CI green で merge（TASK-23 の false negative が再現しない）。

---
intake: issue #98 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->
