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
## Generated Reference

Source files: `apps/web/design-system/tokens.css` and `apps/web/design-system/contracts/*.contract.json`.

### Spacing Scale

| Token | Value |
|---|---|
| `--sp-0` | `0` |
| `--sp-4` | `4px` |
| `--sp-8` | `8px` |
| `--sp-12` | `12px` |
| `--sp-16` | `16px` |
| `--sp-20` | `20px` |
| `--sp-24` | `24px` |
| `--sp-32` | `32px` |
| `--sp-40` | `40px` |
| `--sp-48` | `48px` |

### Color / Semantic Tokens

| Group | Tokens |
|---|---|
| surface | `--bg`=`#f7f8fa`<br>`--bg-sunken`=`#f0f2f5`<br>`--panel`=`#ffffff`<br>`--panel-2`=`#fafbfc`<br>`--panel-hover`=`#f3f5f8`<br>`--sidebar-bg`=`#f7f8fa`<br>`--surface`=`var(--panel)`<br>`--surface-hover`=`var(--panel-hover)`<br>`--surface-raised`=`var(--panel-2)` |
| border / chrome | `--border`=`#e0e4ea`<br>`--border-faint`=`#eaecf1`<br>`--border-strong`=`#c3cad3`<br>`--divider`=`var(--border)`<br>`--scrollbar`=`#d4d9df`<br>`--scrollbar-hover`=`#bfc6cd` |
| text | `--muted`=`#555f6d`<br>`--muted-2`=`#626c7c`<br>`--on-accent`=`#ffffff`<br>`--text`=`#161d27`<br>`--text-body`=`var(--text-soft)`<br>`--text-label`=`var(--muted)`<br>`--text-soft`=`#333d4c` |
| accent / focus | `--accent`=`#3b6fd4`<br>`--accent-ring`=`rgba(59,111,212,.30)`<br>`--accent-strong`=`#2e5fc2`<br>`--accent-weak`=`#edf2fb`<br>`--focus-ring`=`var(--accent-ring)` |
| status | `--add-bg`=`#eef7f1`<br>`--add-bg-strong`=`#dcefe3`<br>`--add-marker`=`#55a87c`<br>`--add-text`=`#2c7a50`<br>`--amber`=`#b08530`<br>`--amber-bg`=`#f9f3e6`<br>`--amber-chip`=`#efe2c4`<br>`--amber-text`=`#8a6113`<br>`--del-bg`=`#fdf0ef`<br>`--del-bg-strong`=`#f6dcd9`<br>`--del-marker`=`#d97063`<br>`--del-text`=`#b8453a`<br>`--gray-chip`=`#eef0f3`<br>`--gray-chip-tx`=`#646e7e`<br>`--green`=`#3d8f63`<br>`--green-bg`=`#ecf5f0`<br>`--green-chip`=`#d9ece2`<br>`--green-text`=`#2c7a50`<br>`--red`=`#d64545`<br>`--red-bg`=`#fdeceb`<br>`--red-chip`=`#f7d8d5`<br>`--red-text`=`#b42318` |
| category / data | `--cat-error`=`#d64545`<br>`--cat-file`=`#c2984f`<br>`--cat-git`=`#569cbd`<br>`--cat-message`=`#6982bd`<br>`--cat-subagent`=`#9079c9`<br>`--cat-tool`=`#5fa07b`<br>`--cat-uncertain`=`#9aa3b0`<br>`--chart-bar`=`#6982bd`<br>`--chart-line`=`#5fa07b`<br>`--json-key`=`#6b5fa8`<br>`--json-num`=`#3a6ea8`<br>`--json-str`=`#3d7a55` |
| event alias | `--c-assistant`=`var(--cat-subagent)`<br>`--c-bash`=`var(--cat-tool)`<br>`--c-commit`=`var(--cat-git)`<br>`--c-edit`=`var(--cat-file)`<br>`--c-error`=`var(--cat-error)`<br>`--c-hook`=`var(--cat-uncertain)`<br>`--c-memory`=`var(--cat-git)`<br>`--c-read`=`var(--cat-git)`<br>`--c-skill`=`var(--cat-file)`<br>`--c-subagent`=`var(--cat-subagent)`<br>`--c-test`=`var(--cat-git)`<br>`--c-todo`=`var(--cat-uncertain)`<br>`--c-user`=`var(--cat-message)`<br>`--c-write`=`var(--cat-tool)` |
| kind alias | `--k-command`=`var(--cat-file)`<br>`--k-commit`=`var(--cat-tool)`<br>`--k-edit`=`var(--cat-subagent)`<br>`--k-error`=`var(--cat-error)`<br>`--k-file`=`var(--cat-file)`<br>`--k-git`=`var(--cat-git)`<br>`--k-message`=`var(--cat-message)`<br>`--k-skill`=`var(--cat-file)`<br>`--k-subagent`=`var(--cat-subagent)`<br>`--k-tool`=`var(--cat-tool)`<br>`--k-uncertain`=`var(--cat-uncertain)` |
| runner | `--r-claude`=`#c4522c`<br>`--r-codex`=`#0d8668`<br>`--r-cursor`=`#4969f2` |

### Component Contracts

| Component | Summary | Axes | States |
|---|---|---|---|
| `Badge` | Compact status or count label with optional semantic tone and dot. | `tone`: `default`, `ok`, `warn`, `err`, `neutral`, `accent` | `default` |
| `Button` | Command button for neutral, primary, ghost, and destructive actions. | `size`: `md`, `sm`<br>`variant`: `default`, `primary`, `ghost`, `danger` | `default`, `hover`, `focus`, `disabled` |
| `Checkbox` | Labeled checkbox row with optional trailing content. | none | `default`, `checked`, `disabled` |
| `Chip` | Mono inline chip for hashes, cost, token, and compact metadata values. | `kind`: `default`, `hash`, `cost`, `token` | `default` |
| `ConfidenceChip` | Small confidence label for high, medium, or unattributed evidence confidence. | `level`: `high`, `medium`, `unattributed` | `default` |
| `Icon` | Thin-stroke line icon rendered from the DS IconName set. | `name`: `list`, `findings`, `pr`, `chart`, `messages`, `settings`, `grid`, `stack`, `folder`, `arrowLeft`, `external`, `github`, `branch`, `link`, `plus`, `x`, `send`, `check`, `alert`, `chevronDown`, `chevronRight` | `default` |
| `IconButton` | Icon-only button with a required accessible label. | none | `default`, `hover`, `disabled` |
| `MetricStat` | Compact metric value and label pair for dense headers and stat bands. | `layout`: `stack`, `inline` | `default` |
| `MiniBar` | Compact horizontal magnitude bar with label, track, fill, and value. | none | `default` |
| `Panel` | Bordered content panel with optional header metadata and action slot. | none | `default` |
| `Pressable` | Bare interactive button base for bespoke-styled feature controls. | none | `default`, `hover`, `focus`, `disabled` |
| `RunnerIcon` | Square runner identity glyph with known runner colors and accessible label. | `runner`: `claude-code`, `claude`, `codex`, `cursor` | `default` |
| `SearchInput` | Search field wrapper with built-in glyph and optional keyboard hint. | none | `default`, `focus`, `disabled` |
| `Segmented` | Tablist-style segmented control for small mutually exclusive modes. | none | `default`, `hover`, `selected` |
| `Select` | Native select wrapped in DS chrome with a decorative caret. | none | `default`, `disabled` |
| `Surface` | Work-area surface with standard header, optional tabs, and collapsible right panel. | none | `default`, `hover`, `expanded`, `collapsed` |
| `TabBar` | Horizontal tab bar for switching named views. | none | `default`, `hover`, `selected` |
<!-- generated:end -->
