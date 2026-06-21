# DS 置き換え — 実測後の確定 slice 計画

> grounded by gap-analysis（workflow wck6vtwt3、2026-06-21、現実装 ⇄ mockup ⇄ decisions を 13 画面で実測）。
> [`replacement-plan.md`](./replacement-plan.md) §2 の提案順を、実測で確定したものに更新。基盤（Surface/Layout v2）は Slice 0 で GREEN 済み。
> 各 slice の進め方: **implement（worktree 委譲）→ 多面監査（gate 機械照合＋fidelity＋debt/dead-code＋regression＋no-gate-tampering、監査エージェント並列）→ 監査役（Claude）の diff 最終レビュー → 全通過で採用**。色テーマ差は gap 扱いしない（app は light tokens、mockup の dark は構造仕様）。

## 画面別 conformance（実測）

| 画面 | conformance | 主な gap | ADR |
|---|---|---|---|
| Sessions | minor | D4 runner=text→icon / D5 行に timestamp（禁止）/ D3 Model を列へ | — |
| Stats | minor | D32 stat-strip 無し / D4 subagent 行 runner=text / D10 errors stat 無し | — |
| Annotations | minor | D34/D10 5 色タグ→neutral＋dot（error のみ red）/ 行 1 行化＋jump icon | — |
| Raw | minor | D35 JsonView 3-hue 未配線（flat JSON.stringify） | — |
| Overview | minor | D31 Trends を 3 card に（Cost by **runner** median / over time / **findings by kind**）StatsView 分離 | — |
| Transcript | **major** | D6 side master-detail→inline accordion / D7-8 ~15 type→5 kind＋単一 Step / D10 error=state / D5 gutter 除去 | ✦ detail-wider |
| Tools | **major** | D11 comparison-list（type 集約）/ D12 inline 展開（side inspector 廃）/ D8 Step / D5 / D10 | ✦ detail-wider |
| Skills | **major** | D33/D11 capability 集約 comparison-list / D12 inline 展開 / D5 / D4-10 | ✦ detail-wider |
| Subagents | **major** | D18 [By step\|All] / D17 並列横・逐次縦 / D16 nested 3-tab inline / D4-5-10 | ✦ detail-wider |
| Git | **major** | D15 [By step\|By file]＋unified（split 廃）/ D14 inline attribution / 三分割→single-column | ✦ git-single-column |
| PR | **major** | D28 Changed files 無し / D29 sha-branch strength / D28 過程 attribution / D12 navigate（sidebar 廃）/ D4 | ✦ pr-navigate |
| Findings | **major** | **D19 Analysis 核が完全に無い**（analysis jsonb 未 SELECT）/ D20 backlog_status / D34-10 kind 色 | —（master-detail は維持） |
| Chat | **missing** | D22–D26 全体（/chat route・panel B・composer・tool 制限 agent）UI 撤去済み、data 層は存在 | ✦ chat-reintroduction |

## ADR（gate を変える 4 件、該当 slice と lockstep）

- **ADR-detail-wider-than-list**: sub-content drill-down 面（Transcript D6 / Tools・Skills D12 / Subagents D16）で side/wide detail pane → inline single-select 展開へ。`e2e/layout-integrity.spec.ts` の SURFACES から該当 masterDetail 登録を外し、`integrity/rubric.json` の means を更新。commit cc8f349 を supersede。**Findings は invariant 維持**（唯一の真の list+wide-detail）。
- **ADR-git-single-column**: Git 三分割（FileTree+DiffPane+AttributionPane）→ single-column accordion、split(side-by-side) 廃で unified-only（D15）。integrity の Git 面登録＋三分割 rationale を更新（700px で no-overflow 維持）。
- **ADR-pr-navigate-destination**: PR を独立 navigate destination に（D12/D28）。pr-sidebar/pr-main の master-detail を list route＋detail route に分割。integrity の PR 面登録を更新。
- **ADR-chat-reintroduction**: 撤去済み Chat 面を再導入（D22–D26）。chat_threads/chat_messages（既存・migration 不要）に read/write 再配線。composer-structure rubric（D26）は net-new 追加。

## slice 順（12）

**安い polish 先行（no-gate、de-risk）**
1. **横断 polish** — D4 runner-icon component を 1 つ作り再利用（Sessions/Subagents/Stats/PR/Overview）＋ D10/D34 色配給是正（Annotations 5 色タグ→neutral＋dot、Findings kind dot 中立化、Subagents failed=clean-red 確認）。M / gate なし。
2. **Raw** — JsonView を RawTab に配線（3-hue、nested 再帰対応）。S。
3. **Sessions** — D5 行 timestamp 除去（duration は span なので可）＋ Model を専用列へ。Tokens/Errors 列の去就は owner 判断（自動で消さない）。M。
4. **Stats** — stat-strip（cost/tokens in-out/turns/tools/errors）追加、errors=clean red。M。
5. **Overview** — Trends を 3 card に（Cost by runner median / over time / findings by kind）、共有 StatsView を per-session(D32) と分離。L。

**gate を割る rewrite（ADR 同梱、polish 後）**
6. **Transcript** — D6 inline accordion＋5 kind 派生＋単一 Step component＋error=state＋gutter 除去。L / ADR-detail-wider。
7. **Tools** — type 集約 comparison-list＋inline 展開＋Step、side inspector 廃。L / ADR-detail-wider。slice 6 の Step 部品を再利用。
8. **Skills** — Tools の部品（comparison-list＋Step＋inline）を再利用、capability 集約。M。
9. **Subagents** — [By step\|All]＋並列横/逐次縦＋nested 3-tab（Transcript/Tools/Git 再帰）。L / ADR-detail-wider。slice 6-8 を再利用。
10. **Git** — axis [By step\|By file]＋unified-only＋inline attribution＋single-column。L / ADR-git-single-column。
11. **PR** — navigate 分割＋Changed files（slice 10 の unified DiffViewer 再利用）＋過程 attribution（cost/turns）＋sha/branch strength。L / ADR-pr-navigate。
12. **Findings** — **D19 Analysis 核**（analysis jsonb を type/query/UI に通す）＋ D20 backlog_status＋ D34 kind 中立化。L / gate 維持（master-detail のまま）。
13. **Chat** — 新規（D22–D26）。最後に組み、成熟した Step/comparison-list/jump 部品を再利用。L / ADR-chat。

> Findings は当初 §1 の表で major だが master-detail を維持できるため ADR 不要。順序は 12（Findings）を rewrite 群の後に置く（Analysis は data 配線中心で gate を割らない）。Chat を 13 番（最後）に。
