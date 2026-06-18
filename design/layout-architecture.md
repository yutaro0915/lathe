# Lathe Layout v2 — layout-first shell（ロック 2026-06-18）

> status: locked / branch: loop/26-ui-shell
> 決定の経緯: UI レビューで「ヘッダー段差＝各 surface が自前でヘッダー帯を描く（`.lds-page-head`/`.lds-session-bar`/`.pr-hero` の 3 種）＝レイアウト権威が無い」と判明。layout-first（shell が region を所有し、surface はその中に流し込む）へ再設計。
> nav IA は裏取り（workflow `wf_ff8df3fd-d8a`: Langfuse/Grafana/Vercel/Datadog/Sentry）: 遅いスコープ階層→top breadcrumb、機能→rail、揮発する entity/操作→page header。top bar は「本物のスコープ鎖」がある時だけ正当化される。
> 製品像（ユーザ確定）: **multi-user は無し**（org/account/権限/共同編集は作らない）。**multi-project は有り**（ingest 含む）。project は「per-screen フィルタ」から「アプリ全体を scope する切替軸」に昇格（Langfuse 型: cross-project 俯瞰ホーム + switcher で scope-in）。

## 階層

`Project(scope) → Section → Entity`（org 層は無い＝単一ユーザ）。

## Region 契約（shell が所有、surface は流し込むだけ）

| region | 所有 | 中身 | 不変条件 |
|---|---|---|---|
| Top bar | shell（root layout） | brand `Lathe` ＋ **枠なし breadcrumb 風の project セレクタ**（`Lathe / All projects ▾`、text+chevron、border/box なし）。選ぶと `?project=` で全 section を再 scope | **project 選択と識別だけ**。search/⌘K・アプリ機能ボタン・account/user は載せない。**枠で囲まない**（Langfuse の `/ Yutaro Ono ▾` のようにシンプル）。search は各 surface の WorkareaHeader 内（scope 付き）に置く |
| Rail | shell（root layout） | section nav: Sessions / Findings / PR / Overview（将来 Harness / Evals・Evaluators / Datasets・Experiments / Scores） | section は常に現在軸をハイライト |
| WorkareaHeader | shell・**単一 component**（`<Surface>`/`<WorkareaHeader>`） | surface が渡す `{title, meta?, actions?, tabs?}`、＋ `← 戻る`/breadcrumb（section→entity の 2 段のみ） | **ヘッダー chrome はこの component にしか存在しない**。surface は `.lds-page-head`/`.lds-session-bar`/`.pr-hero` を二度と描かない |
| Body | surface | surface の content のみ | 高さ・幅・余白は WorkareaHeader が固定するので構造的に段差不能 |
| RightPanel | shell・collapsible（× で閉じる） | Inspector/detail（現 aside を shell 化）＋将来枠 | 各 surface が独自 aside grid を作らない |

## project scope（昇格）

- 現状: `project-picker <select>` が SessionsSurface / OverviewView の page header にあり、in-memory で session list をフィルタ（client state、route 変えない）。
- v2: **top bar の scope switcher に昇格**。`?project=<id|all>` URL param（既定 `all`）を読み書きし、全 section がこれを読んで scope する。`all` = cross-project 俯瞰（Overview が既にこの役）。
- **multi-project ingest は既存データモデルで対応済み**（`db/schema.sql` の `projects` table、`sessions.project`）。UI 昇格でこれを壊さないことを制約とする（ingest 経路・project 派生ロジックは不変）。

## 機械強制（rubric）

- `layout-authority`: ヘッダー chrome（旧 3 class ＋ 新 WorkareaHeader の styling）は WorkareaHeader component にしか現れない（surface 内 grep 0）。新 surface が自前ヘッダーを描くと RED。
- `topbar-scope-only`: Top bar component は project セレクタ・brand のみ（search/⌘K・Run/Find/Reset/フィルタ等のボタン・枠付きコントロールを置かない）。machine もしくは agent-judge。

## build 手順（slice、各 gate+現物+e2e、実装=Opus・監査=Claude）

1. **shell scaffold**: root layout に AppShell（Top bar[brand + ProjectSwitcher(?project=) + ⌘K] + Rail + `<main>` slot）。`<Surface>` component（WorkareaHeader 契約 + Body + collapsible RightPanel）。Sessions surface を `<Surface>` で migrate（proof）。
2-6. 残り surface（SessionViewer / Findings / Overview / PR / Stats）を順次 `<Surface>` へ移行。各々 `.lds-session-bar`/`.pr-hero` 等の自前ヘッダーを撤去し WorkareaHeader へ。
7. project picker を top bar scope switcher に昇格（全 section が `?project=` を読む）。multi-project ingest 不変を確認。
8. `layout-authority` / `topbar-scope-only` rubric を auditor が land（chrome の単一所在を固定）。

## スコープ外（将来フェーズ・今は作らない）

- multi-user / org / account / 権限 / 共同編集 presence。
- eval/harness expert-system の section 群（Harness 編集 / Evals / Evaluators / Datasets / Experiments / Scores）。rail は拡張可能に設計するが中身は別フェーズ。
- ポートフォリオ型の複数 project 同時表示（今回は Langfuse 型 scope-in を採用）。

## 関連

- 旧 DS 移植（globals.css 1008→80）: `design/ds-migration-plan.md`。本 v2 はその上に layout 権威を載せる。
- rubric: `rubrics/`（ds-v1-single 他 ＋ 本 v2 で layout-authority/topbar-scope-only を追加）。理想状態: `architecture.md`。
