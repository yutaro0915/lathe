# Lathe Design System — 決定記録（規約 / 意味 / 実現）

> status: building（2026-06-19〜）
> worked example（画面を 1 つずつ意味から導く対話）で **決まったこと** を、3 点セットで永続化する正本:
> **規約（what）/ 意味（why）/ 実現（どう機械・component で担保するか）**。
> これは破棄した as-is base（現画面の写生・px ハードコード）とは別物。`design.md`＝target 原則、本ファイル＝決定した規約＋実現。
> 実現の凡例: 🧩=component で体現 / ✅=既存 rubric で機械強制 / ➕=rubric 候補(未実装) / 📐=doc・taste(機械化しない) / 🔤=語彙 / ⏳=target(未導入)
> **再現性**: 承認済みの画面/部品は「再現可能な現物」として [`mockups/`](./mockups/) に standalone HTML で版管理する（prose だけでは見た目を再現できないため）。**全画面が standalone mockup 化済み（reproducibility parity 達成 2026-06-21、[`mockups/`](./mockups/)、全 11 ファイルをブラウザ描画検証）**: Sessions/Transcript/Tools/Git/Subagents/Findings（D1–D21）＋ Chat（D22–27）＋ PR（D28–30）＋ Overview（D31）＋ SessionViewer 残り tab（D32–35）。各 mockup は実 DB に grounding（実値か illustrative かを top comment で明示）。実 component＋rubric 化（🧩/➕）は実装フェーズで lockstep に行う。

## 全体（cross-cutting）

### D1. 画面 = workarea のみ（shell の TopBar/Rail は画面の定義にも mockup にも含めない）
- 意味: scope(project) と nav(section) は全画面共通の frame。「scope がこの画面に効く」≠「この画面が scope を描く」。混同すると層が壊れる。
- 実現: 🧩 shell(root layout) が TopBar/Rail を所有、画面は `<Surface>` の workarea slot を埋めるだけ。✅ `layout/authority`（surface は自前 header band を描かない＝grep 0）。

### D2. 画面設計は観測の目的から導く（agent 種別で変わる）
- 意味: lathe=coding agent → **outcome / quality / completion** が主、turn 内のミクロ過程は副次。workflow agent(Langfuse) は turn-flow が主目的 → 設計が違って当然。Langfuse を写すのは誤り。
- 実現: 📐 doc・全画面の決定フィルタ（taste、機械化しない）。

## Sessions 画面

### D3. Sessions = 比較リスト（整列した列の table）
- 意味: 「多数の peer を共有次元で**比較**して選ぶ」という意味が representation をほぼ一意に決める（cards/chart は比較に弱く実質負ける）。＝簡単な画面は DS が当たり前を追認するだけで、設計の余地は薄い。
- 実現: 🧩 comparison-list（可変 title=leading 1fr / 固定 metric 列=trailing、responsive floor `minmax(220px,1fr)`+scroll）。✅ `layout/integrity`（幅0潰れ・列崩れ・はみ出し）。

### D4. runner（agent）は icon、text にしない
- 意味: agent 種別は色＋形で一目に。text は識別が遅い。
- 実現: 🧩 runner-icon（色＋monogram、full name は `title`、実ロゴに差し替え可）。📐 doc。

### D5. session = span（期間）ゆえ timestamp 列を置かない
- 意味: session は期間で時点ではない → 適当な時刻表示は**嘘**になる。期間表現は UI が複雑化するので今は出さない。＝**意味の正しさ > 表示の都合**。
- 実現: 📐 doc・principle。

## SessionViewer 画面

### D6. SessionViewer = inline turn drill-down（turn は畳み既定＝全体像、click でその下に詳細展開）
- 意味: Langfuse の「turn+detail 一体スクロールで全体像が掴めない」を構造で解く。畳み既定＝全 turn が見える、click で 1 turn だけその場展開。横 detail pane を持たないので操作も視線も増えない。
- 実現: 🧩 turn-drilldown(accordion)。⚠ **supersedes** 旧 side-by-side wide master-detail（commit cc8f349）＋ `layout/integrity` の `detail-wider-than-list` 不変条件 → 実装時に ADR で差し替え（as-is→target の乖離）。

### D7. 単位語: step（行動の単位）/ event（データ実体）。kind = {thinking, investigate, execute, edit, message}。error は kind でなく横断 state
- 意味: step = agent の reason–act ループの 1 単位（thinking も調査も実行も編集も等しく 1 step）。"action" は狭すぎ（ReAct: thought≠action、tool 呼び出しのみ）。error はどの step にも付く状態。
- 実現: 🔤 語彙。data model の `event`。

### D8. step component は 1 つ・枠は均一（kind は中身だけ＝icon / signal / 均一な detail block の中身）
- 意味: step ごとに枠の形を変える＝1 component を kind 別 N レイアウトに分岐＝**バグの温床・管理不能**。枠を均一にし、kind は data で表現する。
- 実現: 🧩 単一 Step component（kind は icon・signal・detail-block の中身のみ可変、container は不変）。➕ rubric 候補（kind 別の step container を作らない＝component/grep 検査）。

### D9. rubric / eval / 完了の定義（eval/rubric は first view にしない。review・DoD は無い）
- 意味: **rubric**=検証可能な価値判断の単位 / **eval**=rubric に実行環境＋context を与えた use-case / **完了**=その eval が通ること（run が満たしたい条件）。ただし eval を狙わない run もあるので **headline(first view) にしない**。review 状態・DoD は現状の概念に**無い**ので設計しない。
- 実現: ✅ rubric=`rubrics/`（既存）。⏳ eval=未導入（target、枠だけ空ける）。

## SessionViewer の残り tab（Stats / Skills / Annotations / Raw）

> いずれも既存部品の再利用（DS が generative になった証拠）。current-best、実装で調整。

### D32. Stats tab = session 単位の定量プロファイル（Overview の chart/stat 語彙を再利用）
- 意味: 1 run の「測れる形」（cost / token / turn / event composition / file churn / subagent）。Overview の cross-session 集計の session scale 版。
- 実現: 🧩 stat strip ＋ chart grid（per-turn cost/token・event composition・file churn・subagent runs・memory・hooks）= Overview の chart 部品再利用。色配給 D10（error=clean red、+/− は diff 内のみ D13）。データ実在（SessionStatsView、sessions / transcript_events / changed_files）。

### D33. Skills tab = Tools 同型（capability を N 回 = comparison-list 再利用）
- 意味: skill は「使った能力」。Tools（invocation を N 回）と意味構造が同じ → 同一 component。
- 実現: 🧩 comparison-list（D11）、行 click で invocations 展開（D12）。as-is の timeline から target（comparison-list）へ寄せる。データ実在（transcript_events type='skill'）。

### D34. Annotations tab = 時系列の導出フラグ＋ source jump（kind は neutral、error のみ red）
- 意味: provider が transcript から自動生成する「注目すべき瞬間」（error / edit / test / commit）。導出データ（再 ingest で再生成、永続層でない）。各々その step へ jump（D14/D21 attribution）。
- 実現: 🧩 時系列リスト（atSeq 昇順）＋ jump-to-step。kind は neutral ラベル＋小 dot、**error のみ clean red**（D10。as-is の 5 色タグは色配給違反なので是正）。データ実在（annotations 表 4,890 行 / kind 4 種）。

### D35. Raw tab = ground-truth の JSON viewer（escape hatch）
- 意味: 加工前の event そのもの。UI を信じきれない時に源へ降りる trust-but-verify の出口。
- 実現: 🧩 JSON viewer（mono ＋ documented JSON 3-hue palette: key/str/num、D10 の明示例外）＋ copy。選択 step の 1 event / 未選択なら events 配列。データ実在（transcript_events.*）。

## 合成・再利用（composition）

### D11. 「N 個の peer を共有次元で比較」は comparison-list（再利用 component）
- 意味: session でも tool でも意味構造は同じ（peers を共有次元で比較）→ 同一 component を使い回す。peers と列が変わるだけ。新画面は確定部品の合成で組む。
- 実現: 🧩 comparison-list（D3）。Tools tab = D3（list）＋ D6（drilldown）＋ D8（Step）の合成＝新規設計ほぼゼロ。

### D12. list 行の click 挙動は peer の性質で決まる（遷移 vs inline 展開）
- 意味: peer が**自分の destination を持つ**なら **遷移**（session → SessionViewer）。peer が**現 entity の sub-content**なら **inline 展開**（tool → その invocations）。挙動を peer の性質に束ねると、どの list でも一貫する。
- 実現: 🧩 comparison-list の row が `navigate | expand` を取る（chevron の有無で示す）。📐 どちらかの判断は「peer が独立 destination か」で機械的に決まる。

## Git 画面

### D13. diff の +/− coloring は色配給制（D10）の semantic 例外
- 意味: category color ではなく semantic（追加=green / 削除=red）・機能的・普遍。error-red が特権なのと同じ枠。diff renderer の中でだけ使い、行・バッジには漏らさない。
- 実現: 🧩 diff renderer 内のみ。📐 D10 の明示例外として doc 化（taste でなく規則の例外）。

### D14. artifact ↔ step の双方向 attribution
- 意味: 各 hunk / 変更ファイルを「それを産んだ step」に紐づけ、Git ↔ Transcript を双方向 jump（`↗ Turn N · edit`）。coding-agent 観測固有の「変更 → 原因」追跡。
- 実現: 🧩 attribution link（hunk→step / file→step）。データ実在（hunk attribution map）。

### D15. Git view は diff の組織軸を segmented で切替（by step / by file-tree）
- 意味: 同一 diff データを process 軸（step ごとの差分）と artifact 軸（従来のファイルツリー差分）で見せ、読む目的で選ぶ。**両軸とも file↔step attribution を通す**（file 軸では各ファイルにどの step が変えたか、step 軸では各 step がどのファイルを変えたか）。
- 実現: 🧩 segmented control（D の局所・即時・排他トグル要素を再利用）＋ 2 view。diff は unified（side-by-side は狭幅で死ぬので不採用）。

## Subagents 画面

### D16. subagent = 入れ子 session（再帰）
- 意味: subagent は session の入れ子。詳細は親 session と同じ facet（Transcript / Tools / Git の 3 tab）で見る — SessionViewer の部品を再帰再利用する。
- 実現: 🧩 nested mini-session（Transcript/Tools/Git の 3 tab、card 選択で行の下に展開・× で閉）。SessionViewer 部品の再帰利用。

### D17. レイアウト幾何 ＝ 実行幾何
- 意味: 同一階層（同 step ＝並列、順序に優劣なし）＝横並び（3 つ以上は横スクロール）。異階層（異 step/turn ＝逐次、時間的区別が意味を持つ＝結果を受けて次を呼ぶ）＝縦の時系列。並列を縦に積むと「逐次」に誤読させる。
- 実現: 🧩 並列＝横スクロール row（card click → 行の下に単一詳細、再 click で閉）／逐次＝縦。Transcript tab にも propagate（step が並列 fan-out したら横）。📐 機械検査は難しく component 契約＋doc 寄り。

### D18. Subagents tab = view switch `[By step | All]`
- 意味: 同一データを 2 軸で。By step＝実行位置（並列横・逐次縦、D17）。All＝turn/step 非依存の全体集計（何がどれだけ呼ばれたか、comparison-list）。
- 実現: 🧩 segmented `[By step | All]`（tab toolbar・**英語ラベル**、session header には置かない）＋ 2 view。Git の dual-axis（D15）と同型。曖昧語/日本語の UI ラベルは禁止（copy 原則）。

## Findings 画面

### D19. Findings detail の核は Analysis（analyst の構造化推論）
- 意味: finding は body（現象）だけでなく **なぜ重要か・agent が何を意図したか・原因仮説** が価値。実 `analysis` jsonb = impact / agent_intent / cause_hypothesis を detail の核に据える。「lathe agent がどんな推論で出したか」はこの analysis が答え（捏造でなく実データ参照）。
- 実現: 🧩 detail = body ＋ Analysis(impact/agent_intent/cause_hypothesis) ＋ Evidence ＋ 採否。⏳ 将来「agent reasoning trace（analysis に至った推論過程）」を予約（lathe agent 統合後、点線枠）。データ実在（findings.analysis jsonb）。

### D20. 採否ライフサイクル: verdict → backlog
- 意味: 採否は accept/reject ＋ 一言で終わらず、accept は backlog（open/addressed/dismissed）で **行動まで追う**（G2: 有意義 finding = accept ＋ ハーネス編集/task 化）。初の user-action 画面。
- 実現: 🧩 verdict（accept/reject ＋ 一言、finding_verdicts）＋ backlog_status（open/addressed/dismissed）。1-click ＋ 一言 UX。

### D21. evidence は source への jump（論理座標）
- 意味: finding の根拠は session/turn/step/hunk/pr へ jump できる（D14 attribution の一般化、finding ↔ source 双方向）。論理座標で再 ingest 後も再解決、失敗時「根拠は更新された」を明示（隠さない）。
- 実現: 🧩 evidence link（subject_kind ＋ 論理座標）。data 実在（finding_evidence）。kind は色配給で neutral、accepted は dim、confidence は数値。

## 視覚（visual、全画面）

### D10. 色配給制（配給 6 色は TimeRibbon / minimap / chart のみ。行・バッジは neutral+小 dot、error red のみ全面特権）
- 意味: 彩度を全面に撒くと密度の高い observability 画面が読めなくなる（原本の「彩度の洪水」の恒久対策）。色を使う価値が密度コストを上回るのは可視化だけ。
- 実現: ✅ `styling/token-consistency`（色値の出所=var(--token)）＋ 📐 doc（どの**面**で使ってよいかは taste、機械化しない）。

## Overview 画面

### D31. Overview = attention funnel（次にどこを掘るか）、totals dashboard ではない
- 意味: N session 俯瞰の目的は「cost / 無駄 / risk がどこに集中し、次にどこを掘るか」。totals の羅列でなく、優先順位づけた注目先＋trend を出し、各々が該当 axis へ drill（観測目的から導く D2）。既存 OverviewView も funnel 構造＝写経でなく追認。
- 実現: 🧩 Attention（cost outlier G9 / most errors / pending findings の 3 ランク列、row→navigate D12）＋ Trends（cost by runner / cost over time / findings by kind、色配給 D10）＋ comparison-list 再利用。⏳「現時点の最適を選び更新」運用（確定しすぎない）。
- 色の補足（D10 運用則）: 色は「減らす」のでなく「正しい色を配給」する。問題シグナル＝**clean red**（くすんだ赤茶＝bg-tint token の文字流用は不可）、非問題＝neutral。neutral 一色化は可読性を落とすので不可。
- データ実在性（2026-06-21 dev DB 実照合、378 session）: **即表示可** = cost / error / runner / time（median $1.96・max $1,341・claude-code $18.46[n127] / codex $1.21[n217]・error を持つ session 211・最大 82）。**nascent** = findings 系（5 件・全 `failure_loop`・pending 0）→ 枠は置くが充実は運用後。mockup の個別行・件数は illustrative。実運用整備は **deploy 時**。

## PR 画面

### D28. PR 画面の核 = 作成過程（attribution）＋ 成果物の簡易確認（diff）
- 意味: PR は coding agent の outcome。GitHub が深い diff/review を持つので lathe は写さず、**「どの agent 作業がこの PR を産んだか」への逆引き**（D14/D21 の一般化）と、**簡易にコードを確認できる diff** を持つ。深い review・全 diff は IDE/GitHub に委ねる。
- 実現: 🧩 PR detail = ①過程（Produced by = 連携 session の attribution）＋ ②Changed files（inline 展開で簡易コード確認、diff renderer 再利用 D15）＋ Reviews(compact)。PR list = comparison-list（D11）/ 行 click = navigate（D12、PR は独立 destination）。state badge = neutral（D10）/ +/− = D13 / GitHub = 外部正本への jump。データ実在（`pull_requests` / `session_pull_requests` view、design/g1-pr-linkage.md・adr/0006）。

### D29. session⇄PR の連携 strength を隠さず区別
- 意味: 連携は many-to-many で link_method = sha（commit 一致＝精密）/ branch（head_ref 一致＝弱い fallback、取り違えうる）。弱い provenance を強い体で見せない（D21「根拠は更新された」を隠さない精神）。
- 実現: 🧩 sha = 実線 chip＋short sha（ti-link）/ branch = 破線 chip＋"fallback"（ti-git-branch）。data 実在（`session_pull_requests.link_method`）。

### D30（⏳ 予約）. PR の eval/rubric 評価（通過提示）は将来
- 意味: 「この PR がどう評価されるべきか・eval/rubric を通過しているか」を outcome に対し示すのは有効（D9 の rubric/eval/完了 の適用）。ただし**現状その feature は未存在**のため今は UI 化しない。
- 実現: ⏳ target。feature 実装後に「過程・確認」へ評価軸を追加（捏造しない）。

## Chat 画面

### D22. Chat = 2 surface（全面 destination A ＋ 永続 context panel B、agent/thread 共有）
- 意味: 「腰を据えて分析」=全面 A（Rail destination・thread 一覧＋会話）、「今の画面の文脈で随時聞く」=panel B。同一 agent・同一 thread を共有し、B の `↗` で A へ昇格＝同じ会話の連続。別機能でなく 1 agent の 2 表示。
- 実現: 🧩 surface A（/chat route、thread-list＋conversation）＋ surface B（docked 右 panel）。会話/thread/composer を共有。summon 口（常駐/ショートカット/Rail）は ⏳ 未確定（捏造しない）。

### D23. context 付与 = 実 UI component の指定（type 列挙でない）
- 意味: 「見ているものを指す」が最短。作った各 component（session 行 / finding / turn / step / subagent カード / hunk…）がそのまま context handle。type を列挙させるのは誤り。
- 実現: 🧩 ①open/new-thread でそのページ entity を 1 度自動添付 ②画面上の実 component を hover→`+ chat` で添付 ③composer 上部「Add context」→ multi-select picker（**要素名が縦 stack**）④自然言語。context = 具体 element（[[design/phase2-finding-model]] の finding_evidence subject_kind に対応、D21）。

### D24. chat agent は tool 制限・提案まで（適用は人間）
- 意味: 分析特化に保ち coding agent 化させない（ROADMAP 設計境界）。ハーネス改善は文面提案まで、適用は人間。指摘は finding 提出 → 採否（D20）に乗る。
- 実現: 📐 lathe MCP 5 tools のみ（編集/bash なし、[[design/phase2-finding-model]] §6.4）。会話内 `finding として提出` ＋ evidence jump（D21）。⏳ 自己観測の汚染は識別タグで分離（§6.5）。

### D25. context panel(B) は navigation-independent（永続）
- 意味: B は画面遷移で reset/再 bind しない。context は明示添付（open 時 1 度＋クリック）であって nav 追従でない。腰を据えた対話が画面移動で壊れない。
- 実現: 🧩 panel state（thread / 添付 context / scroll）を route 非依存に保持。`persists` を UI で明示。

### D26. 入力域 = 単一枠 composer（atomic component を内包、A/B で再利用）
- 意味: 入力域は単一責務の部品の合成。**入力欄**=文字入力のみ / **stacked context**=添付 context を縦 stack（枠付きの別 component）/ **Add context**=stack 末尾の追加口。これらを 1 つの composer 枠が内包。分解により A でも B でも同一 composer を使い回す。
- 実現: 🧩 composer（単一枠）= stacked-context ＋ Add-context ＋ input-field。surface A/B 共通。➕ rubric 候補（composer 構造の不変＝component 検査）。

### D27（⏳ 予約）. chat 内の生成 UI（その場分析を viz で提示）
- 意味: agent が分析結果をその場生成 UI で提示する機能。**現時点では不要・今後実装**。採用時は「DS プリミティブの合成（色配給 D10・rubric 内）」か「自由生成」かを先に裁可（捏造しない）。
- 実現: ⏳ target。枠のみ予約（今は作らない）。

---
## 運用（doc⇄実現を腐らせない）
新しい決定は本ファイルに **規約/意味/実現** で 1 件追記し、🧩 なら component、✅/➕ なら rubric を **lockstep** で land（片肺禁止）。rubric の `origin` から本ファイルへ相互リンク。機械化しない（📐）ものは「taste、gate 化しない」と明示（Goodhart 回避）。
