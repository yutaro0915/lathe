---
id: TASK-20
title: 'chore(driver): inner-loop の既定 backend を codex→claude へ（codex 解約済み）'
status: Done
assignee: []
created_date: '2026-07-04 18:04'
updated_date: '2026-07-04 18:33'
labels: []
dependencies: []
priority: medium
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## priority
p2-normal

## 申請（ADR 0027 intake・PdM 承認済み: 2026-07-05 会話で起票指示。#80 の priority 不足却下を受けた再起票）

codex は解約済みだが、`scripts/inner-loop.mjs` の既定 backend が codex のままで、全起動に `--backend claude` を手で付けている。付け忘れが実害を出した（2026-07-05、task-16 の resume を素で起動 → REVIEW 段が codex で spawn → kill と再走を誘発）。

## やること
- fresh run の既定 backend を claude に変更（`--backend codex` の明示指定は残す＝将来 codex 再契約時の互換）
- meta-loop（scripts/meta-loop.mjs）の既定も claude（ADR 0024 §2 で既に claude 既定のはず — 実装を確認して不一致なら揃える）
- unit 追随

## 関連
- #78 (c) は resume 時の backend 継承（manifest から直近 backend を引き継ぐ）。本件は fresh run の既定値で、別物だが同じ痛点。両方入ると `--backend` 指定はほぼ不要になる。

---
intake: issue #81 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->
