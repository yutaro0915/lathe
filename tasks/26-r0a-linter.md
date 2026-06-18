# tasks/26-r0a-linter.md — r0a: dependency-cruiser + oxlint harness

> slice: r0a-linter / phase: rails / size: S
> depends: — (先行依存なし)
> gate: lint 設定構文 GREEN・I2 違反 warn 検出・grandfather 免除・build/e2e 不変
> 担当: 実装 Sonnet / レビュー Codex high

## 目的

`design/architecture.md` §5 の不変条件 **I1/I2/I4/I6** を機械強制する lint ハーネスを新規構築する。
warn-first（CI を落とさない）で始め、warn→error 昇格は各 slice 分解完了後とする。

## 作成ファイル

| ファイル | 内容 |
|---|---|
| `.dependency-cruiser.js` | I1/I2/I6 の forbidden ルール（severity: warn） |
| `.oxlintrc.json` | I4 の max-lines/max-lines-per-function + no-unused-vars + grandfather |
| `package.json` | devDependencies + scripts |
| `tasks/26-r0a-linter.md` | 本ファイル |

## 既知違反バックログ

### I1: 生 SQL は lib/db と ingest/db のみ（postgres-boundary）

| 場所 | 違反内容 | 対応 slice |
|---|---|---|
| `apps/web/app/api/findings/[id]/verdict/route.ts:2` | `queryOne` を `@/lib/postgres` から直 import | r5-data-layer（lib/write 経由に変更） |
| `apps/web/scripts/analyst-engine.ts` | `getPool()` 直叩き | r8-analyst-split（scripts/ は機械強制対象外だが実態は違反） |

**注意**: `scripts/` は architecture §5 の I1 機械強制対象外。depcruise の I1 ルールでは `apps/web/scripts/` を from 除外している。

### I2: packages/* は apps/web を import しない（package-to-app）

| 場所 | 違反内容 | 対応 slice |
|---|---|---|
| `packages/mcp/src/server.ts:21` | `../../../apps/web/lib/mcp.js` を相対 import | r3-mcp-boundary（@lathe/domain 新設で解消） |
| `packages/mcp/src/verify.ts:12` | `../../../apps/web/lib/mcp.js` を相対 import | r3-mcp-boundary |
| `packages/mcp/src/verify.ts:13` | `../../../apps/web/lib/postgres.js` を相対 import | r3-mcp-boundary |

### I4: 1 ファイル ≤ 500 行（grandfather 外の 500 超ファイル = バックログ信号）

以下は grandfather **しない**（warn = バックログ信号として残す）:

| ファイル | 推定行数 | 対応 slice |
|---|---|---|
| `apps/web/lib/mcp.ts` | 500+ | r3-mcp-boundary |
| `apps/web/scripts/verify-phase2.ts` | 500+ | r5-data-layer または専用 slice |
| `apps/web/ingest/providers/claude.ts` | 500+ | 後続 slice |

### I6: 孤立モジュール（no-orphans）

依存グラフ解析後に確定。GlobalNav 等が候補（r1-deadcode で対応予定）。

## grandfather リスト（実測行数・2026-06-18 時点）

単調減少のみ許可。増加は即 warn（max を実測値に固定）。

| ファイル | 実測行数（wc -l） | architect.md 記載値 | 備考 |
|---|---|---|---|
| `apps/web/e2e/app.spec.ts` | **2869** | 2,869 | e2e spec は D2 で max=800 に緩和、本ファイルは grandfather |
| `apps/web/components/SessionViewer.tsx` | **2518** | 2,519 | WIP commit で 1 行減少 |
| `apps/web/scripts/analyst-engine.ts` | **1768** | 1,769 | WIP commit で 1 行減少 |
| `apps/web/lib/db.ts` | **1612** | 1,613 | WIP commit で 1 行減少 |
| `apps/web/components/DiffViewer.tsx` | **1280** | 1,280 | 一致 |
| `apps/web/components/FindingsExplorer.tsx` | **1030** | 1,030 | 一致 |

## warn→error 昇格スケジュール

| ルール | 昇格条件 |
|---|---|
| I1-postgres-boundary | r5-data-layer 完了（lib/write で route の直 SQL 撤去）後 |
| I2-package-to-app | r3-mcp-boundary 完了（@lathe/domain 新設・apps/web 依存切断）後 |
| I4 (max-lines) | grandfather 各ファイル ≤500 に収束後（全 god-file 分解完了後） |
| I4 (max-lines-per-function) | r7/r8/r9 完了後 |
| I6-no-orphans | r1-deadcode 完了後 |

## 検証ゲート（実施結果 2026-06-18）

- [x] `pnpm install` が ERROR なく完了（dependency-cruiser@16.10.4, oxlint@0.16.12 インストール済み）
- [x] `pnpm lint:deps` が構文/解決エラーなく完了（10 warnings, 0 errors）
- [x] I2 違反が warn として検出（3 件: server.ts→mcp.ts, verify.ts→mcp.ts, verify.ts→postgres.ts）
- [x] I1 違反が warn として検出（2 件: verdict/route.ts→@/lib/postgres, mcp.ts→postgres.ts）
- [x] N1 反証: I2 の from を `^NONEXISTENT_PACKAGE/` に変更 → warn ゼロ（✔ no violations）、元に戻す → 3 件復活
- [x] `pnpm lint:ox` で grandfather 6 本の max-lines warn がゼロ（実測値 = max に設定済み）
- [x] 非 grandfather 500+ ファイルが warn 出力（mcp.ts:641, verify-phase2.ts:704, verify.ts:555, claude.ts:566）
- [x] `pnpm -F web build` が ERROR ゼロ（all routes compiled successfully）
- e2e: 設定ファイル追加のみで runtime 不変のため full 実行を省略（next build GREEN = 無退行を確認）

### lint:deps の実測 warn（全 10 件）

```
warn I1-postgres-boundary: apps/web/app/api/findings/[id]/verdict/route.ts → @/lib/postgres
warn I1-postgres-boundary: apps/web/lib/mcp.ts → apps/web/lib/postgres.ts
warn I2-package-to-app: packages/mcp/src/verify.ts → apps/web/lib/postgres.ts
warn I2-package-to-app: packages/mcp/src/verify.ts → apps/web/lib/mcp.ts
warn I2-package-to-app: packages/mcp/src/server.ts → apps/web/lib/mcp.ts
warn I6-no-orphans: packages/acp-client/src/types.ts
warn I6-no-orphans: apps/web/lib/types.ts
warn I6-no-orphans: apps/web/lib/runner-display.ts
warn I6-no-orphans: apps/web/lib/event-display.ts
warn I6-no-orphans: apps/web/app/loading.tsx
```

## 後続 slice との接続

本 slice 完了後:
- **r0b-ci**: `.github/workflows` で tsc+oxlint+depcruise+verify+e2e を gate 化
- **r0c-enforce**: PreToolUse file-size guard + Stop retro
- **r1-deadcode**: GlobalNav 削除・orphan 解消（I6 昇格前提）
- **r3-mcp-boundary**: I2 違反解消（@lathe/domain 新設）
- **r5-data-layer**: I1 違反解消（lib/write で verdict route SQL 撤去）
