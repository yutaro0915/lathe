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

## Status

**Phase 1 完了（2026-06-11）・E2E 67/67 GREEN**。観測 = turn-first transcript / Git 差分 / 統計 / コスト異常検知（G9）/ PR 連携（G1、session ⇄ PR 紐付け）/ UI 標準 = observability-dense（`design/ui-design-language.md`）。
- 公開: `github.com/yutaro0915/lathe`（**public**、`main` に全コード）。npm は未公開（`private:true`）。
- Claude Code + Codex 両対応、cost は実モデル単価（2026-06-11 公式照合済み、`docs/cost-semantics.md`）、push 主・pull 補 ingest（`lathe-client init` + notify、token 認可）。
- **計画の正本は `ROADMAP.md`**（rolling wave）。実装運用は `design/workflows.md`（タスク類型 / tmux+goal / エスカレーション）、監査は `design/audit-protocol.md`。起動/検証の詳細は `PROTOTYPE.md`。
- 次は Phase 2（AI 分析）。開始ゲートのドラフトは `design/phase2-finding-model.md`。
