# 現 UI → 新 DS 置き換え計画（migration plan）

> status: proposed（2026-06-21）。正本の決定は [`decisions.md`](./decisions.md)（D1–D35）、視覚仕様は [`mockups/`](./mockups/)。
> 本書は「現 lathe UI を DS へ置き換える」順序と型の**提案**。フェーズ/工数判断は最終的にユーザー裁可（AGENTS.md: 工数・スコープをユーザー指示なく確定しない）。

## 0. 原則

1. **mockup = 構造仕様、tokens.css = 色の正本**。`mockups/` の dark は承認時の近似プレビュー。実装は `apps/web/app/design-system/tokens.css`（light-canonical）＋ 色配給（D10/D31）。**mockup の hex を移植しない**。mockup から取るのは構造・合成・component・配置・色の「配り方」。
2. **lockstep**: 1 スライス = 🧩 component ＋ ➕ rubric ＋ decision の同時 land（片肺禁止、decisions.md 運用節）。受け入れ = mockup と視覚一致 ＋ 該当 rubric GREEN ＋ e2e ＋ tsc。
3. **worktree 単一 writer**（AGENTS.md）: 各実装スライスは `Agent(isolation:"worktree")` で隔離。main は Claude（監査役）が diff 確認で取り込む。rubric 編集は実装と別コミット（`meta/no-gate-tampering`）。
4. **機能を順番に 1 つずつ**（AGENTS.md）。スライスは独立して GREEN にしてから次へ。globals→0 の ds-v1-single ratchet はスライスごとに締める。
5. **構造変更・乖離は ADR**（AGENTS.md）。下表の「乖離」は実装前に ADR 化（as-is gate を壊すため）。

## 1. 現状 → target 対応（2026-06-21 inventory 実照合）

### A. 既に DS と一致 → 検証のみ
| 項目 | 現状 | 対応 decision |
|---|---|---|
| shell が chrome 所有 | `Surface`（WorkareaHeader/Body/RightPanel） | D1（✅ layout/authority） |
| 観測密度・色配給 | `ui-design-language.md`（observability-dense） | D10/D31（✅ token-consistency） |
| panel 単一 edge toggle | `lds-rp-toggle` 実装済み | D6 panel（✅ panel-reopenable） |
| comparison-list | `SessionsSurface`（Surface 移行済み・proof） | D3/D11 |
| Phase 2 data 一式 | chat_threads/messages・findings.backlog_status・finding_evidence・finding_verdicts **すべて存在** | D19–22 の前提（migration 不要） |

### B. 乖離 → 再構築＋ADR（as-is gate / 実装を変える）
| # | 乖離 | 現状 | target | ADR 論点 |
|---|---|---|---|---|
| B1 | **master-detail 不変条件** | `layout/integrity` が `detail-wider-than-list` を 7 surface×2幅で機械強制（side-by-side 前提） | D6 SessionViewer=inline turn-drilldown（横 detail pane 無し）/ D12 Sessions・PR=navigate。side-by-side を保つのは Findings の list+detail のみ | gate を「side-by-side を強制」から「screen 種別ごとの不変条件（drilldown 対称・navigate・list+wide-detail）」へ改訂。旧 check を超える(supersede)記録 |
| B2 | **Git diff** | `DiffViewer`+`DiffPane`=file-tree 左＋hunk 右の横スクロール | D15 dual-axis segmented [By step \| By file] ＋ **unified diff**（side-by-side は狭幅で死ぬ）＋ D14 file↔step attribution | side-by-side→unified、attribution link 追加 |
| B3 | **Skills tab** | timeline list | D33 Tools 同型 comparison-list（capability を N 回） | 軽微（component 差し替え） |
| B4 | **Annotations tab** | kind 5 色タグ | D34 kind=neutral＋小 dot、error のみ clean red（D10）。TimeRibbon の kind 色は minimap 特権で温存可 | 色配給の是正（tab list は neutral、ribbon は配給面） |
| B5 | **PR** | `PullRequestView` master-detail（GitHub mirror 寄り） | D28 navigate detail、核＝作成過程(attribution)＋簡易 diff。深い review は GitHub（D12 navigate） | master-detail→navigate、scope 縮小 |
| B6 | **Chat** | UI 撤去済み（data 層のみ存在） | D22–26 全面 A（/chat route）＋ 永続 context panel B（D25）＋ Cursor 流 add-context（D23）＋ 単一枠 composer（D26）＋ tool 制限 agent（D24） | 新 route・新 panel・chat agent 配線（CLI provider） |

### C. 残り surface の Layout v2 移行（B でなく継続作業）
`SessionViewer` / `OverviewView` / `FindingsAxisView` / `PullRequestView` は legacy header のまま（`SessionsSurface` のみ移行済み）。各 surface の自前 header band を剥がし `Surface` の WorkareaHeader に寄せる（loop/26-ui-shell の Layout v2 継続）。

### D. 保留（⏳、今作らない）
eval（D9）/ chat 内 生成 UI（D27）/ PR の eval・rubric 評価（D30）/ findings kind 多様性（nascent、Phase 2 運用後）。

## 2. 置き換え順序（提案）

各スライス = §3 の型。先頭ほど「既存に近い・基盤」、後半ほど「新規・乖離大」。

0. **基盤の収束**: 残り 4 surface を Surface へ移行（§1-C）。ds-v1-single を一段締める。新規 component 無し・既存 header の付け替え。
1. **Sessions list**（D3-5/11/12）: `SessionsSurface` は移行済 → mockup `sessions.html` と視覚一致を検証、comparison-list の不変条件 rubric を確定。
2. **SessionViewer / Transcript**（D6-8）: inline turn-drilldown ＋ 単一 Step component。**B1 ADR**（detail-wider-than-list を drilldown 不変条件へ）。最大の乖離。
3. **Tools / Skills**（D11/D33/D8）: comparison-list 再利用＋inline 展開（B3）。
4. **Git**（D13-15）: dual-axis ＋ unified diff ＋ attribution（**B2 ADR**、DiffViewer 再構築）。
5. **Subagents**（D16-18）: 並列横/逐次縦・nested mini-session 3-tab・[By step\|All]。
6. **Stats / Annotations / Raw**（D32/D34/D35）: Stats=Overview chart 再利用、Annotations=neutral kind（B4）、Raw=JSON 3-hue。
7. **Findings**（D19-21）: Analysis 核・evidence jump・verdict→backlog（**data 既存**、UI を起こす）。
8. **PR**（D28-30）: navigate detail・attribution 核（**B5 ADR**、scope 縮小）。
9. **Overview**（D31）: attention funnel（`OverviewView` は近い → 寄せる）。
10. **Chat**（D22-26）: /chat route ＋ context panel B ＋ composer ＋ tool 制限 agent（**B6**、最大の新規）。

> 順序は提案。優先度（例: Findings/PR/Chat の前倒し）はユーザー裁可で入れ替え可。

## 3. スライスの型（per-screen テンプレート）

各スライスで以下を 1 worktree・1 監査・lockstep で:

1. **🧩 component**: 作る/差し替える component（既存部品の再利用を最優先＝DS は generative）。
2. **➕ rubric**: 新規 gate を足す or 既存 gate を改訂（B 系は旧 check を supersede）。T1=grep / T2=render-geometry(playwright) / T3=screenshot-judge(advisory)。
3. **data**: 必要 data は実在か（§1-A で大半 存在）。無ければ migration を別スライスで先行。
4. **受け入れ（機械照合）**: ① mockup（`mockups/<screen>.html`）と構造一致（色は light token に写像）② 該当 rubric GREEN ③ e2e ④ tsc。印象でなく GREEN を根拠に完了宣言（AGENTS.md feedback_coverage_harness）。

## 4. リスク / 注意

- **テーマ取り違え厳禁**: mockup は dark 近似。実装は light tokens.css ＋ D10/D31 配給。色は「正しい色を配る」（問題=clean red、非問題=neutral、くすんだ赤茶=bg-tint 流用は不可、D31）。
- **gate を壊すスライス（B1/B2/B5）は rubric 改訂を同時に**。as-is で GREEN の `detail-wider-than-list` 等は、新 design では FAIL する。harden loop（目視バグ→決定論 gate）の逆向き＝「決定で旧 gate を supersede」を ADR＋別コミットで明示。
- **boil the ocean 回避**: スライスは独立 land、各 GREEN を確認してから次。globals→0 は段階締め。
- **保留（§1-D）に手を出さない**。

## 5. 次アクション（ユーザー裁可待ち）
1. この順序・乖離（B1–B6）の ADR 化方針を承認するか。
2. 着手スライス（提案: 0→1→2 の順、または優先 screen を指定）。
3. 各スライスは worktree 委譲＋監査で進める。
