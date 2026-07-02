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

## P4 — Codex sandbox EPERM（VERIFY 実行環境の権限不足）
- **症状**: Codex backend の VERIFY / TRIAGE で、検証対象コードではなく sandbox 制約により EPERM が出る。典型例は `tsc` の `.tsbuildinfo` 書き込み、unit test の temp 書き込み、`next build` の `.next` mkdir、Playwright cache mkdir、`connect EPERM 127.0.0.1:<port>` / `connect EPERM ::1:<port>`。
- **切り分け**: 同じ変更を `workspace-write` + `sandbox_workspace_write.network_access=true` で再実行できるかを見る。Codex exec 自体が環境 EPERM で起動不能、または localhost 接続だけが EPERM の場合は、コード修正で直らない実行基盤問題として扱う。
- **対処**: driver の sandbox/backend 設定を確認する。VERIFY は必要に応じて Claude backend fallback（`--backend-verify claude`、既定 fallback を含む）で検証する。sandbox EPERM を `KNOWN` として IMPLEMENT に戻しても、実装コードは改善せず 1 周浪費するだけなので戻さない。TRIAGE はこのパターンを見つけたら `VERDICT: ESCALATE` とする。
- **出所**: 2026-07-02、issue #33 初 Codex run。VERIFY が read-only sandbox で tsc/unit/next/playwright/localhost を実行して EPERM になり、TRIAGE が環境起因を `KNOWN` と誤分類した。

## P5 — e2e scratch DB の schema 消失（55433 未初期化）
- **症状**: webServer 起動を伴う e2e 系 rubric が一斉 RED。run.mjs の最終行では `[WebServer] }` だけが見えるが、展開すると Postgres `42P01 relation "sessions" does not exist` 等の連発と `Timed out waiting 180000ms from config.webServer`。
- **切り分け**: `docker exec lathe-scratch-postgres psql -U lathe -d lathe -c '\dt'` で relations が空かを見る。空なら schema 消失（コンテナ再作成等）でコードの責ではない。
- **対処**: 環境修理は監査役へ escalate（`apps/web/db/schema.sql` 適用 → `DATABASE_URL=postgres://lathe:lathe@localhost:55433/lathe pnpm -C apps/web run ingest:incremental`）。コード修正で直らないので IMPLEMENT に戻さない。
- **出所**: 2026-07-03、issue #24 の VERIFY。scratch DB (55433) の relations がゼロで `inspector-collapse-expand-toggle` / `render-layout-integrity` が持続 RED。schema+ingest 復旧後に両者 GREEN。

## P6 — PG 22003: BIGINT 集計の ::int downcast overflow
- **症状**: 特定ページ（例 `/overview`）の e2e が application error / server exception で複数 RED。error digest があり、DB ログ/再現 SQL で `integer out of range`（code 22003、`numeric_int4_opt_error`）。
- **切り分け**: 該当ページの読み取りクエリに `SUM(<BIGINT列>)::int` 等の downcast が無いか grep。実データで `SUM` が 2147483647 を超えるかを SQL で確認（データ量が増えるとある日突然発火する）。
- **対処**: コード修正（downcast 除去）として issue 化する。env 修理では直らない。データを減らして緑化するのは偽修復なので禁止。
- **出所**: 2026-07-03、issue #24 の VERIFY。`overview-stats.ts` の `SUM(token_usage)::int` が実データ 25.3 億で overflow（→ issue #55）。#24 の差分とは無関係（blame 286b2f58）。
