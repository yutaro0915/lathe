# 開発基盤 incident 台帳（2026-07-05〜07-08）

- 対象 repo: /Users/cherie/LLMWiki/projects/lathe（read-only 調査）
- 情報源: adr/0030〜0038・ops/outer-harness/discipline.md・design/loops.md・issue #189〜#302（gh 読み取り）・.lathe/runs/（escalation md・outcomes.jsonl）
- 記法: 各行 = `[日付] 事象 1 行 | 根因分類 | 一次証拠`。確認できなかった点は「未確認」と明記。
- 分類軸 = [環境差 | 情報配管の欠落 | prompt 依存の脆さ | 外部 API 癖 | プロセス管理 | 統治プロセス]

## 台帳

### 環境差（launchd/systemd/認証/依存欠品）

- E1 [07-08] launchd→systemd 移行で systemd 既定の cgroup 回収により dispatch された detached 子プロセスが産まれた直後に全滅（応急: case ローカル drop-in `KillMode=process`） | 環境差 | issue #281 本文「systemd の cgroup 回収により…全滅」・#282 ①
- E2 [07-08] claude OAuth トークンが systemd unit 環境に無く、case の TASK_PLAN が「Not logged in · Please run /login」で UNPARSABLE 終端（応急: local EnvironmentFile） | 環境差（認証） | issue #236 comment 2026-07-08T03:06:03Z（escalation 転記）・#282 ②
- E3 [07-08] case に pnpm 欠品で導入が停止（応急: nix profile 導入） | 環境差（依存欠品） | issue #282 本文 ③
- E4 [07-08] E1〜E3 の応急処置がすべて case ローカルのみで repo 正本（ops/systemd/・install script）に未反映＝「次の導入先で全部再発する」状態 | 環境差（恒久化欠如） | issue #282 本文

### 情報配管の欠落（reviewer 差分不達・成果物 transcript 死蔵）

- P1 [07-07] plan-task の ASK_PDM 終端で成果物（plan 全文・子 issue block 群）が自 transcript にのみ存在し issue には要約 comment だけ＝完成 plan が観測面のどこにも残らない。#171 で消失未遂が発生し監査役が runner transcript から手作業で発掘・復元 | 情報配管の欠落（transcript 死蔵） | issue #239 本文「2026-07-07 に #171 で発生」
- P2 [07-07] PLAN_REVIEW の RED 理由（envelope.result）が TASK_PLAN 再試行の stageCtx に渡らず、修正周回（ADR 0035 §5）が盲目再生成になっていた（#186 実装の着地済み欠陥） | 情報配管の欠落（所見不達） | issue #192 Major #2（PR #191 review 所見が正本）
- P3 [07-07] PLAN_REVIEW prompt に issue comments が注入されず、コメント文脈に基づく plan を審査できない（false RED 要因） | 情報配管の欠落 | issue #192 Minor #4
- P4 [07-08] stage 起動時の情報注入契約が不在＝機械が既に知る情報を agent が毎回再発掘（IMPLEMENT の bash 約半分がナビゲーション: 探索 37%＋git 確認 11%。LAND reviewer は発火 rubric の scope 照合＝決定的計算を毎回自力実施） | 情報配管の欠落 | issue #301 本文（meta-audit 検証済み finding）

### prompt 依存の脆さ（契約文言短縮・差分再掲・散文契約）

- F1 [07-07] plan-task の FILE_CHILDREN が書式クラッシュ×2 —「plan is missing required "Title:" line」＋ blocked-by の plan#k 前方参照を filing が解決できず失敗。確定済み plan の 25 分×2 再生成を誘発 | prompt 依存の脆さ | .lathe/runs/plan-201.escalation.md・issue #201 comments（09:00:05Z / 09:02:11Z / 09:32:16Z）・ADR 0036 実測根拠
- F2 [07-08] explain 配信の Discussion 本文が教材の中身でなく `@<パス>` 1 行の空の殻（#292・#295 の 2 件）。SKILL.md が body の渡し方を未規定で runner が gh コマンドを即興（`-f body=@path` literal） | prompt 依存の脆さ（散文契約の未規定） | issue #299 本文（本文 64 字/59 字の実測。使用フラグ自体は「未確認だが症状から機構は確定」と issue 明記）
- F3 [07-08] 教材 4 択の正解位置が b に 66% 偏在（40 問中 b=29。bbbbb の教材 2 本）＝散文指示「自由に配置せよ」では直らない LLM 位置バイアス | prompt 依存の脆さ | issue #258 本文（grep 再現手順つき実測）
- F4 [07-08] verdict-guard Stop hook が完了済み review の全文再出力を強制し review 1 回あたり全文 2 回生成＝ほぼ二重課金（#254 の plan 系 $9.97 の一因） | prompt 依存の脆さ（差分再掲の強制） | issue #302 本文（一次証拠 = #229 PLAN_REVIEW result_text 冒頭の自己申告）

### 外部 API 癖

- A1 [07-07〜08] `API Error: Unable to connect to API (FailedToOpenSocket)` で #229 の LAND_REVIEW が 18.7 分ハング＋53.4 分の in-process 空白（計 ~72 分・課金ゼロ）。同一通信断で escalation の label 付与・comment 投稿も失敗し、痕跡ゼロのまま orchestrator が「open PR=In Progress」と誤読して永久 WAIT_PR（監査役の手動 resume で回収） | 外部 API 癖（＋dead-driver 検知欠如＝プロセス管理の側面） | issue #254 本文（依拠 Discussion #251 meta-audit）
- A2 [07-07] GitHub Projects の盤面列再構築で Status option id が全再生成され、driver の id 直書き定数（inner-loop-projects.mjs）が stale 化 → Ready 検出・投影が停止（hotfix で新 id に差し替え） | 外部 API 癖（＋ハードコード） | issue #201 comment 2026-07-07T09:00:03Z「incident 記録」
- A3 [07-08] `gh pr merge --auto` が既に clean な PR に対し「Pull request is in clean status」で失敗する gh/GraphQL 仕様により arm 失敗 | 外部 API 癖 | issue #254 Scope 追記（#239 の PR #250 で実測）

### プロセス管理（cgroup 回収・detached 死・stale worktree/marker）

- M1 [07-05] main worktree 上の未コミット backlog 編集が FF を黙って失敗させ、手元 main が 4 commit 遅れた（worktree ごとの backlog/ コピー＝二重記録が根本） | プロセス管理（stale worktree） | ADR 0031 背景（2026-07-05 事故の明記）
- M2 [07-07] resume 破壊: recordAttempt が TASK_PLAN/PLAN_REVIEW も manifest に書くのに decideResumeState が IMPLEMENT 起点前提のまま → plan 段を通った run の `--resume` が常に失敗 | プロセス管理 | issue #192 Major #1
- M3 [07-07] 実行中検出が worktree の有無だけで、worktree を持たない plan-task 実行を見逃し二重 dispatch する欠陥を実測 | プロセス管理（marker 不備） | issue #201 comment 2026-07-07T09:28:39Z「本日実測で確認」
- M4 [07-07] M3 が実弾化: #171 の plan-task が並行実行（orchestrator dispatch × 監査役の直接 rerun の race・15:18Z）され子 issue 8 件が二重投函（#241〜#248 が #231〜#238 の重複）→ 全件手動 close | プロセス管理（二重 dispatch） | issues #242/#245/#246/#247 の「重複 close」comment（同文 4 件）
- M5 [07-07] PR 作成済み（push 済み）run の CHANGES 差し戻しで stage 前 rebaseWorktree が push 済み履歴を書き換え、rework 後 push が non-FF 拒否（FF-only 規律）→ rework 成果があるのに escalation 停止 | プロセス管理 | issue #229 本文（#224 実測: remote 5d9c86f vs local 946676c の同一変更別 sha 化）
- M6 [07-08] 常駐 orchestrator に self-update 係が不在＝ローカル main が origin/main から 5 commit 遅れで走行し、merge 済み（15:39Z・PR #249）の hold 機能を知らない旧コードが hold 付き #235 を dispatch → 無駄な escalation 発生 | プロセス管理（stale 常駐） | issue #263 本文・#235 comment 2026-07-07T16:23:03Z（escalation 転記）
- M7 [07-08] orchestrator の pass 内 dispatch が同期実行のため、パス間隔が median 15 分・最大 51.9 分（launchd StartInterval は 300 秒）＝Ready→着手リードタイム p95 52 分 | プロセス管理 | issue #256 本文（Discussion #251 meta-audit 実測）
- M8 [07-08] explain の二重生成: 同一 issue #281 に 8 秒差で Discussion 2 本（#294/#295・片方破損）。Mac 側 ledger でも EXPLAIN #236 が 03:17:50Z / 03:20:11Z の 2 回記録 | プロセス管理（dispatch 重複） | issue #299 本文・.lathe/runs/outcomes.jsonl 実測
- M9 [07-08] silent death の検知機構ゼロ: E1 の全滅が run ログ 0 byte・DONE 行なし・issue 痕跡なしで、発見まで 1 時間超（発見も PdM の質問起点） | プロセス管理（検知欠如。死因は E1=環境差） | issue #281 本文
- M10 [07-07] Agent tool の isolation worktree 由来と疑われる stray `.claude/worktrees/agent-*/.claude/settings.local.json` を実測（物理分離検証の反証。生成元の特定は #225 で「特定まで・修正は別 issue 化」＝原因未確認） | プロセス管理（stray 生成物） | issue #225 本文「実測の反証あり」

### 統治プロセス（無承認起票・scope 混入・承認シグナル汚染）

- G1 [07-07] loop 外の無承認起票 2 回（#190・#193 を PdM 承認なく起票）→「起票は PdM 明示承認後のみ」規律確定＋hook 機械強制 | 統治プロセス（無承認起票） | discipline.md L9「違反 2 回の教訓」・issue #201 comment 09:14:08Z「違反実績 #190/#193」
- G2 [07-07] agent が教材 Discussion に勝手に upvote（汚染 1 件 = Discussion #172・除去済み）。agent は PdM の gh 認証で動くため API 上 PdM のリアクションと区別不能＝承認シグナルの意味論が壊れる | 統治プロセス（承認シグナル汚染） | ADR 0034 背景・§4
- G3 [07-07] #116 実装が ADR 0030 追記 A を読み違え「needs-plan 無し = 直接実装可」の誤レールを敷いた（実装専用 issue は存在しないが正・PdM 指摘） | 統治プロセス（規範誤読の実装混入） | ADR 0035 背景
- G4 [07-07] 「review 前に merge され得る」設計（auto-merge arm を PR 作成時に実施する #116 実装時の監査役裁定 1）が混入 → ADR 0035 追記で差し戻し（PASS 後 arm へ） | 統治プロセス | ADR 0035 追記
- G5 [07-07] 起票承認ゲート（hook＋セッション外 memory 由来の規範）が in-loop の機械起票（FILE_CHILDREN）まで誤ブロックし ASK_PDM 空振り → PdM 恒久裁定「ゲート対象は loop 外の起票のみ」でスコープ限定 | 統治プロセス（ゲート誤適用・規範誤読） | issue #201 comments 09:14:08Z / 09:18:19Z・ADR 0036 実測根拠「規範誤読の ASK_PDM 空振り」
- G6 [07-07] 走行中の loop 自身に loop 改修 task（#201）を食わせ、確定済み plan の 25 分×2 再生成＋F1 のクラッシュ×2 を誘発＝「改修対象の不完全さが改修作業自体を破壊」→ ADR 0036（harness-release loop）新設 | 統治プロセス（自己改修の統治欠如） | ADR 0036 実測根拠（2026-07-07）
- G7 [07-08] 監査役の環境整備の先行実施（PdM 指示の loop 外直接作業）で issue #235 本文の前提とコード/運用の現実が乖離 → TASK_PLAN が前提乖離で ESCALATE（受理・rescope） | 統治プロセス（outer 並行作業と loop の座標ずれ） | issue #235 comments 16:02:46Z / 16:23:03Z / 16:30:17Z
- G8 [07-08] PdM 裁定「plan 確定 issue に scope を追加しない・必ず新 issue」（plan と body の乖離が review・実装の接地を壊すため）。裁定の直接契機となった個別事故は未確認（#236 comment に「plan 確定済みのため scope 追記はせず（2026-07-08 規律）」と運用適用の記録あり） | 統治プロセス（scope 混入・裁定） | discipline.md L18-19・issue #236 comment 16:45:34Z
- G9 [07-08] PdM 裁定「セッション外 memory 全廃・機械的に検証できる repo のみを正とする」（G5 の hook がセッション外 memory `pdm-issue-filing` に依存していた事実あり）。裁定の直接契機となった個別事故は未確認 | 統治プロセス（裁定） | discipline.md L3-5・~/.claude/projects/.../memory/MEMORY.md（tombstone）・issue #201 comment 09:14:08Z（memory 依存の証跡）

### 参考（事故未満・ゲートが機能した例 / 構造的弱点の言語化）

- R1 [07-08] #288 の plan が確定契約節に実装と矛盾する技術前提（PR-kind decision の Touches 直列化は `decisionTouches` が常に [] を返すため不成立）を含み、PLAN_REVIEW が 2 周 RED → escalation（検査が機能した例） | — | issue #288 comment 05:10:38Z
- R2 [07-08] CI が「ザル」（テスト/rubric 資産の全量が CI に載っていない基盤構築期の構造的弱点）と自己認定・設計 task 化 | — | issue #279 タイトル・本文
- R3 [07-08] plan 段教材の情報密度過多で意思決定（Ready 移動）の材料として機能しない → 教材 2 段化の要件化 | — | issue #288 本文（PdM 提起）

## 集計（incident 26 件。R1〜R3 は除外）

| 根因分類 | 件数 | 該当 |
|---|---|---|
| プロセス管理 | 10 | M1〜M10 |
| 統治プロセス | 9 | G1〜G9（うち G8/G9 は裁定・契機事故は未確認） |
| 環境差 | 4 | E1〜E4 |
| prompt 依存の脆さ | 4 | F1〜F4 |
| 情報配管の欠落 | 4 | P1〜P4 |
| 外部 API 癖 | 3 | A1〜A3 |

（注: 複合事故は主根因で 1 カウント。A1 は検知欠如＝プロセス管理の側面、M9 は死因＝環境差 E1 と表裏。合計はのべ件数でなく台帳行数ベース = 26+参考 3）

## 導出: 新基盤が構造的に不可能にすべき事故クラス

件数と再発性（同型が窓内で複数回実弾化したか）から、次の 5 クラスは「規範・prompt・運用注意」でなく**構造**で不可能化すべき。

1. **二重 dispatch / 二重生成**（M3→M4 で予見→実弾化、M8 で explain でも再発。窓内 3 回）
   — 実行中状態を fs マーカー・worktree 有無から導出する限り再発する。dispatch の単一 writer 化＋一意性制約（DB 一次の RunStore、ADR 0038 §6）で「2 本目が物理的に生成できない」形にする。
2. **stale 常駐・stale 定数**（M1・M6・A2。「merge 済みの改善を取り込む係が存在しない」構造欠陥）
   — 版固定の LoopDefinition（ADR 0036/0038）＋パス冒頭 ff-only self-update（#263）で、旧コード・旧 id での走行を構造的に排除。外部 id は名前解決（#201 comment の子 task 要求）でハードコード自体を禁止。
3. **成果物・所見の transcript 死蔵**（P1〜P3・A1 の escalation 投影失敗。「issue/DB に無ければ存在しない」）
   — stage の終端契約を「正本への投稿完了」まで含めて機械執行（#239・#203）し、投稿失敗は manifest 記録＋次パス補償（#254 ③）。注入は stage ごとの契約表（#301）で「agent が探す」経路を遮断。
4. **散文契約に依存する I/O**（F1〜F4。書式クラッシュ・空の殻・位置バイアス・hook 誤判定はすべて「機械で決められることを散文で指示した」帰結）
   — prompt 契約を構造化データ化（ADR 0038 §2「散文の埋め込み文字列テンプレートではない」・wave ③「散文 prompt の追放＝型事故の構造的封じ」）、配信は決定的スクリプト（#300）、配置は決定的規則（#258）。
5. **silent death**（E1×M9・A1。「死んだことをどこにも言わずに死ぬ」）
   — 起動記録×live marker×outcome の 3 点突合を原因非依存で常設（#281）し、環境前提は install self-check＋切替検収 4 点基準（#282）で導入時に機械検出。KillMode 等の環境差は repo 正本に恒久化。

統治プロセス（G 系）は件数最多級だが、その大半（G1/G2/G4/G5）は 2026-07-07〜08 の裁定＋hook＋物理分離（#206/#224/#225: tracked=.claude/=inner・統治 hook=untracked local 層）で既に構造化が進行中。残る構造穴は **単一 gh アカウント運用に起因する承認シグナル汚染（G2。現状は行動規範＋meta 検出のみ＝ADR 0034 §4 が自認する限界）**であり、新基盤では承認入力（Ready 移動・close）を agent 資格情報と分離された面に置くことが必要。

---
作成: 2026-07-08 / 調査コマンド例: `gh issue view <n> --json body,comments`・`ls -la .lathe/runs/`・`cat .lathe/runs/outcomes.jsonl`
