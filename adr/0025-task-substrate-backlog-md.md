# ADR 0025: 開発タスク基盤を Backlog.md へ移行（tools/wbs 廃止・GitHub Issues 降格）

- status: **accepted**（2026-07-04、PdM 裁可: 「いいんじゃない」＝方向 + Phase 0 spike 承認）
- date: 2026-07-04
- 契機: PdM 決定「自前ツール（tools/wbs）の管理・作成が面倒。Backlog.md を導入してタスク管理したい」（2026-07-04 壁打ち）。
- 関連: ADR 0013〜0016（inner-loop driver 一族＝unit を持つ機構）／ADR 0023（runs ingest＝manifest の `loop_kind` 判定）／ADR 0017（tool-loop＝wbs の出自。本 ADR は wbs を廃止するが tool-loop 機構は存続）／[design/agent-workflow.md](../design/agent-workflow.md)（inner/outer loop の正本＝改訂対象）／[[pdm-issue-filing]]（起票規律＝task 化へ改訂）。
- **用語の衝突を排除**: 本 ADR の「Backlog.md」は**開発タスクの実行基盤**（OSS: MrLesk/Backlog.md）。ADR 0007/0008 の "finding backlog"（Phase 2 の分析所見の蓄積）とは**別物**。以降、前者を **Backlog.md**、後者を **findings backlog** と表記して混同しない。

## 背景（as-is）

現在、開発の実行単位は **GitHub Issue**。inner loop は 1 issue ごとに PLAN→…→MERGE を回し、`inner-issue-<N>` worktree・`.lathe/runs/issue-<N>.json` / `plan-<N>.json` manifest・`scripts/merge.mjs` の close 判定がすべて **issue 番号に結合**している。`tools/wbs.mjs`（自前 Node 1735 行）は、その GitHub Issues ＋ ROADMAP.md の Phase ＋ ローカル `.lathe/wbs/tasks.json` ＋ git worktree を**寄せ集めて表示するビューア**にすぎない（意思決定権は持たない）。

問題は2つ。**(a)** wbs は自前ツールで、盤面 UI・分類ロジック・HTMX serve を PdM が保守し続ける負債になっている（ADR 0017 の tool-loop で「使い捨て」として作ったが、事実上の常用ツールに育ち保守コストが発生）。**(b)** タスクの実体情報が **GitHub issue body（Depends-on 注釈）＋ plan manifest ＋ ローカル tasks.json** に散在し、単一正本がない。

Backlog.md の一次情報（README・公式 AGENTS.md・CLI-INSTRUCTIONS、2026-07-04 裏取り）で確定した設計上の事実:

- タスクを **repo 内 markdown**（`backlog/tasks/task-N.md`、frontmatter に `status`/`depends_on`/`parent`/`labels`/`acceptance_criteria`/`implementation_plan`/`definition_of_done`）として**自身が正本として保持**。CLI/MCP 変更ごとに atomic commit（git diff がレビュー面）。
- **GitHub Issues とは同期しない**（双方向 sync・import 機能なし）。公式 AGENTS.md が「GitHub issues are reports/proposals — not implementation specs」と明言＝Issues と直交する思想。
- **AI agent 一級市民**: `backlog mcp start` で MCP server 提供（Claude Code / Codex 直結）。`backlog board`（端末）/ `backlog browser`（web, :6420）で盤面。`--plain` で機械可読出力。MIT・活発（star ~5.9k・最終コミット数日内）。

→ Backlog.md は**ビューアではなく task substrate**。「wbs だけ捨てて GitHub Issues を残す」には `gh issue list`→md の片方向 sync を**自前で書いて保守**する必要があり、動機 (a) と正面衝突する。よって導入は「**実行単位を GitHub Issue から Backlog.md task へ移す**」ことと不可分。

## 決定

### 1. 開発タスクの正本 = Backlog.md（in-repo markdown）
`backlog/tasks/task-N.md` を inner loop の実行単位にする。1 タスク md が **「scope + 受け入れ条件 + 計画 + 依存 + status」を1枚に統合**し、現状 issue body / plan manifest / tasks.json に散っている情報を畳む。編集は **CLI/MCP 経由のみ**（手編集禁止＝Backlog.md 公式規約を採用。frontmatter 一貫性を壊さない）。

### 2. GitHub Issues を「外部レポート窓口」に降格
Issues は **バグ報告・外部提案の入口**として残す（public repo の対外窓口）。**実行単位ではなくなる**。outer loop の triage で「受理した report → `backlog task create`」に変換する（Backlog.md 公式思想と一致）。

### 3. ROADMAP.md は Phase の物語として存続・Phase ↔ milestone/label で機械対応
rolling wave の Phase 計画（[ROADMAP.md](../ROADMAP.md)）は人間可読の正本として残す。各 task に **Phase を milestone または `phase-N` label で付与**し、board が Phase 配下にグルーピングできるようにする（実コマンド面＝`milestone` の有無は移行 Phase 0 で検証）。ROADMAP を Backlog.md へ完全に畳むかは**未決**（本 ADR では二重管理を避けるため「narrative は ROADMAP・machine grouping は label」の最小結合に留める）。

### 4. inner-loop driver 一族の unit 付け替え（gap list）
実行単位を `issue-<N>` → Backlog.md task に rebind する。**観測コア（apps/web の session/run ingest）は不変**。付け替え対象:

- `scripts/inner-loop.mjs` — unit id の取得元（gh issue → backlog task）／worktree 命名／manifest 書き出し。
- `scripts/inner-queue.mjs` — 依存解決（ADR 0015）を issue body `Depends-on:` から **task frontmatter `depends_on`** へ。
- `scripts/merge.mjs` — 終端動作（issue close → **task status = Done**）。receipt ゲート自体は不変。
- `scripts/inner-loop-prompts.mjs` / `inner-loop-backends.mjs` — prompt 中の "issue" 参照。
- **manifest の unit keying**: 現在の filename 結合（`issue-<N>.json`）を **`unit: {kind, id}` フィールド**へ寄せることを推奨（ingest の `loop_kind` 判定と worktree 名の脱結合）。**正確な命名・schema は inner-loop 実装の裁量**（ADR 0024 が driver 形式を loop 基盤に委ねたのと同型）。
- ingest `loop_kind`（ADR 0023、apps/web）— 新 manifest の unit 表現に追随（小粒 companion）。

### 5. 盤面 = `backlog browser` / `backlog board`、`tools/wbs.mjs` は廃止
自前盤面を捨てる。**crossed view（計画 × 稼働）は2つの正しい道具に分解**される: 計画・status は Backlog.md board、**稼働 run 健全性は lathe 自身（`list_runs` MCP）** ＝ 製品本来の仕事。`tools/wbs.mjs` / `wbs.test.mjs` / `tools/htmx.min.js` を削除。`tools/watch-run.mjs`（run watcher）は別物なので残す。

### 6. MCP 連携と手編集禁止規約の取り込み
`backlog mcp start` を lathe の MCP に登録し、agent は task を **MCP/CLI 経由で読み書き**（§1）。Backlog.md 公式 AGENTS.md の運用規約（手編集禁止・1 session 1 task・実装前に計画・人間レビュー checkpoint）を lathe の agent-workflow に取り込む（重複は lathe 側を優先）。

### 7. 不変（scope boundary）
- **観測コア**（session/run ingest・apps/web・findings backlog・rubrics・merge receipt 機構）は変えない。変わるのは「実行単位の identity」のみ。
- **tool-loop 機構（ADR 0017）は存続**。wbs はその初弾インスタンスが役目を終えるだけ。ADR 0017 に wbs 廃止を追記する（機構の否定ではない）。

## 移行順序（proposed・PdM 承認対象）

段階を分け、**軽い所（wbs 廃止・Backlog.md 常用開始）を先に取り**、重い rewire は dogfood として inner loop に載せる。

0. **spike / 事実確認（低リスク・可逆）**: `backlog init`・数タスク作成・`backlog browser` 起動・MCP 登録・`--plain` 出力・agent が MCP 経由で読み書きできるか・§3 の milestone/label 機構を検証。想定と違えば本 ADR に追記。
1. **並走（rewire なし）**: 新規タスクは Backlog.md で起票。進行中の issue ベース run は旧フローで drain。**wbs ビューアはここで廃止**（誰も依存しないため即可能）＝保守負債を先に落とす。
2. **inner loop rewire**: §4 の付け替え（driver・merge・manifest・ingest）。**これ自体を inner loop に起票して dogfood**（worktree 隔離・receipt ゲート）。
3. **文書・規約整流**: [design/agent-workflow.md](../design/agent-workflow.md)（"issue ごと"→"task ごと"）・`skills/lathe-loop`・[AGENTS.md](../AGENTS.md)・[[pdm-issue-filing]] を task 化へ改訂。ADR 0017 へ wbs 廃止追記。残る open GitHub issue を task へ移送。

## 受け入れ / 検証

- Phase 0: MCP 経由で agent が task の作成・status 変更・依存追加を実行でき、`backlog browser` が Phase 別に表示、`--plain` が script 連携可能なことを実機確認。
  - **（2026-07-04 実施・PASS）** backlog.md 1.47.1 install → `backlog init --agent-instructions none`（正本 CLAUDE.md/AGENTS.md 無改変・`auto_commit:false` で main 無汚染）。検証: task md が AC/Plan/DoD/`dependencies`/`milestone` を1枚に保持（§1）／`sequence` が依存から実行順を計算＝inner-queue 源（§4）／`milestone add`＋`board -m` グルーピング実在（§3）／`mcp start` が `task_create/edit/list/complete`・`milestone_*` を公開（§6）／`browser`（:6420）GET/ 200・`/api/tasks` JSON／`--plain` 機械可読。GitHub Issues 同期は非存在を再確認（§2 の降格が妥当）。運用メモ: `board export <file>` は project-relative 解決（絶対パス不可）。
- Phase 2: rewire 後、**Backlog.md task 1 本を inner loop で PLAN→MERGE 完走**し、manifest が lathe に ingest され `loop_kind` が正しく分類され、`scripts/merge.mjs` の receipt ゲートが従来どおり効くことを確認（＝観測コア不変の証明）。

## 却下した代替

- **wbs だけ廃止し GitHub Issues を残す**（Q2 の当初案）: Backlog.md に GH 同期がなく、片方向 sync を自前保守する羽目になる＝動機 (a) と衝突。substrate を移さない限り Backlog.md の利点（統合 md・MCP・board）が得られない。
- **Nulab Backlog（SaaS）**: アカウント/認証/外部 API 依存で、git ネイティブ・ローカル agent・"git diff = レビュー面" 原則から外れる。PdM は MrLesk/Backlog.md を明示選択。
- **ROADMAP.md を即 Backlog.md milestone へ全畳み込み**: rolling wave の物語（完了定義・順序・根拠）は人間可読 doc の価値が高い。二重管理を避けつつ narrative は残し、grouping だけ機械化（§3）。全畳み込みは実運用で必要が見えた時に昇格。
- **自前 wbs を作り直す/直す**: 保守負債の再生産。外部の活発な OSS（MIT・MCP 一級）に載せ替える方が総コストが低い。

## スコープ外 / 未決

- ROADMAP.md の Backlog.md への完全畳み込み（§3 で最小結合に留置）。
- 既存 open GitHub issue の移送方針（一括変換 vs drain 後変換）＝移行時に PdM 判断。
- `backlog/` 配置（既定は repo root）と public repo での可視性の最終確認。
- Backlog.md task と findings backlog（ADR 0007/0008）の接続 UX（finding→task 化の自動化）＝感知系（ADR 0024 meta-loop）実証後の別 ADR。
