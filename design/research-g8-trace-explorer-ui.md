---
title: G8 調査 — セッション/トレース探索 UI の prior art 網羅
type: research-note
status: draft
updated: 2026-06-10
related: [user-stories.md]
---

# G8 調査: セッション/トレース探索 UI の prior art

S1-1「セッション終了後 5 分で何が起きたか把握する」の探索 UI 再設計に向けた prior art 調査。
disciplined-research 規律に従い、**実態の列挙のみ**を行う（設計の枠組み・二分法は立てない）。
調査日: 2026-06-10。出典は末尾に一覧。「未確認」は一次情報（公式 docs / ソースコード / 公式 README）で
裏取りできなかった項目で、確定事実と区別して記載する。

---

## Q1: 既存実装の情報階層・ナビゲーション・要約表示

### Q1-a: LLM observability 系

| 実装 | 情報階層（ネスト単位） | ナビゲーション様式 | 「速い把握」のための要約・集計 |
|---|---|---|---|
| **Langfuse** | trace → observation（自己参照木、`parent_observation_id`）。observation は SPAN / GENERATION / EVENT の 3 型。trace は session に任意グループ化 [L1] | **Tree / Timeline のトグル**（2025-03 新 trace view。両ビューで metrics・scores は同等）[L2]。timeline は比例幅バー、GENERATION バーは TTFT で分割表示 [L3]。observation の type/ID/名前検索、log-level（DEBUG〜ERROR）でツリーをフィルタ [L2][L4] | ツリーノードを latency/cost percentile で兄弟比の色分け [L1]。observation 詳細パネルに「自身のコスト＋子孫合計の階層コスト」[L1] |
| **LangSmith** | project → trace（1 操作の run 集合）→ run（span 相当の作業単位）。複数 trace を thread（会話）でリンク（`session_id`/`thread_id`/`conversation_id` メタデータ）[LS1] | trace クリックで階層 run ツリー、ノード選択で右に詳細パネル（入出力・metrics）。metadata / tags がフィルタ次元 | run 単位の timing 表示。waterfall 表示の存在はブログ等の二次情報のみで**一次未確認**（後述） |
| **Braintrust** | trace（1 end-to-end 実行）→ span（入れ子）。データモデル上は DAG（span が複数親を持てる）だが UI は単一 root のツリー表示のみ [B3] | 左に span ツリー、右に選択 span 詳細 [B2]。trace 内 Cmd+F 検索（スコープ: This span / Full trace、マッチ span をツリー上でハイライト）[B1]。span type / span field でフィルタ、checkbox で span 一括選択 → dataset 追加 [B2]。テーブル（trace 行）⇄ Spans view（全 span をフラット表示）の行型切替 [B4]。`bt view logs` で CLI のライブ表示も提供 [B4] | 各 span に inputs/outputs/timing/metadata。span field の表示モード切替（Pretty=Markdown / Tree / LLM view=メッセージ・tool call 整形）[B1] |
| **W&B Weave** | trace（同一実行コンテキストの Call の木）→ Call（親子関係、`trace_id` で全木取得）[W1] | デフォルトはスタック階層ツリー。**4 種のビュー切替**: trace view / code composition / flame graph / graph view [W2]。breadcrumb・↑↓スタック移動・ダブルクリックでサブスタックへフォーカス・「Jump to Top」[W2]。ツリー下に**4 種の scrubber**（Timeline=時系列 / Peers=同型 op / Siblings=同親 / Stack）[W2]。op 名のフィルタ入力 [W2] | ツリー行に cost per op・実行時間・status indicator [W2]。latency / cost は各階層で自動集計 [W3] |
| **Arize Phoenix** | trace → span（OTel 準拠、`parentId` でフラット配列から木を再構築 = `createSpanTree()`）[P2]。`openinference.span.kind`（LLM / Tool 等）で span をUI上で描き分け [P1] | span ツリー（`SpanTreeItem`）＋各行に trace 全体に対する時間位置を示す `TimelineBar`（ツリーと時間軸を同一行で併置）[P2] | ツリー行に kind / status / latency / token 数。`showMetricsInTraceTree` 設定でツリー内 metrics の表示切替 [P2] |
| **Helicone** | session → 階層パス（`Helicone-Session-Path` ヘッダ、`/task/research/web_search` のようなパス文字列が親子を規定）→ request（LLM 呼び出し・vector DB・tool call）[H1] | **Chat view（会話再構成）/ Tree view / Span view の 3 ビュー** [H2]。フィルタは全ページ永続＋URL 共有可 [H3] | session 一覧に平均 latency・合計コスト（2025-05 の Sessions 再設計で session レベル metrics を追加）[H3] |
| **AgentOps** | session → span の waterfall（agent → 子 agent → LLM 呼び出し / tool 呼び出しがネストした子 span）[A2] | **左 = 時間軸 waterfall（LLM 呼び出し・Action・Tool・Error の時間可視化）、右 = 選択イベントの詳細**（prompt と completion 等）[A1]。session replay リンクを実行時に console へ出力 [A3] | session drill-down に総経過時間・イベント数・エラー・終了理由・LLM コスト・トークン数の overview（lablab.ai チュートリアル由来、**一次未確認**）|

**LangSmith の waterfall 表示について**: 「execution waterfall がチェーンの各ステップとエラー位置を示す」という記述は
murf.ai / DigitalOcean 等の二次情報のみで、公式 docs ページ上での名称・仕様は本調査では一次確認できなかった。
trace = run 木・thread の階層構造自体は公式 concepts docs で確認済み [LS1]。

### Q1-b: 汎用分散トレーシング UI（waterfall / span tree の定石）

| 実装 | 情報階層 | ナビゲーション | 要約表示 |
|---|---|---|---|
| **Jaeger** | trace → span（service / operation で色分け・分割）。デフォルトは**全 span 折りたたみ**で全体像を先に見せる [J2] | waterfall（ツリー行＋時間バーの併置）。span 展開で operation 名・開始時刻・duration・担当 service。**minimap**（trace ページ上部の時間軸縮約。ドラッグでズーム、`uiTimelineHideMinimap` 等の embed 設定あり [J1]）。代替ビュー: flamegraph（右クリックで折りたたみ・類似 span ハイライト）、テーブルビュー（span ID クリックで Trace Detail の該当 span へ遷移）[J2] | trace ヘッダに duration・service 数等の quick stats。折りたたみ状態でも「どの span が最も時間を食うか」が見える [J2] |
| **Grafana Tempo（Grafana の Trace View）** | trace → span（行ごとに「Expand children」で子 span を開閉）[G1] | 3 分割: 上 = trace ID・duration・service のヘッダ、中 = タイムライン（横バー。色 = status、幅 = duration）、下 = 選択 span の詳細（attributes / events / links）[G2]。**minimap**（ドラッグでズーム、Reset selection）[G1]。Span Filters バー（デフォルトは「Show all spans」= 非マッチも残してマッチをハイライト、オフで非表示）[G3]。span → 関連ログ / 関連メトリクスへの遷移リンク [G1] | ヘッダの duration・service 数。span 詳細に attributes / events |

定石として観察される共通要素（観察事実）: (1) span ツリーの行に時間位置バーを併置する waterfall、
(2) 上部 minimap によるズーム、(3) 「ハイライト or 非表示」を選べる span フィルタ、
(4) 選択 span の詳細を右 or 下のパネルに出す master-detail 構成。

### Q1-c: coding-agent 専用ビューア

| 実装 | 情報階層 | ナビゲーション | 要約表示 |
|---|---|---|---|
| **claude-trace（@mariozechner/claude-trace、badlogic/lemmy 内）** [C1][C2] | API リクエスト/レスポンス対（fetch 横取り）→ 自己完結 HTML。`--index` で AI 生成の会話サマリ索引 | 単一ページ HTML。モデルフィルタ、raw HTTP のデバッグビュー。thinking ブロック・tool 出力・system prompt も表示 | トークン使用量（cache hit 内訳付き）。索引ページの会話要約 |
| **bkrabach/claude-trace-viewer**（上記の代替ビューア）[C3] | trace ファイル → リクエスト、サブエージェントを検出して可視化 | **ブラウザ devtools の Network タブに着想を得た UI** ＋ timeline 可視化、検索・フィルタ [C3] | README に明細なし（**詳細未確認**） |
| **delexw/claude-code-trace** [C4] | project（`~/.claude/projects` 自動発見）→ session（JSONL）→ turn → tool call（展開可能）→ sub-agent（開閉） | session picker → リスト → 詳細の直線フロー。j/k 移動・Tab で開閉・Enter で詳細（TUI）。デスクトップ / Web / TUI の 3 モード。**live tail**（実行中セッションの追尾） | トークン数（取得可能な場合）、タイムスタンプ、MCP ツール名の整形表示 |
| **d-kimuson/claude-code-viewer** [C5] | project → session → メッセージ（progressive disclosure UI）。TodoWrite をインライン折りたたみチェックリスト化 | session 一覧（running/paused 状態表示）、⌘K 全文検索（project 内 / 横断、fuzzy・prefix）、右パネルに「編集ファイル一覧」タブ（project 別グループ、tool 呼び出しのフィルタとファイルプレビュー） | tool 呼び出しを専用コンポーネント（ファイル diff 等）で描画＋ Raw トグル。Git Diff Viewer 内蔵（Q2 参照） |
| **daaain/claude-code-log** [C6] | `~/.claude/projects/index.html`（プロジェクトカード＋統計）→ session HTML → メッセージ（時系列） | 対話的目次（セッション要約＋時刻範囲）。メッセージ型の表示/非表示フィルタ（user / assistant / system / tool use）、日付範囲フィルタ、tool use・長文の折りたたみ。TUI もあり | メッセージ単位のトークン使用量＋セッション合計。「Smart Summaries」= Claude 生成要約を最初のユーザーメッセージより優先 |
| **simonw/claude-code-transcripts** [C7] | session（JSON/JSONL）→ ページ分割 HTML | 対話的セッションピッカー、Gist 公開オプション | （閲覧整形が主目的。集計表示は README で確認できず = **未確認**） |
| **sniffly（chiphuyen）** [C8] | ログ全体 → project 別 drill-down → メッセージ履歴 | ダッシュボード（localhost:8081）、project 単位の drill-down、stats の共有リンク | **集計が主役**: 使用統計・エラー分析（エラー型の内訳）・メッセージ履歴 |
| **codex-trace（PixelPaw-Labs）** [C9] | 日付フォルダ（YYYY/MM/DD）→ Codex session（`rollout-*.jsonl`）→ turn → 詳細（tool 呼び出し・コマンド出力・パッチ適用・web 検索） | **3 パネル: 左 = 日付グループの session ツリー（開閉可）、中 = turn リスト（時系列）、右 = turn 詳細**。検索、SSE live tail、orchestrator-worker セッション間リンク（collaboration chain） | トークンカウント、タイムスタンプ |
| **Devin（Cognition）** [D1] | session → step（Progress tab のステップ列）。Shell / IDE(Editor) / Browser(Desktop) のタブ併設 | step クリックで詳細表示。「All shell commands, code edits, and browser activity will be logged in one unified view」。Command History から**過去時点へジャンプ**（未来時点のコマンドはグレーアウト）[D1] | タスク完了後の Session Insights（課題・timeline・milestone・効率 metrics・action items）[D2]（Cognition ブログ由来） |
| **Cursor** | agent 応答 → 変更 diff。agent の各編集前に checkpoint を自動保存 [CU2] | 生成中は diff がリアルタイム表示。応答末尾の「Review changes」で全 diff、画面下に floating review bar [CU1]。Review → Find Issues で行単位のレビューパス [CU1] | （セッション一覧型の履歴 UI は本調査では一次確認できず = **未確認**） |
| **Windsurf（現 Devin Desktop）Cascade** | 会話 → step。step 単位の revert（プロンプトにホバー → revert 矢印、目次からも可。**不可逆**）[WS1]。名前付き snapshot/checkpoint 作成可 [WS1] | 会話の table of contents から step へ移動 [WS1] | （要約・集計の明細は一次確認できず = **未確認**） |
| **Amp（Sourcegraph）** | thread（タスク単位の会話。Git ブランチに例えられる）→ メッセージ。thread は ampcode.com に同期 [AM1] | Web / CLI / mobile で同一 thread を閲覧。thread の公開共有・workspace 共有。`amp.git.commit.ampThread.enabled` で**コミット⇄thread をリンク** [AM1] | （thread 内の集計表示は一次確認できず = **未確認**） |
| **macOS ネイティブ viewer（openai/codex Discussion #24042）** [C10] | `~/.codex/sessions/YYYY/MM/DD/` の rollout ファイル＋ AGENTS.md ＋ memories/*.md を自動発見（**ファイルシステム構造そのままの探索**） | 巨大 JSONL のチャンク描画。メッセージ・tool call・トークン使用を整形表示 | トークン使用の整形表示 |
| **codex-logs（wondercoms）** [C11] | 月 → session（fzf による対話選択） | fzf ブラウズ、最新セッション表示、tail によるリアルタイム watch | session 情報に project ディレクトリと git branch |

---

## Q2: 「会話/実行ステップ ⇄ コード差分」の双方向リンク — existence proof

**結論（観察事実）: 双方向リンクを現にやっている実装は存在する。** 最も明確な existence proof は
VS Code 拡張「Claude Code and Codex Assist」（agsoft.claude-history-viewer）で、両方向の遷移を実装している。

| 実装 | リンクのキー | 遷移方向 | 実装の観察事実 | 確度 |
|---|---|---|---|---|
| **Claude Code and Codex Assist（VS Code 拡張、agsoft）** [V1] | session/会話 ⇄ ファイル（ファイル単位の修正履歴タイムライン） | **両方向** | session 選択 → 会話表示 → 「File Changes」タブで該当 diff（GitHub 風、会話内の全ファイル変更を Review Changes View に集約）。逆方向: diff から対応メッセージへのナビゲーション。エディタ上の右クリック「Show in Claude History Timeline」で**ファイル → そのファイルを触った会話**へ遷移 | Marketplace 公式ページで確認 |
| **GitHub PR レビュー** [GH1] | `(commit_id, path, line, side)`（旧: diff 先頭からの `position`）。レスポンスに `diff_hunk` / `original_position` / `original_commit_id` を保持し diff 変化後も追跡 | **両方向**（コメント⇄diff 行） | Files changed では diff 行にインラインでコメントが出る（diff→会話）。Conversation タブではコメントが `diff_hunk` 抜粋付きで時系列に出る（会話→diff）。後続 commit で行が変わると outdated 化 | API 公式 docs で確認 |
| **d-kimuson/claude-code-viewer** [C5] | tool 呼び出し ⇄ ファイル | **step→diff**（逆方向は未確認） | tool 呼び出しをファイル diff コンポーネントで会話内に直接描画。右パネルに編集ファイル一覧（project 別グループ、クイックプレビュー）。内蔵 Git Diff Viewer は行単位のインラインコメント・commit・push まで対応 | GitHub README / リリースノートで確認 |
| **Devin** [D1] | step（Progress tab）/ Command History の時点 | **step→状態**（時点ジャンプ）。step→diff の直接リンク UI は一次 docs では明示なし | Progress tab の step クリックで shell コマンド・code edits・browser 操作の統合詳細。IDE タブの diff view でコード変更を確認。Command History で過去時点へジャンプ | 公式 docs で step→詳細・時点ジャンプを確認。「全 file diff の replay timeline」は DataCamp 等の二次情報のみ = **その部分は未確認** |
| **Cursor** [CU1][CU2] | checkpoint（agent 編集前の自動スナップショット、Git とは別保存）/ 応答末尾の Review changes | **step（メッセージ）→diff / step→過去状態**。diff→メッセージは未確認 | 各 agent 編集前に checkpoint 自動作成 → メッセージ位置から復元。Review changes ボタンで応答に紐づく全 diff | 公式 docs で確認 |
| **CodeRabbit Review** [CR1] | diff の行レンジ（cohort → layer → 行レンジにアンカー） | **要約（右パネル）→diff レンジ** | PR を「change cohort（論理グループ）→ layer（読み順）」に再編成し、各 layer が具体的な行レンジにアンカー。右パネルの range summary に「Add block comment」= その行レンジ宛コメント。3 パネル（左 = cohort/layer ナビ、中 = diff、右 = レンジ文脈）、J/K キー移動 | 公式 docs / 公式ブログで確認 |
| **Amp** [AM1] | git commit ⇄ thread（`amp.git.commit.ampThread.enabled`） | **commit→thread**（コミット粒度。行粒度ではない） | コミットメッセージに thread をリンクする設定 | Owner's Manual で確認 |
| **OpenHands trajectory-visualizer** [O1] | timeline step（action/observation） | step 選択 → 内容表示。**diff 形式の表示は README に記載なし = 未確認** | action（コマンド・編集・検索）= 青、observation（メッセージ・エラー）= グレー/赤。矢印キーで step 移動 | 公式 README で確認（diff の有無のみ未確認） |
| **SWE-agent inspector** [S1] | step（thought, action, observation の turn） | h/l で step 間移動（CLI）、Web inspector はベンチ評価結果（✅/❌）併記。`--data_path` 指定で gold patch 表示 | **step⇄diff の相互リンクは docs に記載なし = 未確認** | 公式 docs で確認 |
| **Graphite / Sweep** | — | — | 本調査では一次情報を確認していない = **未調査** | — |

リンクキーの観察まとめ（確認できたもののみ）:
- 行レベル: GitHub PR（commit_id + path + line + side）、CodeRabbit（行レンジ）
- ファイルレベル: agsoft 拡張（ファイル別修正履歴 ⇄ 会話）、d-kimuson（tool 呼び出し ⇄ ファイル diff）
- 時点/スナップショットレベル: Devin（Command History の時点）、Cursor（checkpoint）、Windsurf（step revert・named snapshot）
- コミットレベル: Amp（commit ⇄ thread）

---

## Q3: ツリー型（ファイラ/ディレクトリ的）探索の実例と、観察された犠牲

### 実例

| 実装 | ツリーの単位 | 観察事実 |
|---|---|---|
| **codex-trace** [C9] | 日付フォルダ（YYYY/MM/DD）→ session → turn | 左パネルが日付グループのフォルダ構造（開閉可）。**ただし session 内部は turn の時系列リスト**であり、ツリーは session 選択までの探索に使われている |
| **macOS ネイティブ viewer（codex Discussion #24042）** [C10] | `~/.codex/sessions/YYYY/MM/DD/` のディレクトリ構造そのまま | ファイルシステムの実配置を自動発見して掘る、最もファイラ的な実例 |
| **Jaeger / Tempo / Phoenix / Braintrust / Langfuse / Weave の span tree** [J2][G1][P2][B2][L2][W2] | trace → span（実行の親子関係） | devtools Elements パネル型のインデント＋開閉。**Jaeger / Tempo / Phoenix はツリー行に時間バーを併置**しており、ツリーと時間軸は排他ではなく同一画面で両立している（waterfall = ツリー＋時間軸） |
| **delexw/claude-code-trace（TUI）** [C4] | session → turn → tool call → sub-agent | Tab で開閉するアウトライナー型。時系列順のリストに開閉を重ねた形 |
| **daaain/claude-code-log** [C6] | project カード → session → メッセージ（折りたたみ） | 静的 HTML でも「索引 → セッション → 折りたたみ展開」の段階的な掘り下げ |
| **Helicone Tree view** [H1][H2] | session path（`/task/research/web_search`）の階層 | パス文字列で親子を表現するツリー。Chat view / Span view と並ぶ 3 ビューの 1 つ |

### ツリー型が犠牲にするもの（実装側の言明・挙動として観察できた事実のみ）

- **Langfuse** は tree view が先にあり、timeline view を後から追加した。その追加理由として公式 changelog が挙げたのは「latency ボトルネックの特定」「**並列性の可視化**」「深くネストしたチェーンの多段推論の理解」[L3]。= ツリー単体ではこれらが見えにくいという実装側の認識の表れ（観察事実）。
- **Helicone** も同様に、ボトルネック特定は Span view、会話再構成は Chat view、と**ビューを分けて**提供している [H2]。
- **W&B Weave** はツリー（スタック階層）をデフォルトにしつつ、時系列順の復元手段として **Timeline scrubber** を別途用意している [W2]。
- **Jaeger / Tempo / Phoenix** は span ツリーの各行に時間位置バーを併置（waterfall）し、階層と時間軸を**同時に**表示している [J2][G1][P2]。
- **Langfuse の新 trace view** は Tree / Timeline を「metrics・scores の面で完全に同等」にした上でトグル切替にしている [L2]。

（注: 「ツリー vs タイムライン」を二分法として立てない。上記の通り、調査した実装の多くは両方を持つか、1 画面に併置している。これは観察事実であり、枠組みの提案ではない。）

---

## 確定事実 / 未確認の区分（サマリ）

**確定（一次情報で確認済み）**
- Langfuse の Tree/Timeline トグル・log-level フィルタ・percentile 色分け・階層コスト [L1][L2][L3][L4]
- Braintrust の span ツリー＋詳細パネル・trace 内検索スコープ・DAG データモデルと単一 root 表示制約 [B1][B2][B3][B4]
- Weave の 4 ビュー＋ 4 scrubber・breadcrumb スタック移動 [W2]
- Phoenix の `createSpanTree` / `TimelineBar` / `showMetricsInTraceTree`（ソース構造）[P2]
- Helicone の session path 階層・3 ビュー・session レベル metrics [H1][H2][H3]
- AgentOps の左 waterfall ＋右詳細・span ネスト構造 [A1][A2]
- Jaeger のデフォルト全折りたたみ・minimap・flamegraph・テーブルビュー [J1][J2]
- Grafana Trace View の 3 分割＋ minimap ＋ Span Filters（ハイライト/非表示切替）[G1][G2][G3]
- coding-agent ビューア各種の構造（C1–C11 の各 README / Marketplace）
- Devin の Progress tab・step クリック詳細・Command History 時点ジャンプ [D1]
- **Q2 の existence proof**: agsoft VS Code 拡張の双方向リンク [V1]、GitHub PR の行アンカー [GH1]、CodeRabbit の行レンジアンカー [CR1]、Cursor checkpoint [CU2]、d-kimuson の step→diff [C5]

**未確認（一次情報で裏取りできず）**
- LangSmith の「waterfall」表示の名称・仕様（階層データモデルは確認済み [LS1]、waterfall は二次情報のみ）
- AgentOps session drill-down の overview metrics 明細（チュートリアル由来）
- Devin の「全 file diff の replay timeline」「ロールバックで files と memory state を復元」（DataCamp 等の二次情報のみ。公式 docs では step 詳細と時点ジャンプまで）
- Devin Session Insights の詳細（Cognition ブログにはあるが製品 docs での仕様未確認）
- Cursor のセッション履歴一覧 UI、diff→メッセージ方向の遷移
- Windsurf Cascade の要約・集計表示
- Amp thread 内の集計表示
- bkrabach/claude-trace-viewer の metrics 表示明細
- OpenHands trajectory-visualizer の diff 表示形式
- SWE-agent inspector の step⇄diff リンク
- Graphite / Sweep（未調査）

---

## Lathe への設計示唆（観察事実から直接導けるもののみ・枠組み提案はしない）

- 調査した範囲の実装は、ツリー型とタイムライン型を排他にしていない（トグル [L2]・併置 [J2][G1][P2]・複数ビュー [H2][W2]）。
- 「速い把握」の集計は (a) 一覧行（session 一覧に latency/コスト [H3]）、(b) ツリー行内（cost per op [W2]、percentile 色 [L1]）、(c) ヘッダ/minimap（quick stats [J2][G1]）、(d) 事後レポート（Session Insights [D2]・sniffly [C8]）の 4 箇所で観察された。
- 会話⇄diff の双方向リンクは existence proof あり [V1]。ファイル単位（修正履歴タイムライン）をキーにした実装が coding-agent 文脈では確認された [V1][C5]。行単位アンカーは PR レビュー系で確立している [GH1][CR1]。
- 大規模トレースへの対処として「デフォルト全折りたたみ」[J2]、「log-level フィルタ」[L4]、「マッチをハイライトか非表示か選べるフィルタ」[G3] が観察された。
- coding-agent ビューアでは「3 パネル（一覧→turn→詳細）」[C9]、「master-detail ＋折りたたみ」[C4][C6] が反復して観察された。

---

## 出典一覧

### LLM observability
- [L1] Langfuse Data Model: https://langfuse.com/docs/observability/data-model（参照 2026-06-10）
- [L2] Langfuse New Trace View changelog (2025-03-19): https://langfuse.com/changelog/2025-03-19-new-trace-view
- [L3] Langfuse Trace Timeline View changelog (2024-06-12): https://langfuse.com/changelog/2024-06-12-timeline-view
- [L4] Langfuse log-level filter changelog (2025-02-10): https://langfuse.com/changelog/2025-02-10-trace-log-level-filter
- [LS1] LangSmith Observability Concepts: https://docs.langchain.com/langsmith/observability-concepts
- [B1] Braintrust Examine traces: https://www.braintrust.dev/docs/observe/examine-traces
- [B2] Braintrust View traces: https://www.braintrust.dev/docs/guides/traces/view
- [B3] Braintrust Advanced tracing: https://www.braintrust.dev/docs/instrument/advanced-tracing
- [B4] Braintrust View your logs: https://www.braintrust.dev/docs/observe/view-logs
- [W1] Weave Ops/Calls/Traces: https://weave-docs.wandb.ai/guides/tracking/tracing/
- [W2] Weave Navigate the Trace View: https://weave-docs.wandb.ai/guides/tracking/trace-tree/
- [W3] W&B Traces product page: https://wandb.ai/site/traces/
- [P1] Phoenix What are Traces: https://docs.arize.com/phoenix/tracing/concepts-tracing/what-are-traces
- [P2] Phoenix Tracing & Observability（ソース構造、DeepWiki 経由で `app/src/components/trace/TraceTree.tsx` 等を参照）: https://deepwiki.com/Arize-ai/phoenix/5.1-tracing-and-observability
- [H1] Helicone Sessions docs: https://docs.helicone.ai/features/sessions
- [H2] Helicone Essential Features（公式ブログ、Chat/Tree/Span の 3 ビュー）: https://www.helicone.ai/blog/essential-helicone-features
- [H3] Helicone Smarter Sessions changelog (2025-05-06): https://www.helicone.ai/changelog/20250506-smarter-sessions-insights
- [A1] AgentOps docs Introduction（Session Waterfall）: https://docs.agentops.ai/v1/introduction
- [A2] Google ADK × AgentOps integration: https://google.github.io/adk-docs/integrations/agentops/
- [A3] AgentOps GitHub: https://github.com/agentops-ai/agentops

### 分散トレーシング
- [J1] Jaeger Frontend/UI Configuration: https://www.jaegertracing.io/docs/1.23/frontend-ui/
- [J2] O11y workshop Lab 4 — Exploring Jaeger UI（実操作のウォークスルー）: https://o11y-workshops.gitlab.io/workshop-opentelemetry/lab04.html ／ jaeger-ui repo: https://github.com/jaegertracing/jaeger-ui
- [G1] Grafana Traces in Explore: https://grafana.com/docs/grafana/latest/explore/trace-integration/
- [G2] Grafana Visualize tracing data: https://grafana.com/docs/tempo/latest/visualize-traces/
- [G3] Grafana Span filters: https://grafana.com/docs/grafana/latest/datasources/tempo/span-filters/

### coding-agent ビューア
- [C1] @mariozechner/claude-trace (npm): https://www.npmjs.com/package/@mariozechner/claude-trace ／ ソース: https://github.com/badlogic/lemmy/tree/main/apps/claude-trace
- [C2] Simon Willison による claude-trace レビュー (2025-06-02): https://simonwillison.net/2025/Jun/2/claude-trace/
- [C3] bkrabach/claude-trace-viewer: https://github.com/bkrabach/claude-trace-viewer
- [C4] delexw/claude-code-trace: https://github.com/delexw/claude-code-trace
- [C5] d-kimuson/claude-code-viewer: https://github.com/d-kimuson/claude-code-viewer
- [C6] daaain/claude-code-log: https://github.com/daaain/claude-code-log
- [C7] simonw/claude-code-transcripts: https://github.com/simonw/claude-code-transcripts
- [C8] chiphuyen/sniffly: https://github.com/chiphuyen/sniffly ／ https://sniffly.dev/
- [C9] PixelPaw-Labs/codex-trace: https://github.com/PixelPaw-Labs/codex-trace
- [C10] openai/codex Discussion #24042（macOS ネイティブ viewer）: https://github.com/openai/codex/discussions/24042
- [C11] wondercoms/codex-logs: https://github.com/wondercoms/codex-logs
- [D1] Devin Session Tools docs: https://docs.devin.ai/work-with-devin/devin-session-tools
- [D2] Cognition blog（How Cognition Uses Devin / Session Insights 言及）: https://cognition.ai/blog/how-cognition-uses-devin-to-build-devin
- [CU1] Cursor Diffs & Review docs: https://docs.cursor.com/agent/review
- [CU2] Cursor Checkpoints docs: https://cursor.com/docs/agent/chat/checkpoints
- [WS1] Windsurf (Devin Desktop) Cascade docs: https://docs.windsurf.com/windsurf/cascade/cascade
- [AM1] Amp Owner's Manual: https://ampcode.com/manual
- [V1] VS Code Marketplace — Claude Code and Codex Assist (agsoft.claude-history-viewer): https://marketplace.visualstudio.com/items?itemName=agsoft.claude-history-viewer

### diff⇄会話リンク
- [GH1] GitHub REST API — PR review comments（line/side/position アンカー）: https://docs.github.com/en/rest/pulls/comments ／ Working with comments: https://docs.github.com/en/rest/guides/working-with-comments
- [CR1] CodeRabbit Review docs: https://docs.coderabbit.ai/pr-reviews/coderabbit-review ／ Semantic Diff blog: https://www.coderabbit.ai/blog/introducing-semantic-diff
- [O1] OpenHands/trajectory-visualizer: https://github.com/OpenHands/trajectory-visualizer ／ hosted: https://trajectory-visualizer.all-hands.dev/
- [S1] SWE-agent Trajectory inspector docs: https://swe-agent.com/latest/usage/inspector/ ／ Output files: https://swe-agent.com/latest/usage/trajectories/ ／ mini-SWE-agent inspector: https://mini-swe-agent.com/latest/usage/inspector/
