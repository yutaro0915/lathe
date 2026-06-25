# Test Failure Playbook — 既知失敗パターンの台帳（成長する知識）

> status: seeded / 2026-06-25
> 用途: verifier が返した RED を test-triage が「既知 / 新規」に切り分けるための台帳。
> 位置づけ: agent-workflow.md の knowledge-layer で「成長する知識」。skill（不変手順）には置かず、
> 観測した既知失敗をここに追記して育てる。**追記は監査役（OPUS）のみ**。
> 参照元: `.claude/skills/test-triage/SKILL.md` / `.claude/skills/verify/SKILL.md` / `.claude/agents/verifier.md`(P1)。
> 実在は rubric `meta/triage-playbook-exists` が機械保証する。

各パターン = 症状 / 切り分け / 対処 / 出所。

## P1 — cold e2e flake（初回実行の playwright 不安定）
- **症状**: e2e（`layout-integrity.spec` 等）が初回 cold 実行でのみ落ち、内容は環境準備（初回コンパイル・dev server 起動待ち）由来。
- **切り分け**: 同じ spec を **warm で再実行**（2 回目以降）。warm で安定 GREEN なら flake。
- **対処**: warm 再実行で GREEN を確認してから判定する。cold の 1 回落ちだけで RED にしない。
- **出所**: verify skill / verifier agent が既に参照（「初回 cold の e2e flake（playbook P1）」）。

## P2 — env 起因の build / gate RED（依存・キャッシュの陳腐化）
- **症状**: webpack / Next build や gate が「build failed」等で RED になるが、コードの実体的な破損ではない。
- **切り分け**: **fresh な依存で再現するか**を見る。別 worktree もしくは当該 worktree で `pnpm install`（必要なら `.next` 等のキャッシュ掃除）後に再実行し、GREEN になれば env 起因。
- **対処**: 依存 / キャッシュを入れ直して再実行。real breakage と断定する前に必ずこの切り分けを通す。
- **出所**: 2026-06-25、main worktree の `node_modules` / `.next` 不整合で `apps/web/interaction/panel-reopenable` と `apps/web/layout/integrity` が webpack build 失敗で RED。fresh install 後の worktree では両者 GREEN、main でも依存復旧後の再実行で GREEN を確認（false RED と確定）。
