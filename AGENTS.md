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

計画確定。実装未着手。
