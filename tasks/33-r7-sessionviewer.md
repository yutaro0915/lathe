---
id: 33
title: r7-sessionviewer — SessionViewer.tsx を ≤500 行に分割 (I4)。r6 後
status: completed
workflow: loop
audit: A
estimated: large
bound: 40 turns
depends_on: [r6]
assignee: codex
---
## What
design/convergence-plan.md r7。SessionViewer.tsx(約2518行) を tab 別 component + hook/lib 抽出で各 ≤500 行に分割。**挙動・見た目を変えない**(pure refactor)。

## 前提(r6)
- e2e は data-testid/role/aria に脱結合済み(106 GREEN)。**r6 が付与した testid/aria を壊さない**こと。

## 受け入れ条件(全 GREEN まで継続。停止禁止)
1. SessionViewer.tsx を分割: 9 tab(transcript/tools/skills/subagents/annotations/findings/raw/stats) の描画を別 component へ、renderRow/resolveEvidence/turnRollups を hook/lib へ抽出。**変更/新規ファイルは各 ≤500 行**。
2. e2e: scratch DB で `pnpm -F web exec playwright test` が **106 全 GREEN**(testid 不変)。N1: 任意の testid を 1 つ消すと該当テスト RED。
3. `pnpm -F web exec tsc --noEmit` GREEN / `pnpm -F web build` GREEN。
4. **merge 前ゲート**: `node rubrics/run.mjs --changed <変更path...>` が exit 0(file-size/e2e-decoupling が GREEN)。
## やらないこと
- スタイル変更(r4)・機能変更・props 契約の破壊。
## norms
design/engineering-norms.md N1–N8。最初に pnpm install。全 GREEN + git commit([r7]) まで継続。push/merge しない。
