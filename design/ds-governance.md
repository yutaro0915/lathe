# DS Governance & 移行計画（SSOT フレーム導入・配置 A）

> status: planned / 2026-06-24 / 配置 = **A（apps/web 内集約）** ＋ レイアウト是正 = **`apps/web/design-system/` に token＋部品を統合**（旧 `components/ds` は廃止＝DS=factory が両方を出力、2026-06-24）
> 方針: Design System を SSOT に、`design.md`/Storybook/Preview/lint/test はその伝達 I/O・観測・検査の子要素として扱う（ユーザー提供フレーム、2026-06-24）。
> 関連: `design/ds-migration-plan.md`（globals.css→0 の旧 DS-replacement、並走トラック）/ `.claude/skills/lathe-ui`（手順正本）/ `memory/feedback_systemic_enforcement`。

## SSOT 階層（lathe 版）

```
Design System (SSOT)
├─ Canonical    : apps/web/design-system/ ＝ tokens(css) ＋ components/(部品) ＋ contracts/（DS=factory が token と部品を出力）
├─ Communicable : design/DESIGN.md(生成I/O、DS 仕様の人間/AI 向け説明)
├─ Observable   : Storybook(新) + Preview UI(:3210)
└─ Enforcement  : lint / tsc / Storybook tests / visual regression / a11y（逸脱検査）

Dev harness（DS とは別軸・.claude/ に集約）
├─ agents   : implementer / planner / researcher
├─ hooks    : file-size-guard / write-retro /（P5）skill 強制
├─ skills   : lathe-ui（UI 手順の正本）
└─ settings : hook 配線
```
実行される値=tokens、実行される部品=design-system/components、仕様の説明=DESIGN.md、状態確認=Storybook、逸脱検査=lint/test。**design.md 単体を SSOT にしない**（第二 SSOT 化を避ける）。
**skill/hook は DS の一部ではない** ── DS を「使わせ・守らせる」**運用層（dev harness）**であり、`.claude/` に skill・hook・agents・settings としてまとめる（DS の Communicable/Enforcement とは別軸）。

## 配置 = A（apps/web 内集約）＋ レイアウト是正（確定）
UI consumer は apps/web の 1 つ（agent は headless、OSS でも UI 1 app）＝packages 化の再利用 payoff が無い。最小 churn で apps/web 内に置く。**昇格トリガー**: 2 つ目の UI consumer か OSS で DS 単独配布が要る時 → packages/ へ spin-out（機械的・1 回）。

**レイアウト是正（2026-06-24）**: DS は token と components を**出力する factory**。よって両方を 1 つの `apps/web/design-system/` に内包する。旧構成 ── tokens を `app/design-system/*.css`、部品を汎用 `components/` 配下に `components/ds` として間借り ── は **逆さま**（DS が部品を「持つ」のでなく、汎用 components/ に間借りしていた）＝統合する。`app/` の外へ出すのは `app/` が Next routing dir であり DS の住所として不適切なため。

```
apps/web/design-system/          # DS = factory（SSOT、app/ の外）
├─ index.css / tokens.css / components.css / shell.css / chat.css   ← app/design-system/ から移動
├─ components/                   ← components/ds/ から移動（index.tsx・icons.tsx・Surface.tsx …）
├─ contracts/                    （P2）
└─ DESIGN.md                     （P4）
```
import: `@/components/ds` → `@/design-system/components`（`@/`=apps/web で clean。`app/` 配下を避ける）。

## 現状（done / gap）
| 層 | 要素 | 状態 |
|---|---|---|
| Canonical | tokens(4px grid・色・明暗) | ✅ design-system/ へ移動済（P1①） |
| | design-system/ へ token＋部品を統合 | ✅ **P1① 完了**（apps/web/design-system/、import `@/design-system/components`） |
| | components(primitive 15) | ✅ ds に集約（Surface 移動済・Step/DiffViewer/TimeRibbon は feature/shared 維持） |
| | contracts | 🟡 **P2 進行中**（design-system/contracts/<C>.contract.json） |
| | dep-cruiser @/ 解決（境界 gate の前提） | ✅ tsConfig+tsPreCompilationDeps:true（P1④ で発見・修正）＋guard rubric `meta/dep-alias-resolution` |
| Communicable | DESIGN.md(生成I/O) | ✅ tokens+contracts→冪等生成（P4）＋drift gate |
| Observable | Storybook | ✅ 16 story・build 成功（P3）＋story-coverage gate |
| | Preview UI | 🟡 :3210 ツールあり・未形式化（P6 任意） |
| Enforcement | lint(spacing hard-0/色 strict-value/ds-reuse judge/tests-accompany)・tsc・boundaries | ✅ |
| | 生 `<button>` 等 forbid lint | ✅ no-raw-primitives ratchet 58（P1③） |
| | feature 同士の内部 deep-import 禁止 | ✅ dep-cruiser feature-internals-private（P1④、@/ 解決後に稼働） |
| | a11y(axe) / interaction test | ✅ test-storybook 26 tests・a11y 違反 0（P5b）＋CI job |
| | visual regression | ⏸ 保留（方式未決: Chromatic vs local playwright snapshot＋Docker 固定。Storybook 土台あり＝限界コスト小） |
| **Dev harness**（DS と別軸） | .claude/agents・hooks・settings | ✅ |
| | .claude/skills/lathe-ui | ✅（`.claude/skills/` へ移設済み） |
| | skill 強制 hook（UI 編集時に lathe-ui 注入） | ✅ ui-skill-guard.mjs（P5a） |

→ **P1–P5 完了（2026-06-24）。Canonical / Communicable / Observable / Enforcement ＋ skill 強制 hook がすべて稼働**。残るは visual regression（⏸ 保留・方式未決）と Preview UI 形式化（P6・任意）のみ。フレームの本体は完成。

## フェーズ計画

### P1 — Canonical 確立（design-system/ 統合＋部品 SSOT）  ✅ 完了（2026-06-24）
- **deliverable**:
  - ① **restructure**: `app/design-system/*.css` ＋ `components/ds/*` → `apps/web/design-system/`（tokens＋components 同居）。import 張り直し（`@/components/ds`→`@/design-system/components` 13、CSS @import、rubric/stylelint の path）。
  - ② 汎用 primitive 集約: Surface=済（P1a）。Step/DiffViewer/TimeRibbon は分類済＝feature/shared 維持（再掲）。
  - ③ 生 `<button>/<input>/<select>` を lint 禁止（ds 強制、既存多ければ ratchet）。
  - ④ dep-cruiser 「feature 同士の内部 deep-import 禁止」（`feature-internals-private`、稼働中）。
  - ⑤【実行中に発見された前提】dep-cruiser が `@/` を解決しておらず、境界 gate（I1/lib-db/pure-core/④）が `@/` import を素通り＝装飾化していた。`tsConfig` + `tsPreCompilationDeps:true`（root `tsconfig.depcruise.json`）で解決し、guard rubric `meta/dep-alias-resolution` で固定。④ と既存境界 gate はこれの上で初めて本物化（commit e6ebdd9 / 25ff009）。
- **slice**: ① restructure → ③ lint → ④ dep-cruiser → ⑤ @/ 解決＋guard を各 単一 concern（pr-split）。① が他の土台。
- **owner**: restructure(move/import)・lint・dep-cruiser 編集 = Codex / rubric・stylelint path・dep-cruiser ルール設計 = Claude
- **gate**: tsc / dep-cruiser / lint / ds-reuse judge / spacing hard-0 / pr-split / 視覚等価(preview) / `@/components/ds` 残存 0
- **dep**: なし（直ちに着手可）

### P2 — Contracts  🟡 進行中
- **deliverable**: `design-system/contracts/<C>.contract.json`（component/exportedFrom/summary/axes/props/states/notes）を**全 ds primitive**（Button/IconButton/Badge/Chip/ConfidenceChip/Checkbox/SearchInput/Select/Segmented/Panel/TabBar/MetricStat/MiniBar/Surface/Icon）に付与。各 contract は実 TS から抽出（推測しない）。Step は feature component なので対象外。
- **owner**: contract schema・規約・検証 rubric = Claude / 各 contract 記入（抽出）= Codex
- **gate**: contract が schema 妥当（必須 field）＋ `component` が実 export ＋ 全 primitive 網羅（正本リスト ⇄ contracts 機械照合）
- **dep**: P1（部品が ds に集約済み）

### P3 — Observable（Storybook 導入）
- **deliverable**: apps/web に Storybook 導入。各 ds primitive に story（variant/state/edge）。依存方向 Storybook→design-system/components→tokens（逆禁止）。
- **owner**: Storybook setup・stories = Codex
- **gate**: storybook build 成功・stories 描画
- **dep**: P1（集約後のクリーンな ds を反映）。P2 と並走可。

### P4 — Communicable（DESIGN.md を生成 I/O 化）
- **deliverable**: `design/DESIGN.md` = generated 領域（tokens 要約＋contracts、`<!-- generated -->`）＋ human 領域（原則・意図・禁止事項）。生成スクリプト（tokens.json＋contracts → generated 節）。
- **owner**: 文書構造・human 領域 = Claude / 生成スクリプト = Codex
- **gate**: 生成節が tokens/contracts と一致（drift 検査）
- **dep**: P2（contracts）

### P5 — Enforcement 仕上げ  🟡 大半完了（visual regression のみ保留）
- **deliverable**:
  - ✅ **P5a** skill 強制 PreToolUse hook（`ui-skill-guard.mjs`、UI 編集で lathe-ui 手順＋gate を注入）。
  - ✅ **P5b** a11y(axe `checkA11y`)＋interaction(`play`) test = `test-storybook`（26 tests・a11y 違反 0、disable 無し）＋CI job。
  - ⏸ **③ visual regression**（snapshot baseline）= 保留。方式未決（Chromatic 課金 vs local playwright snapshot＋Docker 固定で決定論化）。Storybook 土台あり＝後から限界コスト小。layout-integrity e2e が構造破綻を既にカバー済で緊急度低。
- **owner**: test setup = Codex / hook 配線・rubric = Claude
- **gate**: a11y/interaction = test-storybook（CI job、独立再現済）/ hook = pipe-test 検証済 / visual regression = 方式決定後
- **dep**: P3（Storybook）

### P6 — Preview UI 形式化＋shell/layout の DS 化  → **`design/shell-layout-plan.md` で具体化（2026-06-25）**
- **deliverable**: 主要導線（特に shell: Header/SideNav/AppShell）を View / Container / Preview＋fixtures に分割し、
  layout primitive（Stack/Box/Inline＝枠＝空間の所有者）を ds に追加。shell も DS＋Storybook で presentational 管理。
- **動機**: header/panel/sidebar の構成を established DS から借りたい・現 header 不満・はみ出し/余白の偏りを構造的に防ぐ。
- **owner**: layout primitive API/contract・パターン調査・header 再設計判断=Claude / 実装=Codex / gate=Claude
- **gate**: contract/story coverage・layout-integrity・a11y・e2e（data-testid 維持）。詳細フェーズ S1–S4 は別計画。
- **dep**: P1。Surface で「shell を DS+SB 管理」は実証済（既存）＝拡張。

## 順序と並走
```
P1 ─┬─ P2 ─ P4
    └─ P3 ─ P5
P6 は P1 後いつでも（優先度低）
```
P1 が全ての土台。P2/P3 は P1 後に並走可。P4 は P2、P5 は P3 を待つ。

## 役割分担（恒久）
- **Claude（監査役）**: dep-cruiser/rubric/contract schema/DESIGN.md human 領域/hook 配線/独立監査/merge。
- **Codex（実装）**: 部品集約・lint・Storybook・contracts 記入・test・生成スクリプト。
- 手順正本は `.claude/skills/lathe-ui`。strict 運用は P5 の hook で必ず読ませる。

## 旧 migration との関係
`ds-migration-plan.md`（globals.css→0、DS v1 単一系）は **Canonical を綺麗にする並走作業**。本計画はその上に observe/communicate/contracts/strict-enforcement を足して**フレーム全体を完成**させる。globals.css 縮小スライスは P1 と整合する範囲で継続。
