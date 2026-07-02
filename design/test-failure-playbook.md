# Test Failure Playbook — 既知失敗パターンの台帳（成長する知識）

> status: seeded / 2026-06-25
> 用途: verifier が返した RED を test-triage が「既知 / 新規」に切り分けるための台帳。
> 位置づけ: agent-workflow.md の knowledge-layer で「成長する知識」。skill（不変手順）には置かず、
> 観測した既知失敗をここに追記して育てる。**追記は監査役（outer loop）のみ**。
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

## P3 — worktree の pre-existing 8-fail（未ビルド deps / node_modules 未リンク）
- **症状**: worktree での `pnpm test` が `Cannot find module '@lathe/acp-client'` / `'@lathe/domain'` / `'pg'` 等のモジュール解決エラーで複数ファイル（典型 8 件）落ちる。落ちるファイルは自分の変更と無関係。
- **切り分け**: (a) エラーが全て module-not-found か、(b) `ls <worktree>/node_modules` が空/欠損か、(c) main（repo root）で同じ `pnpm test` が全緑か。3 点が揃えば env 起因（worktree に pnpm workspace の symlink / `packages/*/dist` が無い）。
- **対処**: worktree で `pnpm install` 後に再実行。または「branch の責でない」と注記して main 側の緑を根拠に判定する。ゼロから再切り分けしない（毎回同じ結論になる）。
- **出所**: 2026-07-02 meta-audit（issue #29/#25 の run）。両 VERIFY と #25 IMPLEMENT の verifier が同じ 8 件を毎回再発見していた（session 802d6cb7 seq33 / 89808ce8 seq28）。
