---
name: lathe-ui
description: lathe の UI を作る・変える・直すときの正本手順。新規コンポーネント、レイアウト/配置変更、styling 修正、余白/cramping 調整など UI に触る全作業で最初に読む。再実装・場当たりパッチを禁じ、design.md → tokens/theme → ds primitive →（Storybook）→ feature 合成 のフローを強制する。
grounded_in:
  - rubric: apps/web/components/ds-reuse-not-reimplement
    verified: "1"
  - rubric: apps/web/components/no-raw-primitives
    verified: "1"
  - rubric: apps/web/design-system/design-md-drift
    verified: "1"
---

# lathe UI 開発フロー（正本手順・ガチガチ運用）

UI に触る前に必ずこれを読む。鉄則は **「instance を個別に直さない。source（共有層）を直す」**。
同じ見た目/挙動の問題が 2 箇所に出たら、それは「共有モジュールが無い/使われていない」サイン。

## 正本の階層（上が source。上を直すと下へ流れる）

1. **設計** — `design/ui-design-language.md` / `design/layout-architecture.md`（何を・どう見せるか＝design.md 層）
2. **token / theme** — `apps/web/design-system/tokens.css`（色・spacing=**4px グリッド**・radius・明暗）。**UI の数値は全部ここから**。生 px / 生 hex は書かない
3. **primitive** — `apps/web/design-system/components/`（Button / Badge / Chip / Select / Panel / TabBar / Surface / Step …）＝再利用部品の**唯一の正本**
4. **（将来）Storybook** — 各 primitive の story。ds を変えたら story を更新＝視覚カタログ＋回帰の目
5. **feature 合成** — `apps/web/components/<feature>/`。primitive と token を**組み合わせるだけ**（独自に部品を生やさない）

## 手順（UI 作業のたびに、上から順に）

1. **既存 primitive を探す**（`design-system/components`）。あれば**それを使う**。
2. **値は token から**（`var(--sp-4..48)` / `var(--c-*)` 等）。生 px・生 hex 禁止。
3. **primitive が無い → ds に足す**（feature 内にインライン定義しない）。1 定義で全箇所に効かせる。
4. **配置 / レイアウト変更 → 既存 component を必ず再利用**。組み直さない。
5. **同じ問題が 2 箇所 → 共有モジュール（component / hook / CSS surface / token）を 1 つ定義し全箇所を寄せる**。「中身が入る器」を定義し、中身は自前 padding を持たせない、式で一発で効かせる。
6. **挙動（展開・選択・scroll 等）は共有フック/状態に集約**。タブごとに再実装しない（1 fix で全タブに効く状態にする）。

## 機械強制（これらが RED = 手順違反。bypass 不可）

- **dep-cruiser**: feature 同士の deep-import 禁止 / primitive は `design-system/components` からのみ
- **lint / grep-ratchet**: ds 等価のある生要素（`<button>` 等）禁止 / `rubrics/apps/web/styling/spacing-from-token`（4px グリッド）/ 色 stylelint strict-value（`token-consistency`）
- **judge rubric**: 既存 component の再実装を検出
- `design.md` は*記述*。実際の担保は上の gate（design.md だけでは縛れない）。

## NEVER
- instance を個別パッチ（場当たり）。同種問題は共有層で直す
- feature に primitive / 箱 / spacing をベタ書き、生要素を手書き
- 既存 component / フックの再実装・コピー
- token を介さない生の数値・色

## ALWAYS
- **ds → token → 合成** の順。新規 UI も配置変更もこのフロー
- UI が増える / 変わる → **ds（source）を直す**
- 変更は実機（preview）で目視＋ gate GREEN を確認
- （Storybook 導入後）ds 変更時に story を更新

関連: systemic enforcement（同種問題は共有 source を直す＝本 skill 冒頭の鉄則）/ `design/ui-design-language.md` / `design/layout-architecture.md` / `rubrics/apps/web/styling/`
