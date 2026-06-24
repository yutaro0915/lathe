# Shell & Layout Governance — app shell を DS＋Storybook で管理する（P6 具体化）

> status: planned / 2026-06-25
> 親: `design/ds-governance.md` P6（Preview UI 形式化＝View/Container 分割）の具体化 ＋ layout primitive 追加。
> 動機（ユーザー, 2026-06-25）: header/sidebar/panel の構成を established DS（Atlassian/Carbon/Linear）から
>   借り、shell も DS＋Storybook で一元管理したい。現 header が気に入っていない・panel/sidebar の構成で
>   毎回迷う・step 内 padding のような「はみ出し/余白の偏り」を構造的に無くしたい。

## 原則（なぜこの形か）

ユーザーと確認した 2 段構え（2026-06-25）:

- **枠閉じ込め＝空間の所有権**（はみ出し/偏りの直接の治療）: 枠（layout primitive / Surface / Panel）が
  padding・overflow・min-width:0・整列を**一元所有**し、子は枠を満たすだけ。子が各自で margin を盛らない。
  → step padding 問題のような「はみ出し・内部空間の偏り」を構造的に防ぐ。
- **presentational 化（View/Container 分離）**（強制を効かせる土台）: shell は props だけで決まる見た目に。
  データ取得/routing は container（Storybook 外）。→ Storybook で端ケース（長文・極狭幅・空・大量）を
  隔離観測でき、逸脱を出荷前に潰せる。「純化したから直る」ではなく「純化したから枠閉じ込めを機械的に守れる」。
- **観測＋強制の二重**: Storybook（観測）＋ contract/story-coverage・layout-integrity・no-raw・spacing gate（強制）。

**丸ごと外部 DS は採用しない**（理由は前段議論: lathe の主役 UI は bespoke dense＝外部 DS は供給せず、
identity・重さ・agent-legibility のコスト大）。方針は **パターンは borrow / コードは自前 token で実装 /
難 primitive のみ headless（Radix・React Aria）を自部品で wrap**。

## 現状（grounding, 2026-06-25）

| 要素 | 実体 | DS? | presentational? | Storybook? |
|---|---|---|---|---|
| Surface（work-area の header/tabs/right-panel） | `design-system/components/Surface.tsx` | ✅ | ✅ props 駆動 | ✅ | ← **shell を DS+SB で管理する既存の証明** |
| AppShell（`.lds-shell`/topbar/body/workarea） | `app/layout.tsx`（server, fetch をインライン） | ❌ CSS class | ❌ fetch 直書き | ❌ |
| Header（brand＋project selector） | `app/layout.tsx` の `<header>` ＋ `components/TopBarProjectSelect.tsx` | ❌ | 🟡 selector は props 受け | ❌ |
| SideNav（左 rail） | `components/RailNav.tsx`（client, 自己完結） | ❌ feature | 🟡 route 自前判定 | ❌ |
| layout primitive（Stack/Box/Inline） | **無し**（全て bespoke CSS class） | ❌ | — | ❌ |

→ Surface で「shell を DS＋Storybook で管理」は既に成立済。埋めるべき gap は **(a) layout primitive が無い**、
**(b) Header/SideNav/AppShell が DS 外・data 結合・Storybook 外**。

## フェーズ

### S1 — Layout primitives（枠＝空間の所有者）★最初・taste 不要
- **deliverable**: ds に `Stack`（方向 col/row・token gap・子に min-width:0）/`Box`（token padding・overflow 制御・
  min-width:0・任意 surface 面）/`Inline`（横・wrap・token gap）。containment を**構造で焼く**（min-width:0 を
  忘れられない設計）。contract（+3）＋story（+3、端ケース: 長文 child／極狭幅／overflow）＋DESIGN.md 再生成。
- **owner**: 実装=Codex（**git 操作禁止＝Claude が commit**）/ API 設計・contract schema・gate=Claude
- **gate**: contract-coverage（17→20）/ story-coverage（17→20）/ spacing-from-token 0 / no-raw 0 / tsc / a11y(axe) / test
- **dep**: なし

### S2 — Header（presentational 化＋パターン借用で再設計）
- **deliverable**: `app/layout.tsx` の `<header>`＋`TopBarProjectSelect` → ds `Header`（View, props 駆動）。
  layout.tsx は container（fetch のみ）へ痩せる。Storybook（端ケース: project 多/少・session 選択 有/無・極狭幅）。
  **再設計**: Atlassian/Carbon/Linear の app header パターンを調査 → 自前 token で実装。
- **checkpoint**: 再設計は**視覚 taste＝ユーザー判断**。S1 後にパターン調査結果＋方向案を提示してから実装に入る。
- **owner**: パターン調査・方向判断=Claude（disciplined-research）/ 実装=Codex / gate=Claude
- **gate**: story-coverage / layout-integrity / a11y / e2e（topbar selector の data-testid 維持）/ 視覚（Storybook 端ケース）
- **dep**: S1

### S3 — SideNav（presentational 化）
- **deliverable**: `RailNav` → ds `SideNav`（presentational; nav items＋active を props で受ける View ＋ 現 route
  判定は薄い container）。Storybook（active 各軸・極狭高さ・user footer 有無）。
- **owner**: 実装=Codex / gate=Claude
- **gate**: story-coverage / layout-integrity / a11y / e2e（globalnav data-testid 維持）
- **dep**: S1

### S4 — AppShell（合成＝P6 本体）
- **deliverable**: Header＋SideNav＋workarea 枠を ds `AppShell`（presentational）に合成。`app/layout.tsx` は
  薄い container（fetch → AppShell に props）。Storybook で fixtures による full-page Preview（複数画面状態）。
- **owner**: 実装=Codex / gate=Claude
- **gate**: story-coverage / layout-integrity（shell 全体）/ a11y / e2e 67+（全 data-testid 維持）
- **dep**: S2, S3

### （別トラック・任意）Headless 挙動
- **deliverable**: dropdown/popover/dialog/menu 等の難 primitive を Radix or React Aria で wrap（挙動だけ、
  見た目は自 token）。contract/story/gate は維持。1 つ pilot → 良ければ横展開。
- **dep**: なし（S 群と独立）。優先度は S の後。

## 方法（恒久）

- 各 slice: Codex 実装（**git 操作一切禁止＝divergence 防止、Claude が commit**）→ Claude 独立監査
  （gate GREEN・端ケース・視覚を再実行で確認。Codex の自己報告は信用しない）→ ratchet/coverage 更新
  （別 commit・auditor のみ）→ FF push（`loop/ds-replacement` → `:main` → pull）。
- 純化で壊れる e2e は data-testid 保持で回避。layout-integrity が枠破れ（はみ出し/重なり/詰まり/幅 0 潰れ）を止める。
- **S2 の再設計のみユーザー taste checkpoint** を挟む（他フェーズは自走）。

## 順序
```
S1 ─┬─ S2 ─┐
    └─ S3 ─┴─ S4
headless track は S 群と独立（後回し）
```
S1 が土台（枠の所有者）。S2/S3 は S1 後に並走可。S4 は S2+S3 を待つ合成。
