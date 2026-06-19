# Lathe Design System — 決定の正本 (SSOT)

> status: building（2026-06-19 着手）/ 方向: **hybrid（ユーザー確定 2026-06-19）**
> 全 UI 判断を **説明可能** にする rationale SSOT。「なぜこの要素か・なぜこの位置か・なぜこの段組/行順か」を
> 連鎖で辿れるようにし、機械検査できる部分は `rubrics/` に束ねる。observability-dense（情報密度が高い）UI ゆえ、
> 任意配置だと回帰が目視でしか拾えない（実際 2026-06 に段差/詰まり/truncation/非対称トグルが連発）→ 決定の正本が要る。

## 方針：hybrid（as-is baseline → design.md 原則を target → ADR で進化）

- **as-is（baseline）**: 現行 UI の全判断を本 DS に説明可能化し、既存 rubric に束ねる（＝今そこにある決定の「なぜ」を辿れる状態にする）。
- **target（北極星）**: `design.md`（Design Brief、新規設計の要件・原則）の **Founding 原則** を到達目標とする。
- **進化**: as-is と target の乖離は **1 件ずつ ADR（`adr/` + `90-decisions.md`）で意図的に変更**する。現行は「暫定実装」なので、ratify（追認）か deliberate change（意図的変更）かを ADR で宣言する。
- これにより「説明可能性（今）」と「clean-slate の意図（design.md）」を両立させる。

## 層マップ

| 層 | 中身 | 正本ファイル | 状態 |
|---|---|---|---|
| Principles | 非交渉原則＝決定フィルタ（棄却ルール付き） | `00-principles.md`（予定。`ui-design-language.md` の原則節＋`design.md` Founding 原則を昇格・統合） | 未（cross-link: ui-design-language.md / design.md §2） |
| Foundations / Tokens | token → 使用面の why | SSOT=`apps/web/app/design-system/tokens.css` / 索引=`10-foundations-tokens.md`（予定） | tokens.css が SSOT |
| **Elements** | 要素ごと anatomy + when-to-use/when-not + states | `20-elements.md`（本 commit）。anatomy 正本=実装 doc-comment | **着手（要素決定表）** |
| Patterns | 合成と **選択ルール**（どれをいつ） | `30-patterns/*.md`（予定。唯一の新規執筆） | 未 |
| Region rationale | なぜここ・なぜこの段組・行順 | `40-regions.md`（予定。`layout-architecture.md` を改名吸収し why 列追記） | 未（cross-link: layout-architecture.md） |
| Decision records | 採用経緯・棄却案・as-is⇄target 乖離 | `90-decisions.md`（予定。`adr/` + 各 rubric の `origin` を DS 視点で索引） | 未（cross-link: adr/） |

build 順（海を沸かさない）: ① 本 INDEX（rule⇄rubric⇄origin 索引＝新規執筆ゼロ）→ ② 要素決定表 → ③ regions に why 列 → ④ principles/tokens 昇格 → ⑤ patterns 選択表（唯一の新規思考）。約 9 割は既存（rubric.origin / 実装 doc-comment）の組み立て直し。

## rule ⇄ rubric ⇄ origin（機械半分の索引）

機械検査できる DS rule は `rubrics/` が「文書化した rule の機械半分」。説明可能 ≠ 全部強制（taste は gate 化しない＝Goodhart 回避）。

| rule（what） | 機械 | rubric / 検査 | origin（なぜ＝事故） |
|---|---|---|---|
| スタイルは単一系（旧 globals.css→0、二重定義を作らない） | ✅ | `apps/web/styling/ds-v1-single` | DS v1 移植、二重 token/クラス衝突の解消 |
| 色系プロパティの値は token から取る（生 hex 禁止） | ✅ | `apps/web/styling/token-consistency` | 第二スタイル系・token ドリフト防止 |
| DS CSS は構文妥当（コメント/ブレース閉、本文に `*/` 禁止） | ✅ | `apps/web/styling/css-valid` | breadcrumb コメント `*/` 早期閉じで build 破壊、gate がすり抜けた事故 |
| header chrome は WorkareaHeader 単一所有（surface は band を描かない） | ✅ | `apps/web/layout/authority` | 段差＝各 surface が自前 header 帯を 3 種描いた（権威不在） |
| 描画後レイアウト不変条件（はみ出し/無音切れ/段差/重なり/cramped/狭detail/幅0潰れ）両幅 | ✅ | `apps/web/layout/integrity`（7 surface × 1500/700） | 静的 gate が GREEN のまま段差/詰まり/幅0潰れを出荷した盲点 |
| 折りたたみ UI は一貫した単一 edge toggle で開閉 | ✅ | `apps/web/interaction/panel-reopenable` | Inspector を閉じたら戻れず（報告1）→ ×と別レールの非対称（報告2） |
| 1 ファイル ≤500 行（god-component 防止） | ✅ | `file-size` | 神ファイル化 |
| ソースに CJK を書かない（実装は英語、コメント含む） | ✅ | `sessions.spec` copy-hygiene | 日本語混入 |
| TopBar は project scope + 識別のみ（search/機能ボタン/account を載せない） | ⚠ **未実装** | `topbar-scope-only`（layout-architecture.md に記載のみ、rubrics/ に**ファイル無し**＝doc/impl ギャップ） | scope 軸と機能ナビの混線防止 |
| 配給 6 色は TimeRibbon/minimap/chart のみ・行/バッジは neutral+dot・error red のみ全面 | — taste | （rationale-only。token-consistency は「値が token か」までで「その面で使ってよいか」の意味論は見ない） | 原本の「彩度の洪水」 |
| 数値/時刻/ID は mono+tabular で右揃え固定幅 | — 部分 | layout-integrity が列崩れ（切れ/はみ出し）は捕えるが「mono を使ったか」自体は rationale-only | 計測の規律 |
| UI コピーは中立 micro-label・判定的表示に基準併記・空状態は最小 | — taste | （文言の質・基準の妥当性は judgment。CJK 禁止のみ機械半分） | 煽り/お世辞・基準なき断定 |
| 選択の altitude（scope→TopBar/機能→Rail/sibling view→tabs/即時排他→segmented/補助→Inspector） | — taste | （どの altitude かの判断は設計時 taste。誤用の一部結果＝段差/狭 detail は authority/integrity が事後に捕える） | IA の混線 |

## 同期ルール（doc[なぜ] と rubric[強制] を腐らせない）

既存の **failure→harden ループ**に乗せる。新しい UI 失敗が出たら、`design/ds/` に rule+rationale（棄却した代替案込み）を 1 件追記し、**同時に**対応 rubric を追加/更新する（`origin` に事故経緯）。**文書だけ・rubric だけの片肺 land を禁止**（rule は説明、rubric は強制、二つで 1 セット）。`rubric.origin` が doc⇄gate の結節点（双方向リンク）。rule が変わったら ADR を Superseded に。機械化できない rationale-only rule は DS 文書にのみ残し「これは judgment、gate 化しない」と明示する。

## 単一正本の原則（重複正本を作らない）

token=`tokens.css` / 要素 anatomy=実装 doc-comment / region 契約=`40-regions.md`（現 `layout-architecture.md`）/ 機械 rule=`rubric.json` が各々**唯一の正本**。本 MD 群はそれらを**横断索引＋when/why 語彙を足す薄い層**に徹する（doc-drift 回避）。`architecture.md`（理想状態の正本）からは本 DS を I3 スタイル系の正本として参照させる。

## 関連
- `design.md` — Design Brief（target 原則の正本） / `ui-design-language.md` — 現 VISUAL 標準 / `layout-architecture.md` — 現 REGION 契約
- `20-elements.md` — 要素決定表（本 DS の核） / `adr/` — 決定記録 / `rubrics/` — 機械半分
