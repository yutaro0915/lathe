---
id: 20
title: Findings 軸の左空白バグ hotfix（実ブラウザ + スクショ検証必須）
status: in-progress
assignee: codex (/goal loop)
depends_on: []
estimated: small
workflow: hotfix
audit: B
bound: 20 turns / 2h
---

## 症状（2026-06-12 ユーザー確認・スクショあり）

`/findings`（cross-session 軸、global nav）で、findings リスト + 詳細パネルの**左側に大きな空白
（おおよそ 1 カラム分、~300-380px）が出る**。リスト（340px）も詳細も右にずれている。先行の
blank-fix（`.findings-axis-main{grid-column:1}`）を merge 済みにもかかわらず**再発 or 未修正**。
先行 e2e は「finding 選択で `.findings-md-grid` の left が一定」しか見ておらず、**全選択で一様に
左空白が出ても「一定」で通る**盲点があり見逃した。

## 必須の進め方（ユーザー厳命）

- **実ブラウザ + スクリーンショットで再現・検証する**。e2e のアサーションだけで「直った」と
  しない（design/audit-protocol.md 原則 8）。
- 推測で直さない。**実測**（要素の `getBoundingClientRect` / computed `grid-template-columns` /
  スクショ）で根因を特定してから直す。

## やること

1. **再現（ブラウザ + スクショ）**: production build を起動（`DATABASE_URL=postgres://lathe:lathe@localhost:55432/lathe pnpm -F web build && pnpm -F web start -p <port>`）し、playwright で実ブラウザを開いて `/findings` を表示 → **スクリーンショットを保存**（例 `/tmp/findings-before.png`）。`.findings-axis-shell`（layout3）/ `.findings-axis-main` / `.findings-md-grid` / `.findings-list` の `getBoundingClientRect().left` と computed `grid-template-columns` を実測し、左空白の正体（どの要素が x>0 から始まるか、どこに幻の列幅が入るか）を JSON で記録。
   - 仮説の起点（裏取りせよ。盲信しない）: `.findings-axis-shell` は `class="layout3 ..."` + inline `gridTemplateColumns:"minmax(0,1fr)"`。`.layout3` 既定は 3 列。inline override が効いていない / 別の親（GlobalNav 後のラッパ・page レイアウト）が幅を食っている / `loading.tsx`（#8 perf で追加）や page.tsx の並列 fetch ラッパが構造を変えた、等。**最近の merge（#8 perf の page.tsx / SessionViewer 変更、chat 撤去の globals.css）との干渉も疑う**。
2. **修正**: 左空白・横ずれが**全 finding・全 viewport 幅（≥1100px）で出ない**よう最小修正。グリッド左端が axis コンテナ左端に一致すること。design/ui-design-language.md（observability-dense・minmax(0,…) 規律）厳守。
3. **検証（ブラウザ + スクショ、これが本体）**: 修正後に再度実ブラウザで `/findings` を開き **スクショ保存**（`/tmp/findings-after.png`）。複数 finding を選択し、各状態で `.findings-md-grid` の left が **axis main の left とほぼ一致（差 ≤ 2px）** かつページに横スクロールが無いことを実測。session viewer 内 Findings タブも同様に確認。
4. **回帰テストを正しく書き直す**: 既存 e2e の「left 一定」アサーションを、**絶対位置**アサーションに置換 — `.findings-md-grid` の left が `.findings-axis-main`（または viewport コンテンツ左端）と差 ≤ 2px、かつ `document.scrollingElement.scrollWidth <= clientWidth + 1`。複数 finding 選択でいずれも成立すること。

## 受け入れ条件（すべて機械検証 + ブラウザ実測）

| # | 条件 | 検証 |
|---|---|---|
| 1 | 左空白なし | ブラウザ実測: `.findings-md-grid` left ≈ axis main left（≤2px）。before/after スクショ添付 |
| 2 | 横スクロールなし | `scrollWidth <= clientWidth + 1`（複数 finding 選択で） |
| 3 | session viewer 側も健全 | session タブの Findings でも左空白なしを実測 |
| 4 | 回帰テスト是正 | e2e を絶対位置アサーションに置換、相対不変だけに頼らない |
| 5 | 既存ゲート | build / `E2E_PORT` 指定で e2e 全件 GREEN / coverage（再 ingest 後）GREEN |

## Loop 運用

- 作業ブランチ: `loop/20-findings-blank-hotfix`（main から分岐、worktree `/tmp/lathe-blank2`）
- e2e は `E2E_PORT=<空きポート>` で起動（3211 競合回避、#9 で env 対応済み）
- スクショは `/tmp/findings-before.png` / `/tmp/findings-after.png` に保存し、最終報告でパスと実測値を提示
