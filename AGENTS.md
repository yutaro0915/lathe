# AGENTS.md - Lathe

code-project archetype。ハーネスエンジニアリングプラットフォーム。

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
- **chip（`spawn_task`）は必ず ①自分の worktree で完結（main を触らせない、branch/diff で返す）か、②issue 化**のいずれか。auto 実行で main を直接編集させない。
- 「main を編集して e2e だけ disposable worktree で回す」運用は**禁止**（編集が隔離されず並行 writer で衝突する）。編集ごと隔離する。
- rubric（`rubrics/`）の編集は監査役のみ・実装スライスと別コミット（`meta/no-gate-tampering`）。

## Status

**Phase 1 完了（2026-06-11）・E2E 67/67 GREEN**。観測 = turn-first transcript / Git 差分 / 統計 / コスト異常検知（G9）/ PR 連携（G1、session ⇄ PR 紐付け）/ UI 標準 = observability-dense（`design/ui-design-language.md`）。
- 公開: `github.com/yutaro0915/lathe`（**public**、`main` に全コード）。npm は未公開（`private:true`）。
- Claude Code + Codex 両対応、cost は実モデル単価（2026-06-11 公式照合済み、`docs/cost-semantics.md`）、push 主・pull 補 ingest（`lathe-client init` + notify、token 認可）。
- **計画の正本は `ROADMAP.md`**（rolling wave）。実装運用は `skills/lathe-loop`（タスク類型 / tmux+goal 起動 / モデル配分）、コード規範と監査ゲートは `rubrics/`（機械検査・agent-judge、merge は `run.mjs` のみ。散文 MD と Tier 人間レビュー層は廃止）。起動/検証の詳細は `PROTOTYPE.md`。
- 次は Phase 2（AI 分析）。開始ゲートのドラフトは `design/phase2-finding-model.md`。
