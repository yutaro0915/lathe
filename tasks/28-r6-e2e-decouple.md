---
id: 28
title: r6-e2e-decouple — e2e を getByRole/getByTestId へ移行し surface 別に分割（I5）
status: in-progress
workflow: loop
audit: A
estimated: large
bound: 40 turns
depends_on: []
assignee: codex
---
## What
design/convergence-plan.md r6。e2e の CSS 子孫セレクタ依存（412 locator・99% CSS子孫）を解消し、r7/r4 の前提を作る。**挙動・見た目・ロジックは変えない**（testid/role 付与とテスト書き換えのみ）。

## 受け入れ条件（全 GREEN まで継続。途中停止禁止）
1. e2e 実行環境を用意（PROTOTYPE.md / playwright.config 参照。Postgres を `docker compose -f docker-compose.dev.yml up -d --wait` で起動、E2E_PORT 指定）。**移行前に現行 e2e を実行し pass 数をベースライン記録**。
2. e2e が選択する要素に `data-testid` か ARIA role を付与（`components/ds/*` と各 surface の主要要素）。コンポーネントのロジック・スタイルは変えない。
3. `e2e/app.spec.ts` の CSS 子孫セレクタ（`.locator(".../...")`）を `getByRole`/`getByTestId` へ全面移行。
4. `app.spec.ts` を surface 別へ分割: `e2e/{sessions,session-viewer,findings,diff,stats,pr}.spec.ts`。各 ≤800 行（.oxlintrc.json の *.spec.ts cap=800）。
5. 移行後、全 e2e が GREEN（ベースラインと同数以上・カバレッジ不変）。surface spec の `grep -c '.locator("\.'` が 0。**N1 反証**: testid を 1 つ消すと該当テストが RED になることを確認。
6. `app.spec.ts` を削除し、`.oxlintrc.json` の grandfather から app.spec.ts を除去。
7. `pnpm -F web exec tsc --noEmit` GREEN / `pnpm -F web build` GREEN。

## やらないこと
- SessionViewer 等の分割（r7）・スタイル変更（r4）はしない。testid/role 付与とテスト書換のみ。

## norms
design/engineering-norms.md N1–N8。各項目 GREEN でも停止せず全項目 GREEN + git commit まで継続。push と main/loop への merge はしない。

## r6 修正（前回未達・重要）
前回[r6]は data-testid をコンテナに付けたが leaf 選択が CSS クラス依存のまま（例 `[data-testid="tabs"] [class~="tab"][class~="active"]`, `[class~="session-item"]`, `[class~="sessbar-title"]`）。r4(styling) が旧クラス(.tab/.sessbar-*/.session-item 等)を lds-* へ置換すると e2e が壊れ、脱結合の目的を満たさない。

### 追加受け入れ条件（全 GREEN まで継続）
A. e2e の全セレクタから CSS クラス依存を完全排除。leaf も含め data-testid / getByRole / getByText のみで選択する。assert 対象の leaf 要素(session-item, tab とその active 状態, sessbar-title/stats, event-type-badge, runner-pill 等)にコンポーネント側で data-testid か aria(role/aria-selected/data-state) を付与し、それで選ぶ。状態(active 等)は class でなく aria-selected/data-state で表現。
B. ゲート(必ず 0): grep -rEn "class~=|\.locator\((['\"])\.[a-z]|\[class" apps/web/e2e/*.spec.ts apps/web/e2e/helpers.ts が 0 行。
C. 102 テスト全て GREEN(数維持)。pnpm -F web exec playwright test を実走して全 pass を確認(DB は scratch を使用、N6)。N1 反証: 任意の data-testid を 1 つ消すと該当テストが RED。
D. tsc GREEN / build GREEN。
