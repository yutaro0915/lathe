---
id: 27
title: r1-deadcode — デッドコード除去（GlobalNav / LlmProviderMode auto / loading 値）
status: done
workflow: loop
audit: C
estimated: small
bound: 10 turns
depends_on: []
assignee: codex
---
## What
挙動を変えずにデッドコード・到達不能コードを除去する（design/convergence-plan.md r1）。

## 受け入れ条件（各 exit 0 / 全 GREEN まで継続。途中停止禁止）
1. `apps/web/components/GlobalNav.tsx` を削除し、`grep -rn "GlobalNav" apps/web/` が 0 件。
2. `apps/web/scripts/analyst-engine.ts` の `LlmProviderMode` から到達不能な `'auto'` を除去（型と全参照の整合）。一時的に `'auto'` を渡す行を足すと `tsc` が型エラー＝N1 反証成立を確認してから戻す。
3. `apps/web/app/loading.tsx` の旧 `--sidebar-w:272px` フォールバックを tokens.css の正値（264px）に直す（不要なら除去）。
4. `pnpm install` 後 `pnpm -F web exec tsc --noEmit` が ERROR 0。
5. `pnpm -F web build` が ERROR 0。
6. `pnpm lint:deps` の I6 orphan から GlobalNav が消える（loading.tsx は I6 backlog のままで可）。

## やらないこと
- `apps/web/app/design-system/shell.css` の globalnav 互換 shim は**除去しない**（e2e が globalnav クラスに依存。r4 で回収）。
- 挙動変更・機能追加・無関係なリファクタをしない。

## norms
design/engineering-norms.md N1–N8 を守る。各項目 GREEN でも停止せず全項目 GREEN + git commit まで継続。push と main/loop への merge はしない。

## 実施結果（2026-06-18）

- [x] `pnpm install` exit 0
- [x] `test -z "$(grep -rn "GlobalNav" apps/web/)"` exit 0（`GlobalNav` 0 件）
- [x] `LlmProviderMode` / CLI allowed modes から `auto` を除去
- [x] N1 反証: 一時的に `const n1AutoProviderModeCheck: LlmProviderMode = 'auto';` を追加し、`pnpm -F web exec tsc --noEmit` が `TS2322` で RED になることを確認後に戻した
- [x] `apps/web/app/loading.tsx` の `--sidebar-w` fallback を `264px` に修正
- [x] `pnpm -F web exec tsc --noEmit` exit 0
- [x] `pnpm -F web build` exit 0
- [x] `pnpm lint:deps` exit 0（I6 orphan に `GlobalNav` なし。`loading.tsx` は backlog のまま）
