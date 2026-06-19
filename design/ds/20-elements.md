# Elements — 要素決定表（when-to-use / なぜこの配置）

> 本 DS の核。「全 UI 判断を説明可能にする」の本体。各要素について **いつ使う / いつ使わない / どこ（region）/ なぜ（配置・段組・行順の根拠）** を書く。
> anatomy（labeled parts）の正本は **実装の doc-comment**（`Surface.tsx` 等）。本表はそれを索引し、when/why 語彙を足す薄い層。
> 「選択の altitude」が一貫した判断軸: **scope→TopBar / 機能 destination→Rail / 同一 entity の sibling view→tabs / 即時・排他・少数の局所トグル→segmented / 補助 metadata→Inspector / 主役の重い情報→master-detail**。

---

## TopBar（brand + 枠なし project breadcrumb selector）
- **いつ**: アプリ全体を scope する「遅い・本物のスコープ鎖」があるときだけ。`Lathe / All projects ▾`、session 時に第3 segment。
- **いつ否**: search/⌘K・Run/Find/Reset・フィルタ・account/user・枠付きコントロールは載せない（→ WorkareaHeader.actions か Rail）。multi-user 由来の org/権限も無い。
- **どこ**: shell 所有・最上部全幅（root layout）。
- **なぜ**: 裏取り（Langfuse/Grafana/Vercel/Datadog/Sentry）で「遅いスコープ階層→top breadcrumb、揮発する操作→page header」。project は session より**遅く変わる scope**だから leading の breadcrumb 位置が正しい。Rail に置くと「機能ナビ」と「scope 軸」が混線する。枠なしは「scope 選択と識別だけ」を視覚宣言（Langfuse 流）。
- **enforce**: `topbar-scope-only`（⚠ 未実装＝doc/impl ギャップ、要新設）。

## Rail（section nav: Sessions / Findings / PR / Overview）
- **いつ**: top-level の機能 destination（横断軸）への遷移。現在地を常時ハイライト。将来 Harness/Evals/Datasets/Scores も同列。
- **いつ否**: session に紐づく view（Transcript 等）は置かない（→ tabs）。entity 単位の操作・揮発する action も置かない。
- **どこ**: shell 所有・左 264px 固定レール（root layout）。
- **なぜ**: 選択の altitude＝機能は最上位 destination → 永続ナビ(Rail)。横断軸(Findings)と session 軸を物理分離。左ナビは類似 observability アプリの IA に倣う（学習可能性）。Sessions は `/` exact match（deep link は同画面の別 state）。

## WorkareaHeader（Surface: title + meta + actions + tabs）
- **いつ**: 全 surface の header chrome の唯一の出口。surface は `{title, meta?, actions?, tabs?}` を流し込むだけ。surface 機能 control（search/sort/filter/project picker）は actions(trailing) に。
- **いつ否**: surface が自前で header 帯（`.lds-page-head`/`.lds-session-bar`/`.pr-hero`）を描かない。固定高さ(`--appbar-h`)を上書きしない。
- **どこ**: shell・単一 component（`Surface.tsx`）。各 Body の上。
- **なぜ**: 段差の根本原因＝各 surface が自前 header 帯を 3 種描きレイアウト権威が無かったこと。単一 component に集約し高さ+body geometry を固定すると「段差が構造的に不能」。anatomy: titles(leading)/spacer/actions(trailing) は **anchoring 規則**で配置（pixel でなく leading/trailing なので意味が固定）。
- **enforce**: `layout/authority`（自前 band の grep 0）+ `layout/integrity`（段差/重なりを描画後に）。

## tabs（SessionTabs: Transcript/Tools/Git/Skills/Subagents/Annotations/Findings/Raw/Stats）
- **いつ**: 1 つの session という**単一 entity に紐づく sibling view 群**の切替（同一画面・別 state）。WorkareaHeader の tabs slot 直下。annotations/findings は count バッジ付き。
- **いつ否**: 横断一覧（全 session の Findings 等）を session タブに同居させない（→ Rail の一級軸）。tab 数が少なく即時排他なら segmented を検討。
- **どこ**: WorkareaHeader 直下の tabs slot（Surface 所有）。
- **なぜ**: 選択の altitude＝同一 entity 内の view 切替は tabs（Rail の destination 遷移より下位）。横断軸を session タブに混ぜると「今どこ」が壊れる。以前 tabs 行が metrics 帯と別 indent で段差源だった → Surface slot に統一して同一 indent。`role=tablist/tab`+`aria-selected` で dual-operability。

## segmented control（例: Pretty[md] ⇄ Raw 切替）
- **いつ**: 小さく相互排他なオプション集合を即時切替（2〜4 個、view 全体でなく **1 要素の表示モード**）。
- **いつ否**: 3+ の大きな sibling view（→ tabs）・遷移を伴う destination（→ Rail）には使わない。option が増えたら tabs か select へ。
- **どこ**: WorkareaHeader.actions か detail pane の io-head 内（局所的）。
- **なぜ**: 選択の altitude の最下層＝即時・排他・少数の局所トグル。tabs（section 切替）と段違いの「軽さ」を視覚で表す（高さ 20px・active のみ panel 背景）。誤って tabs を使うと「画面が切り替わる」誤認を生む。

## master-detail（list + 広い detail）
- **いつ**: transcript の event / Findings / PR のように「一覧から選んで**広い詳細を読む**」フロー。detail = Input/Output 主役（md preview が読める幅）＋ metadata 列。
- **いつ否**: 重要情報を狭パネルに押し込まない（旧 narrow Inspector は廃止）。一覧だけ/詳細だけで完結する単純画面には使わない。
- **どこ**: surface Body 内（list 左 + detail を広く右）。Findings/PR/transcript で同型。
- **なぜ**: transcript の event 詳細は**情報の重さが大きい**（Input/Output・code・md）。「dense は detail へ・list は compact」原則から detail は list より広く（`detail-wider-than-list` 不変条件）。狭い Inspector に押し込むと読めない（2026-06-18 ユーザ決定: 案 ii で narrow Inspector 廃止）。Polaris の resource-index→resource-details 型。
- **enforce**: `layout/integrity`（detail-wider-than-list / 幅0潰れ）。

## Inspector（折りたたみ右パネル + 単一 edge toggle `lds-rp-toggle`）
- **いつ**: **主役でない補助的な metadata/context** を、本文の幅を保ったまま随意に出し入れしたいとき（`Surface.rightPanel`）。VS Code/Langfuse の side-panel 型。
- **いつ否**: 主役情報（Input/Output 等）には使わない（→ master-detail）。**閉=× / 開=別レール のような非対称 control を作らない**。
- **どこ**: surface Body の右端（main column + collapsible aside）。
- **なぜ**: master-detail との使い分け＝detail は「主役・常時広い」、Inspector は「補助・折りたためる」。開閉は**同一操作・同一位置の 1 つの edge toggle**に統一（chevron + aria-label を state で反転）。理由: × で閉じると reload まで戻れず（報告1）→ 応急 reopen レールで「閉=× / 開=別レール」の非対称破綻（報告2）→ 単一 edge tab に統一。
- **enforce**: `interaction/panel-reopenable`（collapse↔expand が一貫トグルで成立）。

## session/list TABLE row（可変 title 1fr + 固定 metric 列、responsive floor `minmax(220px,1fr)` + scroll）
- **いつ**: 同種 entity を多数・比較可能に並べる（Sessions: Session 1fr / Runner 132 / Tokens 92 / Turns 64 / Errors 72 / Cost 84）。head sticky・hover・数値は mono+tabular。
- **いつ否**: 異種・少数・自由形は cards。title を固定幅にしない（可変だから 1fr）。zebra は使わない（hairline 区切りで十分）。
- **どこ**: surface Body（full-width work area。左 rail には押し込まない）。
- **なぜ**: **行順＝責務で決まる**。可変長の見出し(Session)は leading の伸縮 1fr、整列したい数値 metric(tok/cost)は trailing の固定幅列＝実質テーブル列。計測の規律(mono+tabular+右揃え)で桁揃え。responsive floor の理由: 固定列合計 + 1fr が ~700px work area を超えると 1fr が 0 に解決し最重要列(title)が width:0 で**無音消失** → `minmax(220px,1fr)`+scroll で floor。
- **enforce**: `layout/integrity`（幅0潰れ Family 8 / detail 幅 / はみ出し）。

## chips / badges / buttons（neutral + 小 dot、runner pill、cost/anomaly chip）
- **いつ**: 行内の分類・状態・メトリクスのコンパクト表示。分類色は「小さな dot のみ」、本体は neutral。判定的表示(cost 異常)は基準明示(`>5× runner median` 等)を併記。
- **いつ否**: 行・バッジに配給色を全面塗りしない（色配給制）。基準のない数字を見出しに昇格させない。煽り/お世辞コピーを書かない。
- **どこ**: TABLE row 内・detail metadata・WorkareaHeader.actions。
- **なぜ**: 色配給制＝配給 6 色は TimeRibbon/minimap/chart に限定、行/バッジは neutral+dot、error red のみ全面特権。原本の「彩度の洪水」の恒久対策（彩度を全面に撒くと密度の高い observability 画面が読めない）。判定には根拠併記（基準なき断定を見出しにしない）。
- **enforce**: `token-consistency`（色値の出所=var(--token)）。色**面**の判断は rationale-only（taste）。

## TimeRibbon + charts（配給 category color）
- **いつ**: 時系列・分布・カテゴリ別の可視化（**ここでだけ**配給 6 色を使ってよい）。bar=slate / line=sage に統一、25/50/75% hairline gridline、凡例・軸は mono。
- **いつ否**: 行・バッジ・テキストに chart の配給色を流用しない。25/50/75 以外の濃い gridline を引かない。
- **どこ**: Overview / Stats surface の Body、transcript の minimap。
- **なぜ**: 色配給制の「色を使ってよい唯一の面」。category を色で区別する価値が密度のコストを上回るのは可視化だけ（行では dot で足りる）。bar/line 色固定 + gridline 規律で chart 間の統一感。配給色は `--cat-*` token から取り行へ漏らさない。

## markdown renderer（detail の Pretty[md] 表示）
- **いつ**: Input/Output 等の本文を可読 render（Pretty）。code 強調・コピー可。Raw との segmented 切替を持つ。md preview が読める幅(detail 側)で出す。
- **いつ否**: 狭い list/Inspector に押し込まない（幅が要る → detail）。UI コピー文言を md 本文の砕けた言い回しに引きずられない（製品コピーは中立 micro-label）。
- **どこ**: master-detail の detail pane（Input/Output 主役領域）。
- **なぜ**: md は読むのに幅が要る→情報の重さが大きく detail 側へ（master-detail の根拠と同じ）。Pretty⇄Raw は局所トグルなので segmented。長い行は隠さずペイン内横 scroll（無音切り捨て禁止）。

---

## 機械半分の地図（要素 → enforce）
- TopBar → `topbar-scope-only`（未実装）/ WorkareaHeader・master-detail・table row → `layout/authority` + `layout/integrity` / Inspector → `interaction/panel-reopenable` / chips・charts → `token-consistency`（値の出所のみ。色面は taste）。
- 機械化しない（judgment、Goodhart 回避）: 色の使用**面**、コピーの質・基準、選択の **altitude** 判断。これらは本表の「なぜ」で説明するに留め、gate 化しない。
