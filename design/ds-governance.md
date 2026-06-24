# DS Governance & 移行計画（SSOT フレーム導入・配置 A）

> status: planned / 2026-06-24 / 配置決定 = **A（apps/web 内集約）**
> 方針: Design System を SSOT に、`design.md`/Storybook/Preview/lint/test はその伝達 I/O・観測・検査の子要素として扱う（ユーザー提供フレーム、2026-06-24）。
> 関連: `design/ds-migration-plan.md`（globals.css→0 の旧 DS-replacement、並走トラック）/ `skills/lathe-ui`（手順正本）/ `memory/feedback_systemic_enforcement`。

## SSOT 階層（lathe 版）

```
Design System (SSOT)
├─ Canonical    : tokens(app/design-system/tokens.css) + components/ds(部品) + contracts(新)
├─ Communicable : design/DESIGN.md(生成I/O) + AGENTS / skill lathe-ui
├─ Observable   : Storybook(新) + Preview UI(:3210)
└─ Enforcement  : lint / tsc / Storybook tests / visual regression / a11y
```
実行される値=tokens、実行される部品=components/ds、仕様の説明=DESIGN.md、状態確認=Storybook、逸脱検査=lint/test。**design.md 単体を SSOT にしない**（第二 SSOT 化を避ける）。

## 配置 = A（apps/web 内集約）の根拠（確定）
UI consumer は apps/web の 1 つ（agent は headless、OSS でも UI 1 app）＝packages 化の再利用 payoff が無い。最小 churn・フレームの既存パス（design-system/＋components/ui の 2 dir）と一致。**昇格トリガー**: 2 つ目の UI consumer か OSS で DS 単独配布が要る時 → packages/ へ spin-out（機械的・1 回）。

## 現状（done / gap）
| 層 | 要素 | 状態 |
|---|---|---|
| Canonical | tokens(4px grid・色・明暗) | ✅ |
| | components/ds(primitive 15) | 🟡 Surface/Step/DiffViewer/TimeRibbon が ds 外＝要集約 |
| | contracts | ❌ |
| Communicable | DESIGN.md(生成I/O) | ❌（skill lathe-ui はあり） |
| Observable | Storybook | ❌ |
| | Preview UI | 🟡 :3210 ツールあり・未形式化 |
| Enforcement | lint(spacing hard-0/色 strict-value/ds-reuse judge/tests-accompany)・tsc・boundaries | ✅ |
| | Storybook tests / visual regression / a11y | ❌ |
| | 生 `<button>` 等 forbid lint | ❌ |
| | skill 強制 hook | ❌ |

→ **enforcement 側が先行、observe/communicate 側が空白**のいびつな状態。移行はこの GAP を埋める順に組む。

## フェーズ計画

### P1 — Canonical 完成（部品 SSOT の確立）  ★最優先
- **deliverable**: Surface/Step/DiffViewer/TimeRibbon を `components/ds` へ集約・import 張り直し（9+ 箇所）。生 `<button>/<input>/<select>` を lint 禁止（ds 強制、既存多ければ ratchet）。dep-cruiser 「feature は primitive を ds からのみ／feature 同士の内部 deep-import 禁止」。
- **owner**: 集約・lint・dep-cruiser 編集 = Codex / dep-cruiser ルール設計・rubric = Claude
- **gate**: tsc / dep-cruiser / lint / ds-reuse judge / spacing hard-0 / pr-split / 視覚等価(preview)
- **dep**: なし（直ちに着手可）

### P2 — Contracts
- **deliverable**: `components/ds/<C>/<C>.contract.json`（variants・allowed props・状態）をコア primitive（Button/Input/Select/Badge/Chip/Panel/Surface/Step）に付与。
- **owner**: contract schema・規約 = Claude / 各 contract 記入 = Codex
- **gate**: schema 検証（contract が実 props と一致するかの軽い検査）
- **dep**: P1（部品が ds に集約済み）

### P3 — Observable（Storybook 導入）
- **deliverable**: apps/web に Storybook 導入。各 ds primitive に story（variant/state/edge）。依存方向 Storybook→components/ds→tokens（逆禁止）。
- **owner**: Storybook setup・stories = Codex
- **gate**: storybook build 成功・stories 描画
- **dep**: P1（集約後のクリーンな ds を反映）。P2 と並走可。

### P4 — Communicable（DESIGN.md を生成 I/O 化）
- **deliverable**: `design/DESIGN.md` = generated 領域（tokens 要約＋contracts、`<!-- generated -->`）＋ human 領域（原則・意図・禁止事項）。生成スクリプト（tokens.json＋contracts → generated 節）。
- **owner**: 文書構造・human 領域 = Claude / 生成スクリプト = Codex
- **gate**: 生成節が tokens/contracts と一致（drift 検査）
- **dep**: P2（contracts）

### P5 — Enforcement 仕上げ
- **deliverable**: Storybook interaction test・visual regression（snapshot baseline）・a11y test を関所へ。skill 強制 PreToolUse hook（UI 編集時に lathe-ui を必ず読ませる）。
- **owner**: test setup = Codex / hook 配線・rubric = Claude
- **gate**: visual regression baseline・a11y・hook 発火確認
- **dep**: P3（Storybook）

### P6 — Preview UI 形式化（任意・後回し）
- **deliverable**: 主要導線を View / Container / Preview＋fixtures に分割（UI 先行をコードで再現）。
- **owner**: Codex（feature 改修）
- **gate**: preview で画面遷移確認
- **dep**: P1。優先度低（既存 preview ツールで当面代替）。

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
- 手順正本は `skills/lathe-ui`。strict 運用は P5 の hook で必ず読ませる。

## 旧 migration との関係
`ds-migration-plan.md`（globals.css→0、DS v1 単一系）は **Canonical を綺麗にする並走作業**。本計画はその上に observe/communicate/contracts/strict-enforcement を足して**フレーム全体を完成**させる。globals.css 縮小スライスは P1 と整合する範囲で継続。
