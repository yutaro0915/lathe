# DS v1 全 surface 移植プラン — globals.css 1008 → 0

> status: in-progress / date: 2026-06-18 / branch: loop/26-ui-shell
> 由来: マッピング workflow `wf_8bb633cf-1a1`（globals.css 所有・DS 不足・e2e 契約の 3 軸調査）。
> 目的: 旧 probe-B スタイル(globals.css)と DS v1 の二重系を解消し**単一系(I3)**へ。6 surface を DS へ縦移植し globals.css を 0 へ単調縮小。

## 規範ゲート（毎スライス・機械照合）

- **ds-v1-single**（I3）: `globals.css` 行数 ≤ ceiling。スライス着地ごとに **auditor(Claude) が ceiling を新行数へ締める**（ratchet）。実装者は `rubrics/` を触らない（N4 no-gate-tampering）。
- **e2e GREEN**: r6 で testid/role/aria/data-* に脱結合済み。各 surface の `apps/web/e2e/*.spec.ts` の契約（testid・data-*・role/aria・computed-style・URL・"count 0" 反証・可視テキスト）を**完全保持**。
- **CJK 禁止**（sessions.spec のソース衛生検査）: `apps/web/components/` `apps/web/app/` 配下の `.tsx/.ts/.css` に日本語/CJK を入れない（コメント含む）。実装者は英語で書く。
- **tsc exit 0 / pnpm lint exit 0 / file-size(I4) / boundaries(I1,I2)**。

## 移植の型（reconcile、単なる移動でなく単一系化）

- (a) DS primitive 等価物がある要素（badge/chip/button/runner/segmented/select/metric/minibar/tabbar 等）→ **DS primitive を採用**し旧クラス使用を撤去。
- (b) 真に bespoke な surface CSS（ribbon/diff line/event row/finding card 等）→ **DS バンドル(`app/design-system/components.css` ＋ 必要なら `components/ds/index.tsx`)へ DS トークンで再実装**。
- どちらも globals.css の当該所有ブロックを削除 → globals.css 縮小。DS バンドルは増えてよい（成長先）。

## 各スライスの担当・手順

実装=Opus（UI=Opus）。隔離なしで本 worktree を単一書き手で順次（globals.css/components.css が共有のため並行不可）。
1. Opus: DS primitive 追加/採用 + surface 貼り替え + 所有 globals.css ブロック削除 + gate(`node rubrics/run.mjs --changed <paths>`)+e2e+tsc 実行、コミットしない。
2. Claude: gate 6/6 GREEN・globals.css 縮小・e2e GREEN・tsc 0 を**独立再実行**し、preview(:3210) で**現物の視覚等価**を確認。
3. Claude: commit（`[26] ds-migrate:<surface>`）+ ds-v1-single ceiling を新行数へ ratchet（別コミット可）。

## 順序付きバックログ（縦スライス・小さい順、fan-in 大は最後）

| # | slice | 所有 globals.css (行) | DS 追加/採用 | e2e 主契約 | 状態 |
|---|---|---|---|---|---|
| 1 | TimeRibbon | .ribbon-* 727-745 (19) | bespoke→components.css | ribbon-track/seg/read/axis/tick, minimap-zoom '+' | 着手 |
| 2 | PullRequestView | .pr-* 239-266 (28) | StatusChip/PrChip・master-detail・hero | pr-list-item[data-active]/pr-hero/linked-session/pr-chip(sessbar) | 未 |
| 3 | DiffViewer FileTree | .filetree/.file-row 293-321 (30) | FileTreeRow・StatusChip(A/M/D/R)・ficon | file-row[data-row-kind/active/file-id]/status-chip/ficon/filetree-head sub | 未 |
| 4 | Subagents tab | .sa-* 448-451,809-872 (51) | sa card/tabbar 再実装 | sa-card/-model/-cost/sa-tab[idx]/sa-detail-stats | 未 |
| 5 | MetricsBar+session-bar+CostChip/banners | .metrics/.lds-session-bar/.kstat 41-56,792-804 + chip banners 926-942,1002-1007 (~46) | HeaderBar(SessionBar)・KStat・Badge/RunnerPill 採用・Banner | sessbar/-title/-stats/kstat/chip[data-jump-kind]/pr-chip | 未 |
| 6 | DiffViewer diff pane + attribution | .diff-*/.attr-*/.linked-event 323-392 (~71)（dead .mini-diff 287-291 / .conf-chip 389-392 撤去） | DiffLine/HunkHeader・LinkedEvent・Banner | diff/diff-hunk[state/id]/diff-toolbar+segmented/step-filter/linked-event(le-turn/meta/jump, le-right=0) | 未 |
| 7 | Overview/Stats analytics | .overview-*/.attn-*/.chart-*/.hbar-*/.stats-* 874-1001 (~110)（dead .stats-table/.usage-* 撤去） | ChartCard/Legend・AttentionPanel/AttnRow・MiniBar(link)採用 | overview-page/-canvas/attn-row[attn-group]/chart-card(≥4)/chart-svg rect/hbar-link[data-model]/big-row, session-rail=0 | 未 |
| 8 | FindingsExplorer + AxisView | .finding(s)-* 462-712 (~192) | MasterDetail・FindingRow・KindChip・VerdictChip・EvidenceCard・EventRow(compact)・Banner/Toast・Textarea | 多数（finding-row/detail/verdict-btn/reason/toast/evidence-card[kind/resolved]/excerpt-pre(pre,overflow auto)/turn-event, layout3 3-track 0-flank, sticky verdict） | 未 |
| 9 | layout 足場 + SessionsSurface 補正 | .lds-layout3/.lds-layout-* /.diff-embed 66-86 + sidebar 140-186 (~69) | lds-work3 layout・list-row | layout3 3-track contract（session host と embedded diff 共有・列番号 1/2/3 不変）/diff-embed | 未 |
| 10 | transcript/timeline + event rows + detail aside | .timeline/.event-*/.detail/.kv/.code-block 187-292,445-446,714-719,747-790,806-807 (~170) | EventRow/EventTypeBadge(category dot)・DetailList(KV)・StatStrip・CodeBlock | timeline/event-row[row-kind/turn/eid/rollup-*]/event-icon[event-kind]/tw-expand/step-timebar/code-block[output]=pre-wrap, kv table=0, annotations-strip=0 | 未 |
| 11 | shared base 撤去 | resets/.panel/.muted/.mono/.empty/.chip/.badge/.btn/.segmented/scrollbars 13-18,88-138,721-725 (~80) | 全 surface が DS primitive 採用済を確認後、旧 base を削除 → globals.css ≈ 0 | 全 surface の採用完了が前提 | 未 |

死蔵（移植時に削除）: `.mini-diff`(287-291) `.conf-chip`(389-392)、`.minimap-*`(394-438 要 live 確認、TimeRibbon に置換済みなら削除可)、`.stats-table/.st-*/.usage-*`(現レンダラ無し)。

## 関連

- 規範ゲート: `rubrics/`（ds-v1-single 他）。運用: `skills/lathe-loop`。理想状態: `architecture.md`(I3)・`ui-design-language.md`。
- マッピング元データ: workflow `wf_8bb633cf-1a1` の出力（所有ブロック行範囲・DS primitive 在庫・per-surface e2e 契約の全文）。
