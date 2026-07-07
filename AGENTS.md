# AGENTS.md - Lathe

code-project（実装・テスト中心: `apps/web` / `design/` / `adr/` / `rubrics/` / `scripts/`）。ハーネスエンジニアリングプラットフォーム。

## Scope

- 6 機能を段階的に構築する（README.md 参照）
- 最初のスコープは機能 1（トランスクリプト表示・分析）
- コーディング agent は作らない。既存 agent の観測・改善・評価に専念する

## Stack

- Next.js + Postgres（`pg` / node-postgres）
- Python 利用時は uv

## Rules

- 機能は順番に 1 つずつ実装する。先の機能に手を出さない
- ただしデータモデルは後続機能（特にハーネスのレベル 3）を意識して設計する
- v7（lathe-phase7）とは独立。参考にはするが依存しない

## 協働の worktree 規律（単一 writer）

複数 agent / chip が **main worktree を同時編集すると衝突する**（2026-06-19、a11y chip と T2 修正が main で交錯し、premature な gate 改変が混入した事故）。worktree はこれを防ぐためにある。

- コード編集を伴う委譲（サブエージェント）は **`Agent(isolation: "worktree")`** で隔離し、編集・build・e2e をその worktree 内で完結させる。main は **Claude（監査役）が単独 writer** として diff を確認して取り込む。
- **chip（`spawn_task`）は使わない（禁止）**。一見ただの cleanup でも、型の締め方・rubric の新設/改訂・入力境界の検証戦略・scope 切り分け等の**設計判断**が潜み、潜在の有無は事前に分からない（例: ingest の loose 型 43→38 削減チップは、実は「外部 transcript JSON の検証戦略をどうするか」という設計判断だった、2026-06-26）。chip は SCOPE→PLAN(人間承認)→implement の gate を迂回して設計判断を機械実行に流すため禁止。スコープ外の発見は **issue 化** するか outer loop に上げ、通常フローに戻す。
- 「main を編集して e2e だけ disposable worktree で回す」運用は**禁止**（編集が隔離されず並行 writer で衝突する）。編集ごと隔離する。
- rubric（`rubrics/`）の編集は監査役のみ・実装スライスと別コミット（**運用規律**。機械 gate `meta/no-gate-tampering` は gate 変更 PR と構造衝突するため廃止＝余計な依存を増やさず運用で担保、2026-06-23）。

## コマンド規律（必ず使う）

検証と git の正しいコマンド。逸脱は PreToolUse hook `.claude/hooks/git-guard.mjs` が機械で止める（broad `git add` と force-push を block・正解を提示）。

- **検証は単一入口 `pnpm preflight`**: `--quick`（tier=cmd・即時、Stop hook が使用）／`--fast`（tier=test＝＋tsc＋unit）／`--full`（tier=heavy＝e2e・storybook・integration・judge 込み・merge gate）。**全検証層（tsc/unit/e2e/storybook/integration/judge）は run.mjs の scoped+tiered rubric**＝scope が「どれを」・tier が「どこまで」を決める。gate 単体は `node rubrics/run.mjs --changed <paths> [--tier cmd|test|heavy]`。
- **個別**: `pnpm test`（unit）／`pnpm -C apps/web exec tsc --noEmit`／`DATABASE_URL=…@localhost:55433/lathe pnpm -C apps/web run verify:incremental`（scratch DB integration）。
- **dev / ingest**: `pnpm dev`（起動時に増分 ingest を background 実行）／`pnpm -C apps/web run ingest:incremental`。
- **merge 衛生（必須・2026-06-26 の事故の教訓）**: `git reset`（index クリア）→ 明示 `git add <paths>` → `git diff --cached --stat` で意図と照合 → commit。**`git add -A` / `git add .` 禁止**（stray・node_modules symlink・残留 AD を巻き込む）。削除は `git rm`。**FF only（force-push 禁止）**。

## Status

**Phase 1 完了（2026-06-11）・E2E 67/67 GREEN**。観測 = turn-first transcript / Git 差分 / 統計 / コスト異常検知（G9）/ PR 連携（G1、session ⇄ PR 紐付け）/ UI 標準 = observability-dense（`design/ui-design-language.md`）。
- 公開: `github.com/yutaro0915/lathe`（**public**、`main` に全コード）。npm は未公開（`private:true`）。
- Claude Code + Codex 両対応、cost は実モデル単価（2026-06-11 公式照合済み、`docs/cost-semantics.md`）、push 主・pull 補 ingest（`lathe-client init` + notify、token 認可）。
- **計画の正本は `ROADMAP.md`**（rolling wave）。実装運用は `skills/lathe-loop`（タスク類型 / tmux+goal 起動 / モデル配分）、コード規範と監査ゲートは `rubrics/`（機械検査・agent-judge、merge は `run.mjs` のみ。散文 MD と Tier 人間レビュー層は廃止）。起動/検証の詳細は `PROTOTYPE.md`。
- 次は Phase 2（AI 分析）。開始ゲートのドラフトは `design/phase2-finding-model.md`。
- **開発フロー（agent ecosystem）の正本は `design/agent-workflow.md`**: **outer loop（監督の役割）が監視(meta-audit)/issue 化/rubric 管理/エスカレーション対応、inner loop（named agent）が task ごとに実装を自律完走し **PR+CI（単一着地ゲート、ADR 0026）**で main へ着地**。実装は outer と別セッションに分離する。**model ≠ role**（opus はモデル名で役割名ではない＝ADR 0005/0009）。`lathe/` 起動の cc で named agent を `subagent_type` で呼ぶ（hub 起動では built-in しか見えないので lathe/ で起動する）。**起票 = `gh issue create --label task-request`**（**issue がそのまま task**・TASK-N = issue #N・採番は GitHub・却下なし、ADR 0031）。実行単位は issue。status は保存せず導出（参照 PR open=In Progress／merge close=Done）。plan=body・裁定=comment・needs-plan/escalation/優先度=label。盤面は GitHub Projects（機械が読むのは Ready 列のみ＝承認入力。他列は投影・ADR 0035）。実行は launchd の orchestrator が常駐 dispatch（正本 design/loops.md）。**全会話は規定 loop の一つ・outer の終端に実装は無い**（正本 `design/loops.md`）。詳細は agent-workflow.md 冒頭バナー。
