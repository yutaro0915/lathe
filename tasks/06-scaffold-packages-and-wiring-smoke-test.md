---
id: 06
title: Scaffold @lathe/shared + @lathe/client and prove cross-package import
status: todo
assignee: codex
depends_on: [05]
estimated: medium
---

## What

`packages/shared` と `packages/client` を **skeleton** で作り、**配線 smoke test** として `lib/format.ts` を `@lathe/shared` へ移し、apps/web からそれを import する。cross-package import が全 GREEN で通ることを実証する（[MONOREPO-PLAN.md](../MONOREPO-PLAN.md) の A-2）。

## Why

packages/ を空のままにすると、workspace 配線（`transpilePackages` 含む）を一度も検証しないまま将来の lathe-client 実装で初めて配線バグに当たる。pure な 1 ファイルだけ通して配線を担保する。`format.ts` は React/Node/DB 非依存の純粋関数なので適格。残りの shared 候補（`types.ts` 等）は consumer が出た時に lazy 移動（今回は移さない = YAGNI）。

## Input

- `apps/web/lib/format.ts`（移動対象）+ その import 元（`apps/web/components/*`）
- `apps/web/next.config.mjs`（`transpilePackages` 追記）

## Output

**packages/shared/**:

- `package.json`: `"name": "@lathe/shared"`, `"private": true`, `"type": "module"`, `main`/`exports`（src 直接参照 or tsup build）
- `tsconfig.json`、（必要なら `tsup.config.ts`）
- `src/format.ts`（`apps/web/lib/format.ts` を移動）
- `src/index.ts`（`export * from "./format"`）

**packages/client/**（skeleton のみ、実装なし）:

- `package.json`: `"name": "@lathe/client"`, `"private": true`
- `src/index.ts`（placeholder。中身は #2/#3 設計後の別 sprint）

**apps/web/**:

- `package.json` に `"@lathe/shared": "workspace:*"` を追加
- `format` を使う import を `@/lib/format` → `@lathe/shared` に張り替え
- `apps/web/lib/format.ts` を削除
- `next.config.mjs` に `transpilePackages: ['@lathe/shared']`

## Done criteria

- [ ] apps/web が `@lathe/shared` から format 関数を import して動く
- [ ] `git grep '@/lib/format'` が **0 件**（張り替え済み）
- [ ] `pnpm -F web build` PASS
- [ ] `pnpm -F web coverage` GREEN / `pnpm -F web e2e` **49/49 GREEN**
- [ ] `packages/client` は skeleton のみ（exports は placeholder、実ロジックなし）
- [ ] commit: `[06] scaffold @lathe/shared + @lathe/client and prove cross-package import`

## Notes

- **format.ts 以外は今回移さない**（`types.ts` / `cost.ts` / `event-display.ts` / `runner-display.ts` は consumer 都合で後日 lazy 移動）
- `@lathe/client` の publish 名（`lathe-client` / scoped）は npm 名問題（#11）で別途決定。今は internal name `@lathe/client` で OK
- **Turborepo / Changesets は本 sprint では入れない**（[MONOREPO-PLAN.md](../MONOREPO-PLAN.md) Scope 参照）
- `transpilePackages` で shared の TS source を直接食えるので、shared の事前 build は smoke test には不要（問題が出るなら tsup build → dist も通す）
