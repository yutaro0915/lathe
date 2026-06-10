---
id: 05
title: Move app into apps/web and set up pnpm workspace
status: todo
assignee: codex
depends_on: []
estimated: large
---

## What

現状フラットに置かれているアプリコード一式を **`apps/web/` へ block move** し、root に **pnpm workspace** を設定する。repo を「1 package の workspace」として全 GREEN になる状態にする。**ロジック・UI・API・DB は変えない**。

## Why

[MONOREPO-PLAN.md](../MONOREPO-PLAN.md) / [ADR 0003](../adr/0003-monorepo-with-pnpm-workspaces.md) 参照。塊でまとめて動かすので相対 import と `@/` alias が壊れない。これが import 書き換えを最小化する肝。

## Input

- 現状 top-level: `app/ components/ lib/ db/ scripts/ e2e/ data/` + `next.config.mjs tsconfig.json playwright.config.ts package.json next-env.d.ts pnpm-lock.yaml`
- `tsconfig.json` の `paths`: `@/*` → `./*`（移動後も apps/web 基準で維持）
- 確認: `git grep -c '@/'` を**移動前に控える**（移動後に一致を確認するため）

## Output

**apps/web/ へ移動（`git mv`）**:

- `app/ components/ lib/ db/ scripts/ e2e/ data/`
- `next.config.mjs tsconfig.json playwright.config.ts next-env.d.ts`
- `package.json` → `apps/web/package.json`（`"name": "lathe"`, `"private": true`、scripts はそのまま: `dev/build/start/ingest/coverage/e2e`）

**root に残す（動かさない）**:

- `adr/ ROADMAP.md PROTOTYPE.md REFACTOR-PLAN.md MONOREPO-PLAN.md status.md tasks/ README.md LICENSE AGENTS.md CLAUDE.md SESSION-HANDOFF.md .claude/ .gitignore .git/`

**root に新規**:

- `package.json`（`"name": "lathe-monorepo"`, `"private": true`, `"packageManager": "pnpm@<現行版を `pnpm -v` で確認して記入>"`）
- `pnpm-workspace.yaml`:
  ```yaml
  packages:
    - "apps/*"
    - "packages/*"
  ```
- `pnpm-lock.yaml` は root（`pnpm install` で再生成）

**移動しない / 再生成**:

- `.next/`、`tsconfig.tsbuildinfo`（build 生成物。gitignore のまま）

**.gitignore 更新**:

- 旧 `/.next` `/data` `/tsconfig.tsbuildinfo` 等を `apps/web/` 配下の新パスに対応させる（または path-agnostic に）

## Done criteria

- [ ] `apps/web/` 配下に上記が移動し、root に workspace 設定がある
- [ ] `pnpm install` 成功（root lockfile、churn は想定内）
- [ ] `pnpm -F web ingest` で `apps/web/data/lathe.db` が再生成される
- [ ] `pnpm -F web build` PASS
- [ ] `pnpm -F web coverage` VERDICT GREEN
- [ ] `pnpm -F web e2e` **49/49 GREEN**
- [ ] `git grep -c '@/'`（apps/web 配下）が移動前と一致（import 書き換えゼロ）
- [ ] commit: `[05] move app into apps/web and set up pnpm workspace`

## Notes

- **DB は触らない**（`node:sqlite` のまま。Postgres 化は別 sprint = [ADR 0004](../adr/0004-postgres-from-phase-1-and-hybrid-dev-env.md)）
- cwd 相対 DB パスは `-F web` 実行で cwd=apps/web になり無改修で通る
- playwright の webServer（`pnpm build && pnpm start -p 3211`）が apps/web cwd で動くか確認。必要なら `pnpm -F web ...` に直す
- **docs（adr/ ROADMAP 等）を apps/web に移さない**
- UI/API に observable 変化を出さない。e2e が落ちたら設定 / パスを疑う（テスト本文は変えない）
