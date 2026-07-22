# 新基盤への持ち越し資産台帳（cr-keep-assets）

- 作成: 2026-07-08／対象 repo: `/Users/cherie/LLMWiki/projects/lathe`（read-only 監査）
- 方法: adr/・design/・rubrics/・scripts/・ops/ の実ファイル照合＋ `gh issue view`（読み取りのみ）
- 判定凡例: **採用** = 実証済み・持ち込む／**採用（設計のみ）** = 設計は承認済みだがコード未実装／各項に一次証拠を付す。確認できなかった点は「未確認」と明記

---

## A. 持ち越すべき資産（10 件）

### ① 状態は保存せず正本から導出 — 採用

- **実証（事故）**: 二重帳簿の同期事故。main worktree 上の未コミット backlog 編集が FF を黙って失敗させ、手元 main が 4 commit 遅れた（2026-07-05、`adr/0031-issues-as-task-substrate.md` 背景 11–13 行）。根本原因は「git/GitHub が既に知っている事実の repo 内二重記録」（同 15–16 行）。
- **実証（成功）**: orchestrator が gh から全状態を導出して実走。issue #204（CLOSED「gh から全状態を導出する snapshot 層（保存しない・ADR 0031）」）→ `scripts/orchestrator-derive.mjs`（＋ `orchestrator-derive.test.mjs`）。case 実機で pass complete まで完走ログあり（`design/runbooks/case-orchestrator-residency.md` 108–125 行、`dispatched=1 deferred=0 projected=2`）。
- **持ち込み形態**: **原則**（ADR 0031 の決定文＋`design/loops.md` 原則節「状態は保存せず gh から導出」）。導出層の実装（orchestrator-derive.mjs）は**コード参考**として可搬。

### ② loop 本体を loop で改修しない・版固定 release — 採用

- **実証（事故→成功の対照実測）**: `adr/0036-harness-release-loop.md` 実測根拠節（2026-07-07）。loop 自身に #201 を回した場合: 確定済み plan の再生成 25 分×2・FILE_CHILDREN 書式クラッシュ×2・ASK_PDM 空振り＝「改修対象の不完全さが改修作業自体を破壊」。outer 一括編成（bootstrap）切替後: 15 スライスを 4 波 8 PR で数時間内に全着地、前置 review が着地前に real major 2 件（投影シグネチャ・stale fixture）を捕捉。
- **持ち込み形態**: **原則**（ADR 0036＋`design/loops.md` harness-release 行「走行中の loop 自身に改修を食わせない」）。

### ③ 切替検収の 4 点基準 — 採用（基準は承認済み・ADR 追記は未着地）

- **基準本文（一次証拠）**: issue #282 本文 scope 3:「実 dispatch 1 件で (a) live marker が 1 パス以上生存 (b) claude 応答 (c) 最初の成果物が期限内に issue 上に出現 (d) outcome=success 記録 — の機械照合をもって切替完了と宣言」。PdM 承認 2026-07-08「いいだろう」（#282 本文末尾）。
- **実証（事故からの帰納）**: 検収なし切替が実弾を止めた実測 2 件。(1) issue #281: systemd cgroup 回収で dispatch 子プロセスが「産まれた直後に全滅」・信号ゼロ（run ログ 0 byte・DONE 行なし・issue 痕跡なし）・発見まで 1 時間超（PdM の質問起点）。(2) issue #282: 環境差 3 件（cgroup 回収／claude OAuth 欠落／pnpm 欠品）がすべて case ローカル応急処置のまま正本未反映。
- **未確認**: ADR 0036 への追記 landing（#282 は OPEN）。4 点基準での検収 GREEN 実績そのものは未確認（基準は事故の帰納であり、適用実績はまだ無い）。
- **持ち込み形態**: **原則＋データ**（検収チェックリスト 4 項をそのまま新基盤の切替手順に転記）。

### ④ plan 契約（6 セクション＝5＋見積り欄・過小 RED）— 採用

- **契約の正本**: `design/plan-format.md`（adopted 2026-07-05）。完全形 6 セクション = 問題／選択肢／方針／契約／検証／**見積り**（見積り欄は #189 → PR #267、commit bbdeffd 2026-07-08 で 5→6 に拡張）。正準 1 行フォーマット `見積り: diff ~<N> 行 / <M> ファイル・implement ~<T> 分`。
- **過小 RED の機械結線**: `scripts/inner-loop-prompts.mjs:388`「4. 見積りの宣言と妥当性（…無宣言、または scope に対し明らかに過小な見積りは RED）」（PLAN_REVIEW 検査項目）。
- **実証（事故）**: 契機 2 件が文書内に接地。(1) ADR 0025 manifest drift 事後監査（plan が型設計を要求しなかった、plan-format.md ヘッダ）。(2) `appendManifestEntry` の二重入口事故（同一情報が 2 つの入口から入り片方だけ配線、plan-format.md 設計原則節）。粒度側は issue #189（CLOSED「1 agent が数十分 task を抱える状態をなくす」）。
- **持ち込み形態**: **データ**（plan-format.md 全文）＋検査項目文言（prompt 内検査 4 項）。

### ⑤ escalation triage 三分岐 — 採用（実装形は「2 値＋前段吸収」）

- **設計**: `adr/0035-unified-task-lifecycle.md` §4（①コンテキスト不足→自動再試行 ②環境要因→playbook 対処 or 修理 task 自動起票 ③意思決定→needs-review＋背景教材）。
- **実装**: `scripts/inner-loop-escalation-triage.mjs`（#117 / PR #273、commit e36ee10）。実装上は ①context を出口前の bounded-retry（`runStageWithUnparsableRetry`）が吸収し、出口は environment（REBASE_CONFLICT / MAIN_DIRTY_BACKSTOP → 修理 issue 自動起票）／decision（needs-review 付与）の 2 値。unit test あり（`scripts/inner-loop-escalation.test.mjs` 97 行以降）。
- **価値の根拠**: 「自動吸収可能な事象を PdM 裁定キューに流さない」（triage-mjs 冒頭コメント）＝ needs-review 単一キュー（ADR 0035 §2）の前提装置。**未確認**: 実弾 escalation での三分岐発動実績（runbook 上は ESCALATE 不発動の記録のみ）。
- **持ち込み形態**: **原則**（三分岐の分類規約）＋**コード**（純関数 `classifyEscalation`＋test は小さく可搬）。

### ⑥ rubric の中身（検査内容）— 採用（データとして。枠組みは落とす）

- **実測**: `rubrics/**/rubric.json` = **48 本・checks 計 58**（node で機械計数。`file-size/gf-baseline.json` はベースラインデータで除外）。**候補記載の「47 本」とは 1 本差** — 47 の出典は未確認（計数時点差とみられる）。
- **実証（事故接地の例）**: 各 rubric の `origin` フィールドが事故・裁定に接地している。例: `apps/web/scripts/ingest/incremental-no-wipe`（2026-06-26 resetDatabase による DB 全 wipe の破壊性）、`meta/tests-accompany-changes`（2026-06-23 オーナー指示・unit 7→64 に育てた基盤の恒久 gate）、`harness/structural-guarantee-before-prompts`（⑧参照）。
- **持ち込み形態**: **データ**（schema_v2 JSON を origin・checks・examples ごと移送。ADR 0038 §5「統治 context = 契約のデータ化（repo＋DB）」の入力になる）。

### ⑦ 教材 2 段化の方向（#288）— 採用（要件データとして。実装は未着手）

- **一次証拠**: issue #288（OPEN・labels: task-request / needs-review / escalation / done-explain）。plan 段教材 = TL;DR＋図中心・読了 3 分予算・読者は「Ready 判断をする PdM」only／PR 段解説 = driver 産 PR 作成時に同 Discussion へ自動追記。
- **実証（負例の実物）**: Discussion #284 §1.4「ADR 0031 が延長する原理」・§1.5「ADR 0036 が接続する先」— PdM 評価「やばすぎる。なんの意味がある説明なんだこれ」（#288 本文に転記）。さらに実証された教訓:「形容詞注文（わかりやすさ重視で丁寧に等）は密度制御に無効 — #278 教材で実証・むしろ増量に働いた。契約は構造（予算・節・禁則・自己点検）で書く」（#288 本文）。
- **持ち込み形態**: **原則＋データ**（#288 の要件仕様＝構造契約 5 項をそのまま。コードは存在しないので持ち込み対象外）。

### ⑧ 「プロンプトより機械的保証」rubric — 採用

- **一次証拠**: `rubrics/harness/structural-guarantee-before-prompts/rubric.json`。origin: PdM 裁定 2026-07-08「プロンプトに頼る前に、それを他の機械的な方法で既存の harness に組み込む形で保証できないかどうかを考えること」。契機は PLAN_REVIEW 差分審査不能事故で「planner に全文再掲をプロンプト強制」案が先に出た設計不良（正解は reviewer への issue スレッド再取得＝配管）。
- **実証**: #189 の教訓「散文契約は silent に壊れる」（origin に明記）＋ ADR 0036 実測の FILE_CHILDREN 書式クラッシュ（散文 prompt 契約の型事故の実例）。
- **持ち込み形態**: **原則**（新基盤の設計レビュー恒久観点）＋**データ**（judge prompt・pass/fail examples を含む rubric JSON そのもの）。

### ⑨ worktree 隔離・単一 writer — 採用

- **実証（事故 2 件）**: (1) 2026-06-19、a11y chip と T2 修正が main worktree で交錯し premature な gate 改変が混入（`AGENTS.md` 協働の worktree 規律節）。(2) 2026-06-26、chip（spawn_task）が「ingest loose 型 43→38 削減」に見えて実は外部 transcript JSON 検証戦略という設計判断を gate 迂回で機械実行 → **chip 全面禁止**（同節）。
- **機械検証**: `scripts/harness-separation.test.mjs`（#225 / PR #272、commit af1da83「物理分離の機械検証 — inner worktree に統治 hook が掛からず repo root には掛かる」）。
- **持ち込み形態**: **原則**（編集ごと隔離・main は監査役単独 writer・chip 禁止）＋**コード**（分離検証テストの手法）。

### ⑩ ADR 0038 loop-domain 境界則 — 採用（設計のみ・コード未実装）

- **一次証拠**: `adr/0038-loop-domain-and-context-boundaries.md`（accepted 2026-07-08、PdM「DDD については承認するから通していい」）。ADR 自身が「本 ADR 自体はコード変更を伴わない」と明記（影響と移行節）。
- **境界則の中身**: 別プロセス API サーバ新設禁止／`packages/loop-domain` は I/O ゼロ純ドメイン（fs/pg/gh すべて import 禁止・dependency-cruiser `pure-core-no-io` で機械強制）／GitHub 非依存（task 状態の正は GitHub のまま＝ADR 0031 継承）／**二重台帳の禁止**／4 context 表（観測=DB・駆動=DB・統治=repo＋DB・task=GitHub 導出のみ）／UI はプロセス直起動せず「意図を DB に書く」。
- **実証性の根拠**: 各則が既発事故に接地（二重記録事故=ADR 0031 背景、散文 prompt 型事故=#189 を wave ③ で構造封じ、fs 混入の実測=`inner-loop-core.mjs` の「fs-read-only は I/O ゼロではない」現状記録）。実装実績はゼロ＝**設計として持ち込む**。
- **持ち込み形態**: **原則**（ADR 0038＋`design/loop-domain-architecture.md`。新基盤ではむしろ最初からこの境界で建てる）。

---

## B. 落とすべきもの（対のリスト）

| # | 遺物 | 証拠 | 処置 |
|---|---|---|---|
| 1 | **merge.mjs 型の driver 内 merge ゲート** | 本体は解体済み（commit fb129ac「merge.mjs 解体 — 着地 3 手を driver 直実行へ (#115, ADR 0030 §3)」）。残骸が `.claude/worktrees/agent-a45116b314fc4237e/scripts/merge.mjs`・`.claude/worktrees/keigo/scripts/merge.mjs` に残留 | 設計ごと持ち込まない。着地ゲートは PR+CI 単一（ADR 0026）で開始 |
| 2 | **二重データ層（manifest ⇄ DB）** | `apps/web/db/schema.sql:24`「Derived inner-loop run manifests. The source of truth is …」＝ DB が manifest の二次コピー。ADR 0038 背景が「データ層が二重」と名指し、wave ①③ で DB 一次化予定 | 新基盤は run telemetry を最初から単一正本（DB 一次）で。manifest ファイル正本は持ち込まない |
| 3 | **run.mjs / select.mjs の枠組み**（計 376 行、実測 wc -l） | repo 固有の runner 配管。枠組み由来の構造衝突の実例 = `meta/no-gate-tampering` 廃止（gate 変更 PR と構造衝突、AGENTS.md 2026-06-23）。後継方向は ADR 0038 §5「統治 = 契約のデータ化」 | 枠組みは落とし、⑥の rubric **中身**だけデータ移送 |
| 4 | **Backlog.md / backlog/・intake 写し・task-id-unique check** | ADR 0031 §3 で廃止済み（二重帳簿の輸入元） | 再導入しない（①の対） |
| 5 | **セッション外 memory・SESSION-HANDOFF 遺物** | PdM 裁定 2026-07-08「メモリなんていう不確実なものに頼ることはない」（`ops/outer-harness/discipline.md` 冒頭）。repo root に `SESSION-HANDOFF.md`・`SESSION-HANDOFF-2026-06-09.md` が残留 | 規律正本は repo 内文書のみ。handoff ファイルは持ち込まない |
| 6 | **散文 prompt テンプレート**（`scripts/inner-loop-prompts.mjs` 形式） | ADR 0038 背景「prompt は散文であり、#189 のような型事故（書式クラッシュ）の温床」＋ ADR 0036 実測（FILE_CHILDREN クラッシュ×2） | 検査観点の**文言**はデータ化して持ち込み（④⑧）、埋め込み文字列テンプレート形式は落とす |
| 7 | **meta-loop.mjs（感知 loop）** | `design/loops.md` 27 行「実走実績ゼロ・未通電」 | 実証なし＝コードは持ち込まない。result-classification の taxonomy 文書は判断材料として保留（実走ゼロのため「実証済み資産」には数えない） |
| 8 | **Mac launchd 常駐**（`ops/launchd/`） | case systemd へ cutover 済み（issue #247 CLOSED）。AGENTS.md の「launchd の orchestrator が常駐」記述は stale。**未確認**: #237（OPEN）が残余の退役作業 | 常駐は 1 ホスト 1 機構で開始。launchd 資材は持ち込まない |

---

## C. 未確認事項（明示）

1. 「rubric 47 本」の出典 — 実測は 48 本・58 checks。1 本差の由来は未確認。
2. ③ 4 点基準の適用実績 — 基準は PdM 承認済み（#282）だが、4 点照合で GREEN 宣言した切替の実例は未確認（#282 OPEN・ADR 0036 追記未着地）。
3. ⑤ triage の実弾発動実績 — 実装＋unit test は確認、実 escalation での分岐実績は未確認。
4. ⑦⑩ はコード未実装（#288 OPEN・ADR 0038 は文書のみ）— 「実証済み」なのは方向を根拠づける負例・事故であり、実装自体ではない。
5. #237（Mac launchd 退役の残余）と #247（CLOSED）の分掌 — issue タイトルが重複しており、退役の完了範囲は未確認。
