---
title: Lathe — Monorepo Migration Plan (ADR 0003 "A")
status: in-progress
owner: yutaro0915
assignee: codex
created: 2026-06-09
updated: 2026-06-09
---

# Lathe — Monorepo Migration Plan（ADR 0003 "A"）

## Goal

[ADR 0003](./adr/0003-monorepo-with-pnpm-workspaces.md) の monorepo 形へ移行する。**観測機能 / UI / API / DB スキーマ / observable 挙動は一切変えない**。コードは「場所を移すだけ」。全 GREEN（build / coverage / e2e 49/49）を各タスク後に維持する。

## Why

Lathe は将来 2 つの publish 単位を持つ（`lathe` = web 本体 / `lathe-client` = 各 repo に install する側、[ADR 0001](./adr/0001-ingest-via-hook-and-server-side-jsonl.md)）。GitHub repo は 1 つに保ちつつ、独立 publish 可能な複数 package を同居させる = monorepo（pnpm workspaces）。

**block move（全部まとめて apps/web へ移す）**方式を採るので、相対 import も `@/` alias も壊れない（塊で動くので相対関係が保たれ、tsconfig も apps/web へ移れば `@/*: ./*` は apps/web 基準になるだけ）。これが import 書き換えを最小化する肝。

## Scope（YAGNI）

今回やる:

- pnpm workspaces 化（root に workspace 設定）
- apps/web へ block move
- packages/shared + packages/client の skeleton
- 配線 smoke test（A-2: shared に 1 ファイルだけ出し apps/web から import）

今回やらない（ADR 0003 で方向は決定済みだが sequencing を後ろへ）:

- **Turborepo**: build 最適化が要るまで保留（pnpm workspaces + Next `transpilePackages` で smoke test は通る）
- **Changesets**: 初 publish 時まで保留（今は全部 `private`）
- **packages/shared への本格抽出**: consumer が出た時に lazy（今回は smoke test の 1 本だけ）
- **lathe-client 本体実装**: #2/#3 設計後の別 sprint
- **Postgres 化**（[ADR 0004](./adr/0004-postgres-from-phase-1-and-hybrid-dev-env.md)）: A 完了後の別 sprint。今回は `node:sqlite` のまま動かす

## Non-goals

- UI / レイアウト / 操作感を変えない（CSS class 名維持、e2e DOM セレクタ維持）
- observable な API（URL ルート / クエリ / DB スキーマ）を変えない
- 観測機能を増減しない
- ロジックの中身を変えない（純粋な移動 + workspace 配線のみ）

## Constraints

- Node 24、`node:sqlite`、Next.js 15、pnpm
- `data/lathe.db` は再生成物（gitignored）。移動後は `pnpm -F web ingest` で再生成
- single-writer: Codex 稼働中、Claude はこの repo 内の既存ファイルを編集しない（新規 design ファイル追加は可）
- e2e は実機 transcript 前提（セッション ID ハードコード、[REFACTOR-PLAN.md](./REFACTOR-PLAN.md) 既知の落とし穴参照）

## Success criteria

最終状態で:

- `pnpm -F web build` PASS（型チェック含む）
- `pnpm -F web coverage` VERDICT GREEN（再 ingest 後）
- `pnpm -F web e2e` **49/49 GREEN**
- import 書き換えが最小（`@/` alias 維持、`git grep -c '@/'` が移動前と一致）
- apps/web が `@lathe/shared` を workspace 経由で import して動く

## Task DAG

```
[05] block move + pnpm workspace ──→ [06] packages scaffold + 配線 smoke test
```

直列。[05] で repo が「1 package の workspace」として GREEN になってから [06]。

## タスク一覧

- [tasks/05-block-move-and-pnpm-workspace.md](./tasks/05-block-move-and-pnpm-workspace.md) — large
- [tasks/06-scaffold-packages-and-wiring-smoke-test.md](./tasks/06-scaffold-packages-and-wiring-smoke-test.md) — medium

進捗は [status.md](./status.md)。

## Invariants（どのタスクでも守る）

1. e2e の本文を変更しない。落ちたら実装 / 設定 / パス側を直す（DOM・CSS class 名維持）
2. 公開 export 不変: `lib/db.ts` の `getSessionBundle / listSessions / getStats / getSessionEventCounts / getPrimarySession`
3. URL ルート不変: `/`, `/diff`, `/stats`, `/overview` + `?session=` `?tab=` `?focusEvent=` 等
4. DB スキーマ不変（`db/schema.sql` を触らない。Postgres 化は別 sprint）
5. `db/pricing.json` 不変

## 既知の落とし穴

- **.next 衝突**: dev 稼働中の build で `webpack-runtime.js` cannot find module。build/e2e 前に dev を止める
- **data/ 再生成**: data/ は gitignored。移動後 `pnpm -F web ingest` で `apps/web/data/lathe.db` を作る
- **cwd 相対 DB パス**: `lib/db.ts` は `process.cwd()/data/lathe.db`。`pnpm -F web <script>` は cwd=apps/web になるので無改修で通る。root から直接叩くと壊れる
- **@/ alias**: tsconfig.json を apps/web へ移せば `@/*: ./*` は apps/web 基準。**import 書き換え不要**
- **playwright webServer**: `pnpm build && pnpm start -p 3211` が apps/web の cwd で動くこと（`pnpm -F web e2e` で確認）
- **lockfile churn**: workspace 化で `pnpm install` が pnpm-lock.yaml を作り直す（想定内）
- **docs を動かさない**: adr/ ROADMAP.md PROTOTYPE.md status.md tasks/ README.md AGENTS.md 等は root に残す

## commit message 規約

- `[<NN>] <imperative subject>` 例: `[05] move app into apps/web and set up pnpm workspace`
- observable 変更を出さないので commit 群を 1 PR に束ね、PR タイトルは `refactor(monorepo): ...`

## 出口

1. **AGENTS.md / PROTOTYPE.md の stack 記述更新は Postgres 実装時**（A 単独では `node:sqlite` のまま。今は触らない）
2. **status.md** を `current_owner: none` に戻す
3. 次 sprint: Postgres 化（[ADR 0004](./adr/0004-postgres-from-phase-1-and-hybrid-dev-env.md)）→ その後 lathe-client 本体（#2/#3 設計後）
