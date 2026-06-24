<!--
  Lathe Design System — DESIGN.md
  これは DS の「説明 I/O」であり第二 SSOT ではない。
  正本は: 値=tokens.css / 部品=components/ / 契約=contracts/*.contract.json。
  下の <!-- generated --> 節は tokens + contracts から自動生成（手編集禁止・scripts/gen-design.mjs が再生成）。
  human 節（原則・使い方・禁止事項）は手書き。drift 検査 rubric が generated 節の同期を機械保証する。
-->

# Lathe Design System

DS は **token と部品を出力する factory**。UI の見た目・挙動の正本はここ（`apps/web/design-system/`）に集約する。

## 階層（human）

```
tokens（値の正本: 色・spacing 4px グリッド・radius・明暗）   ← tokens.css
  ↓ 参照
components（部品の正本: Button / Badge / Panel …）           ← components/
  ↓ 仕様
contracts（部品の machine-readable 契約: variants/props/states） ← contracts/*.contract.json
  ↓ 説明 / 観測
DESIGN.md（人間/AI 向け説明・本ファイル）   Storybook（視覚観測）
```

値は token から、部品は ds から取る。**DESIGN.md は説明であって正本ではない**（第二 SSOT 化を避ける）。

## 原則（human）

- **再利用優先**: 既存 primitive を使う。無ければ ds に足す。feature 内に手書きしない。
- **値は token 経由**: 生 px / 生 hex を書かない（spacing は 4px グリッド token、色は `var(--token)`）。
- **境界**: feature 同士の内部 import 禁止。再利用は ds か top-level 公開層（共有部品・feature entry）経由。
- **単一系**: スタイルは DS v1 単一系（旧 globals.css は 0 へ）。

## 使い方（human）

- 新規・改修 UI は skill `.claude/skills/lathe-ui` の手順に従う（design→tokens→ds→Storybook→compose）。
- 配置変更・再利用では既存 primitive を必ず使う。新しい種類の表示だけ ds に primitive を足す。
- primitive を足したら contract（`contracts/<C>.contract.json`）と story（Storybook）も同時に足す。

## 禁止事項（human、機械強制と対応）

| 禁止 | 機械強制 |
|---|---|
| 生 px の spacing | rubric `spacing-from-token`（hard 0） |
| 生 hex の色 | rubric `token-consistency`（stylelint strict-value） |
| 生 `<button>/<input>/<select>` | rubric `no-raw-primitives`（ratchet） |
| 既存 UI の再実装 | rubric `ds-reuse-not-reimplement`（judge） |
| feature 同士の内部 import | dep-cruiser `feature-internals-private` |
| @/ 依存解決の設定退行 | rubric `meta/dep-alias-resolution` |

<!-- generated:start  ⚠ 手編集禁止 — scripts/gen-design.mjs が tokens.css + contracts/ から再生成。drift 検査あり -->
<!-- generated:end -->
