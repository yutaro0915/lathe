# AGENTS.md - Lathe

code-project archetype。ハーネスエンジニアリングプラットフォーム。

## Scope

- 6 機能を段階的に構築する（README.md 参照）
- 最初のスコープは機能 1（トランスクリプト表示・分析）
- コーディング agent は作らない。既存 agent の観測・改善・評価に専念する

## Stack

- Next.js + SQLite（better-sqlite3）
- Python 利用時は uv

## Rules

- 機能は順番に 1 つずつ実装する。先の機能に手を出さない
- ただしデータモデルは後続機能（特にハーネスのレベル 3）を意識して設計する
- v7（lathe-phase7）とは独立。参考にはするが依存しない

## Status

**Phase 1（機能1: 観測 = トランスクリプト / Git 差分 / 統計ビューア）実装済み・E2E 42/42 GREEN**（2026-06-07）。
- 公開: `github.com/yutaro0915/lathe`（**public**、`main` に全コード）。npm は未公開（`private:true`）。
- Claude Code + Codex 両対応、cost は実モデル単価で算出、サブエージェント / ハーネス信号（memory/hook）観測あり。
- **再開・全機能・起動/検証・既知の制約・次の一歩は `PROTOTYPE.md`（引き継ぎ書）を読む。**
- Phase 2 以降は未着手。スタックは Next.js 15 + `node:sqlite`（`better-sqlite3` は Node 24 prebuilt 不在のため不採用、接続部のみ差し替え可）。
