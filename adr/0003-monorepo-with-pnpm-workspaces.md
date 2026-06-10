---
id: 0003
title: Repository structure = single GitHub repo, internal pnpm workspaces + Turborepo
status: accepted
date: 2026-06-07
deciders: [yutaro0915, claude]
supersedes: null
---

## Context

[ADR 0001](./0001-ingest-via-hook-and-server-side-jsonl.md) で `pnpm install lathe-client` の必要性が確定した(各プロジェクトに install して `.claude/settings.json` に hook を仕込む役割)。これにより:

- **Lathe 本体**(Web UI + DB + ingest worker、Next.js + SQLite)
- **lathe-client**(各プロジェクトに install する CLI + library、`.claude/settings.json` 編集 + 本体 URL 保存 + hook 実装)

の **2 つの npm publish 単位**が必要になる。一方、ユーザーの希望は「**GitHub repo は 1 つに保ちたい**」。

2026 年時点の事実調査:

- **Langfuse 本体**は **pnpm workspaces + Turborepo の monorepo**(`web/` + `worker/` + `packages/` + `ee/`)。出典: [github.com/langfuse/langfuse](https://github.com/langfuse/langfuse), [pnpm-workspace.yaml](https://github.com/langfuse/langfuse/blob/main/pnpm-workspace.yaml)
- ただし Langfuse の **SDK は別 repo**(`langfuse-python`, `langfuse-js`)。これは「SDK が複数言語ある + 独立 release サイクル」のため。Lathe は client が TS 1 言語なので同居が筋。
- 同等構成の OSS:
  - **shadcn-ui/ui** = `apps/v4`(Next.js docs) + `packages/shadcn`(CLI、`npx shadcn add` の本体)。**Lathe にほぼ同形**。
  - **cloudflare/workers-sdk** = `packages/wrangler`(CLI) + `miniflare` + `create-cloudflare` + `vite-plugin`
  - **drizzle-team/drizzle-orm** = `drizzle-orm/`(lib) + `drizzle-kit/`(CLI)を別 package で publish
  - **prisma/prisma** = `@prisma/client` + `prisma`(CLI)
  - **t3-oss/create-t3-turbo** = `apps/nextjs` + `packages/{api,db,auth,ui}`
- **単一 package → monorepo 化のコスト**(複数ソース一致):
  - 個人 / 数千行 / 1 dev: 半日〜2 日
  - 遅らせるほど線形に重くなる(Aha! Engineering / Robin Wieruch / Microsoft TypeScript Performance wiki)
  - 一番痛いのは import path ではなく、**publish 単位を後から増やすときの semver 移行**(`<name>-client` を 0.x からやり直すか dual publish 期間)

## Options

- **A. 単一 package のまま**(`src/web/` `src/cli/` `src/sdk/`):
  - メリット: 最速で立ち上がる、tooling 不要
  - 致命的欠点: **`lathe-client` を別 npm package として publish する要件と相性が悪い**。CLI 用依存が Next bundle に紛れ込む。publish 単位を後から増やすときの semver 移行が痛い。
- **B. pnpm workspaces のみ**(Turborepo 無し):
  - メリット: tooling 1 個(pnpm)
  - 欠点: build cache が無いので CI が遅くなり始める、依存順を自分で書く必要
- **C. pnpm workspaces + Turborepo**(2026 Vercel 公式デフォルト):
  - メリット: 業界標準、Changesets で複数 package を一括 publish、increment build cache
  - 欠点: Turborepo の依存設定を正しく書かないと dev が古い build を見る
- **D. Nx**:
  - 大規模 monorepo 向け、3-5 package 規模ではオーバーキル
- **E. 別 GitHub repo に分割**:
  - ユーザー希望 NG

## Decision

**C を採用する**。

具体的な構成(shadcn-ui に最も近い):

```
lathe/
├── apps/
│   └── web/                  # 現状の Next.js + SQLite + ingest server
├── packages/
│   ├── client/               # pnpm install lathe-client で入る側(CLI + library)
│   └── shared/               # 型 / pricing / format 等
├── pnpm-workspace.yaml
├── turbo.json
├── .changeset/
└── package.json              # private: true (root)
```

publish 単位:

- **`lathe`** = `apps/web/`(将来 `npx lathe` で起動できるよう CLI ラッパーを足す)
- **`lathe-client`** = `packages/client/`(各プロジェクトに install する側)
- **`packages/shared`** は **publish せず `workspace:*` で内部参照のみ**

Tooling:

- pnpm workspaces(現状すでに pnpm 使用中)
- Turborepo(`turbo.json` で task graph)
- Changesets(複数 package の release 管理)
- tsup(`packages/client` `packages/shared` の build)
- Next.js 15 設定:
  - `transpilePackages: ['@lathe/shared', '@lathe/client']`(monorepo source を直接食わせる、Next 13.1+ 標準)
  - `serverExternalPackages: ['better-sqlite3']`(`node:sqlite` 互換と整合)

GitHub repo: **`yutaro0915/lathe` のまま 1 つ**。

## Consequences

- **半日〜2 日の移行コスト**:
  1. `apps/web/` への物理移動(現状の `app/` `components/` `lib/` `db/` `scripts/` `e2e/` 等を `apps/web/` 配下に)
  2. `pnpm-workspace.yaml` + `turbo.json` + `.changeset/` 追加
  3. root `package.json` に `private: true` + `packageManager: "pnpm@..."`
  4. Next.js の `transpilePackages` / `serverExternalPackages` 設定
  5. import path の一括書き換え(`@/lib/...` → `@lathe/shared/...` 等、必要に応じて)
  6. CI / e2e の paths 更新
  7. dev 起動コマンドの調整(`pnpm -F web dev` 等)
- **タイミングは Phase 1 リファクタ完了後すぐ**(Codex のリファクタ [04] が終わっているので、次の sprint で実施)。Phase 2 機能実装に入る前にやる。
- **npm 名問題**: `lathe` は npm で既に取られている可能性が高い。`@yutaro0915/lathe` 等 scoped に逃げる選択肢を残す(本 ADR の範囲外、別途決定)。
- **将来 SDK だけ別 repo に出す柔軟性は残る**: `packages/client` が `workspace:*` 以外の外部依存を持たないように保てば、`git filter-repo` で半日仕事で別 repo 化可能。逆方向(単一 → monorepo)より、monorepo → 別 repo の方が常に軽い。
- **e2e の場所**: `apps/web/e2e/` に移動。Playwright config も `apps/web/playwright.config.ts`。
- **coverage_check.ts / ingest.ts** の移動: `apps/web/scripts/` に。lathe-client 側にも独自 scripts が出てくるが、最初は web 側に集中していて良い。
