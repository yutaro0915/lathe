---
id: 01
title: Remove dead code (SessionSidebar, seed script)
status: todo
assignee: codex
depends_on: []
estimated: small
---

## What

実装本体から参照されていない 2 ファイルを削除する。

- `components/SessionSidebar.tsx`（167 行）— **どこからも import されていない**。`OverviewView.tsx` は自前で `<aside class="sidebar">` を書いている。
- `db/seed.ts`（1139 行）+ `package.json` の `"seed": "tsx db/seed.ts"` スクリプト — **テスト・e2e から参照ゼロ**。`pnpm seed` を呼ぶのは README にすら載っておらず、実 transcript の `pnpm ingest` で完全に置き換わっている。

## Why

[REFACTOR-PLAN.md](../REFACTOR-PLAN.md) の「死んだコード」セクション参照。リファクタの最初に**依存範囲が広い変更の前に dead code を消して**、後段（[02] / [04]）の diff を読みやすくする。

## Input

- `components/SessionSidebar.tsx`
- `db/seed.ts`
- `package.json`（scripts セクション）
- 確認用: `git grep -nE "SessionSidebar|db/seed"` で参照箇所を再確認すること（ない想定）

## Output

削除:

- `components/SessionSidebar.tsx`
- `db/seed.ts`

編集:

- `package.json` の `scripts` から `"seed": "tsx db/seed.ts"` 行を削除。

## Done criteria

- [ ] `git grep -nE "SessionSidebar"` が **0 件**。
- [ ] `git grep -nE "\"seed\":\\s*\"tsx"` が **0 件**。
- [ ] `git grep -nE "db/seed"` が **0 件**（README に痕跡があれば併せて削除）。
- [ ] `pnpm build` PASS。
- [ ] `pnpm e2e` **49/49 GREEN**（変更ゼロを期待）。
- [ ] commit メッセージ: `[01] remove dead SessionSidebar component and seed script`

## Notes

- **`db/schema.sql` と `db/pricing.json` は削除しない**。
- **`scripts/coverage_check.ts` は seed と独立**（実 DB を読む）。誤って巻き込まないこと。
- 本タスクは UI / API に観測可能な変化を起こさない。e2e が落ちたら原因を再確認すること（テスト本文の変更は不要）。
- ローカルに `data/lathe.db` がある状態で実行可。再生成は不要。
