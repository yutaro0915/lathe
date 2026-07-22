# 外部分析用ブリーフィング — 自律開発ループの失敗分析と基盤再構築の裁定材料

## 0. この文書は何か・どう読むか

- 個人開発者 1 人（以下 PdM）＋ LLM agent 群が運用してきた**自律ソフトウェア開発ループ**（GitHub 上で task 管理・agent が計画/実装/レビュー・人間は承認のみ）が、2 日間の集中運用の末に「code red」（全面停止・基盤の作り直し宣言）に至った。本書はその**失敗の全記録と、再構築の設計材料**を、この経緯を一切知らない外部の分析 AI に渡すための自己完結文書である。
- 読み方: §1–2 が事実（何が起き、なぜ壊れたか)、§3–4 が意図（何をやりたかったか、前提のどこが間違っていたか)、§5–6 が設計材料（二案比較・durable execution の適合)、§7 が未決の裁定点と**あなた（分析者）への具体的な問い**。付録に用語集。
- 記法: 本文の主張には可能な限りタグを付す — **[事実]**（一次証拠あり)・**[仮説]**（設計上の見立て)・**[critique]**（敵対レビューの主張・設計側未応答)・**[未確認]**。issue/PR 番号は内部参照だが、内容は本文に収載してあるので外部から辿る必要はない。

## 0.1 全体 TL;DR

1. 作っていたもの: GitHub issue = task とし、agent が plan 作成 → 機械 plan 審査 → 実装 → 着地前レビュー → PR+CI で main へ、を無人で回すループ。人間（PdM）は label/盤面操作による承認と裁定のみ。[事実]
2. 実測規模: 2 日で 66 run・326 stage・LLM 費用 $150.9・最大 1 日 8 件の変更着地。1 task の固定オーバーヘッド 25–40 分。[事実]
3. 2 日間で incident 26 件。根因分布: プロセス管理 10・統治プロセス 9・環境差 4・prompt 依存 4・情報配管 4・外部 API 癖 3。[事実]
4. 事故の典型: 同一 task の二重実行（3 回実弾化)・子プロセスの無痕跡死（silent death、発見が人間の質問起点)・書込失敗の握りつぶしによる永久待機・散文 prompt 契約の silent な破壊。[事実]
5. PdM の根因仮説: 個別の実装ミスではなく「**タスクの切り方・PR の使い方・状態の保ち方**」の設計自体が誤り。人間の非同期協働用に設計された GitHub を、分単位で回る機械の状態機械の基板として誤用した。[仮説 — §2 の incident 分布は 8 割方この仮説に載る]
6. 統一的な説明: 私たちは「分散ワークフローエンジン」を他人のサイトの上に手作りしていた。欠けていた部品の業界名は **durable execution**（排他・exactly-once・永続タイマー・生存監視・実行履歴・signal を primitive として提供する実行基盤）。[仮説]
7. 再構築の対抗案は 2＋1: (A) Claude Code routines（ベンダーのクラウド自動実行機能）に全面移行 (B) 最小カーネル自作 (C) hybrid。敵対 critique 双方の一致点: 実質の比較は「自作 vs hybrid」で、cloud 全面は両側から棄却。[critique]
8. その後の再フレーム: エンジン選定は Temporal self-host vs DBOS の二択に収束（routines は参考列)。GitHub は「起票・承認 UI・人間の読み物・PR+CI 着地」の遅い面に降格し、状態機械は持たせない。[仮説・設計 v1]
9. 観測の主権は譲れない条件: agent transcript の完全取得が本診断のすべてを可能にした。cloud 実行の観測は劣化形しか取れないことが実測照合済み。[事実]
10. 最重要の未決 = D-0「この製品（lathe）は駆動を所有するか、駆動を外部化して統治と観測に徹するか」。技術比較でなく製品戦略の判断。[未決]
11. 統治面の失敗も 9 件あり（agent が承認なしに issue を起票・スコープを改変等)。これはどの基盤を選んでも直らない別枠の問題として本書に含む。[事実]
12. あなたへの主要な問い: この根因診断への反証・D-0 の判断軸の欠落・エンジン選定の適正規模・GitHub 再設計の盲点・「LLM が設計しレビューし運用する体制」固有の未対処リスク（§7)。

---



# §1–2 現状と経緯・incident 全台帳（元資料 verbatim: code red charter 一次資料）

> 注: 以下は当日の統合調査文書の全文。§番号は元文書のもの。

# code red charter 一次資料（統合版）

- 作成: 2026-07-08／対象 repo: `/Users/cherie/LLMWiki/projects/lathe`（read-only。書き込み・コメント一切なし）
- 入力 4 本の統合: `cr-github-defects.md`（GitHub 連携不具合の機械照合）・`cr-incident-ledger.md`（incident 26 件台帳）・`cr-keep-assets.md`（持ち越し資産 10＋落とすもの 8）・`cr-runtime-requirements.md`（runtime 要件の実測導出）
- 記法: 全主張に一次証拠（issue/PR/Discussion 番号・ファイルパス・コマンド出力）。確認できなかったものは「未確認」と明記。入力間の矛盾は §6 に丸めず残す。
- incident ID（E/P/F/A/M/G 系）は cr-incident-ledger の行 ID、Q 系は cr-github-defects §3 の癖台帳、①〜⑩/B1〜B8 は cr-keep-assets の資産番号を指す。

---

## 1. TL;DR

1. **壊れているのは常駐実行系（orchestrator＋driver）と GitHub への書き込み面**。二重 dispatch/二重生成が窓内 3 回実弾化（子 issue 8 件重複 #241–#248・Discussion #294/#295、guard 追加 eca8247 の後も再発）、silent death は検知機構ゼロで発見が PdM の質問起点（#281）、escalation の書込失敗は「非致命 continue」で握りつぶされ永久 WAIT_PR（#229）。
2. 根因分布（incident 26 件）: プロセス管理 10・統治プロセス 9・環境差 4・prompt 依存の脆さ 4・情報配管の欠落 4・外部 API 癖 3。
3. 「Claude Code では動かない」は**不成立**（66 run manifest・326 stage・$150.9 完走実測）。ただし PdM 申告は 3 点で支持: 分離が settings 依存で fail-open（pin 貼り忘れ 2 箇所現存）・Stop hook の二重課金（#302）・headless の ask=自動拒否という対話前提の名残。
4. **残すもの = 原則と中身のデータ**: 状態導出（ADR 0031）・harness-release 分離（ADR 0036）・切替検収 4 点（#282）・plan 契約 6 セクション・escalation triage・rubric 48 本の中身・教材 2 段化要件（#288）・「プロンプトより機械的保証」・worktree 単一 writer・ADR 0038 境界則。
5. **落とすもの = 枠組みと遺物**: 散文 prompt テンプレ・manifest/DB 二重層・run.mjs/select.mjs 枠組み・Stop hook・セッション外 memory・launchd 資材・meta-loop コード（未通電）・merge.mjs 残骸・Backlog 遺物。
6. **新基盤への中核要求**: 二重実行の物理的不可能化（DB 一意性）・silent death 3 点突合の常設・権能分離 fail-closed（hook で聞かず credential を持たせない）・I/O の構造化（散文契約の追放）・終端契約の機械執行（書込失敗の補償）・spawn 単一モジュール・版固定＋self-update・環境前提の repo 正本化＋検収 4 点。
7. **PdM 裁定が要る未決 4 点**: runtime 選定／GitHub への依存度（状態正本・承認面）／lathe との分離境界（repo 内か別か）／観測の接続方式（adapter か直書きか）。

---

## 2. 問題台帳（検証済みのみ・重大度順）

未確認のもの（Q8 service token 混同・G8/G9 の契機事故・「監査役 session に関所 hook 不在」の一次記録）は本表から除外し §6 に記載。

### S1 — 系が黙って止まる／重複が実弾化する（構造で不可能化すべきクラス）

| # | 事象 | 根因分類 | 一次証拠 |
|---|---|---|---|
| S1-1 | **silent death**: systemd cgroup 回収で dispatch 子プロセスが「産まれた直後に全滅」。run ログ 0 byte・DONE 行なし・issue 痕跡なし。発見まで 1 時間超・PdM の質問起点。検知機構ゼロ | 環境差（E1）×検知欠如（M9） | issue #281 本文・#282 ① |
| S1-2 | **二重 dispatch→実弾化 3 回**: (a) 実行中検出が worktree 有無のみで plan-task を見逃す欠陥を実測（M3）→ (b) #171 の plan-task 並行実行で子 issue 8 件が二重投函・全件手動 close（M4、#241–#248）→ (c) explain でも再発、issue #281 に Discussion #294/#295 が 8 秒差で 2 本（M8）。**dedup 強化 commit `eca8247`（07-07）の後（07-08 05:40 UTC）に再発**＝窓は塞がり切っていない。EXPLAIN #236 も二重 dispatch 実測（orchestrator.log:1770-1791、outcomes.jsonl に success 2 件） | プロセス管理 | issue #201 comment 09:28:39Z・#242/#245/#246/#247 重複 close comment・#299・`.lathe/runs/outcomes.jsonl`・`.lathe/logs/orchestrator.log` |
| S1-3 | **書込失敗の fail-open 握りつぶし→系の誤読**: 通信断（FailedToOpenSocket）で #229 の LAND_REVIEW が計 ~72 分ハング（課金ゼロ）、同時に escalation の label 付与・comment 投稿が両方失敗（`issue-229.log:43-44`）。今日時点も未修復（labels=[task-request] のみ・comment 不在）。終了メッセージは**存在しない comment を指す**。orchestrator は「open PR=In Progress」と誤読して永久 WAIT_PR、監査役の手動 resume で回収 | 外部 API 癖（A1）＋fail-open 設計 | issue #254 本文・`.lathe/runs/issue-229.log:43-45`・gh issue view 229 照合 |
| S1-4 | **破損 stub が承認材料化**: Discussion 本文の `@file` が未展開のまま literal 投稿（#292 = 59 字・#295 = 64 字）。#288 の教材 Discussion は壊れた 1 本だけ＝PdM 承認ゲートの読み物が実質不在。投稿内容の検証層（post-check）が無い | prompt 依存の脆さ（F2）×検証層欠如（Q7） | issue #299 本文・Discussion #292/#295 本文実測（cr-github-defects §1.2） |

### S2 — 系が古い前提・壊れた配管のまま走る

| # | 事象 | 根因分類 | 一次証拠 |
|---|---|---|---|
| S2-1 | stale 常駐: self-update 係が不在で origin/main から 5 commit 遅れの旧コードが走行、merge 済み hold 機能を知らず hold 付き #235 を dispatch | プロセス管理（M6） | issue #263 本文・#235 comment 16:23:03Z |
| S2-2 | 外部 id の silent 失効: Projects 盤面列再構築で Status option id 全再生成 → id 直書きの Ready 検出・投影が silent に停止 | 外部 API 癖（A2/Q4） | issue #201 comment 09:00:03Z・#202・commit `afc67c1`/`0c05d73` |
| S2-3 | resume 破壊: recordAttempt は plan 段も manifest に書くのに decideResumeState が IMPLEMENT 起点前提 → plan 段を通った run の `--resume` が常に失敗 | プロセス管理（M2） | issue #192 Major #1 |
| S2-4 | rework 停止: push 済み run の CHANGES 差し戻しで rebaseWorktree が push 済み履歴を書き換え、non-FF 拒否 → 成果があるのに escalation 停止 | プロセス管理（M5） | issue #229 本文（#224 実測） |
| S2-5 | Stop hook の二重課金: verdict-guard が完了済み review の全文再出力を強制、review 1 回あたり全文 2 回生成（#254 の plan 系 $9.97 の一因） | prompt 依存の脆さ（F4） | issue #302 本文・#229 PLAN_REVIEW result_text 冒頭 |
| S2-6 | 分離破れ: inner spawn の settings が cwd 依存の暗黙 load（#224 で --settings pin 対処）だが、**pin 貼り忘れが 2 箇所現存**（`review-engine.mjs:301-309`・`meta-loop.mjs:289-291`、grep で settings 該当 0 件）。harness-separation.test.mjs の検査網の外 | 環境差×fail-open | issue #224・cr-runtime-requirements §3（機械確認） |
| S2-7 | plan 所見の不達: PLAN_REVIEW の RED 理由が再試行 stageCtx に渡らず盲目再生成（P2）。PLAN_REVIEW prompt に issue comments 未注入で false RED（P3） | 情報配管の欠落 | issue #192 Major #2・Minor #4 |
| S2-8 | 成果物の transcript 死蔵: plan-task の ASK_PDM 終端で plan 全文が自 transcript にのみ存在。#171 で消失未遂・監査役が transcript から手作業復元 | 情報配管の欠落（P1） | issue #239 本文 |
| S2-9 | FILE_CHILDREN 書式クラッシュ×2: 散文契約の型事故で確定済み plan の 25 分×2 再生成 | prompt 依存の脆さ（F1） | `.lathe/runs/plan-201.escalation.md`・ADR 0036 実測根拠 |
| S2-10 | 環境応急処置の未恒久化: cgroup 回収／OAuth 欠落／pnpm 欠品（E1–E3）の対処がすべて case ローカルのみ・repo 正本未反映＝「次の導入先で全部再発する」状態 | 環境差（E4） | issue #282 本文 |
| S2-11 | 承認シグナル汚染: agent が PdM の gh 認証で動くため upvote が API 上区別不能（汚染 1 件 = #172・除去済み）。現状は行動規範＋meta 検出のみ＝ADR 0034 §4 が自認する限界 | 統治プロセス（G2） | ADR 0034 背景・§4 |
| S2-12 | CI が「ザル」: テスト/rubric 資産の全量が CI に載っていない（自己認定・設計 task 化済み）。着地ゲートが PR+CI 単一（ADR 0026）である以上、ゲートの実効性を直撃 | 構造的弱点（R2） | issue #279 タイトル・本文 |

### S3 — 効率・品質・統治の劣化（再発防止は運用でなく構造に寄せる）

| # | 事象 | 根因分類 | 一次証拠 |
|---|---|---|---|
| S3-1 | dispatch 遅延: pass 内同期実行でパス間隔 median 15 分・最大 51.9 分（設定 300 秒）、Ready→着手 p95 52 分 | プロセス管理（M7） | issue #256（Discussion #251 meta-audit 実測） |
| S3-2 | ナビ再発掘: stage 起動時の情報注入契約が不在、IMPLEMENT の bash 約半分がナビゲーション（探索 37%＋git 確認 11%） | 情報配管の欠落（P4） | issue #301 本文 |
| S3-3 | 教材 4 択の正解位置バイアス: b に 66% 偏在（40 問中 29）。散文指示では直らない | prompt 依存の脆さ（F3） | issue #258（grep 再現手順つき） |
| S3-4 | gh 仕様癖の被弾: auto-merge は branch protection 必須（Q1/#94）・checks 出現前 watch の false negative（Q2/#98）・worktree checkout 中 branch 削除不可（Q3/#102）・clean status での arm 失敗（A3/#254 追記）・GraphQL label 操作の Projects classic 廃止エラー（Q5、escalation 経路は REST 未移行）・action の discussion_comment 拒否（Q6/`90c3a93`） | 外部 API 癖 | 各 issue 本文・commit（cr-github-defects §3） |
| S3-5 | 統治系: 無承認起票 2 回（G1、#190/#193）・規範誤読の誤レール（G3/G4）・ゲート誤適用の ASK_PDM 空振り（G5）・走行中 loop への自己改修投入が改修作業自体を破壊（G6）・outer 並行作業と loop の座標ずれ（G7、#235） | 統治プロセス | discipline.md L9・ADR 0035/0036・issue #201/#235 comments |
| S3-6 | 優先度 label の不在: AGENTS.md 規定「優先度=label」に対し priority 系 label が存在せず、#98/#102 は body 冒頭に「p1-high（label 未作成のため body 記載）」と退避 | 規範と実装の乖離 | `gh label list` 実測・issue #98/#102 本文 |
| S3-7 | 教材の情報密度過多: plan 段教材が Ready 判断の材料として機能しない（PdM 評価「なんの意味がある説明なんだこれ」= Discussion #284）。形容詞注文は密度制御に無効と実証 | prompt 依存の脆さ | issue #288 本文 |

### 構造で不可能にすべき事故クラス（cr-incident-ledger の帰納・5 クラス）

1. **二重 dispatch / 二重生成**（M3→M4→M8、窓内 3 回）— fs マーカー導出をやめ、DB 一次の一意性制約で「2 本目が物理的に生成できない」形へ。
2. **stale 常駐・stale 定数**（M1・M6・A2）— 版固定 LoopDefinition＋パス冒頭 ff-only self-update＋外部 id の毎パス名前解決。
3. **成果物・所見の transcript 死蔵**（P1–P3・A1）— stage 終端契約を「正本への投稿完了」まで機械執行、失敗は記録＋次パス補償。
4. **散文契約に依存する I/O**（F1–F4）— prompt 契約の構造化データ化・配信は決定的スクリプト・配置は決定的規則。
5. **silent death**（E1×M9・A1）— 起動記録×live marker×outcome の 3 点突合を原因非依存で常設＋install self-check＋検収 4 点。

---

## 3. keep / drop / rebuild 三分類表

凡例: **keep** = そのまま持ち込む（原則/データ/コード）・**drop** = 持ち込まない・**rebuild** = 要件は残し実装を作り直す。

| 構成要素 | 分類 | 具体 | 根拠 |
|---|---|---|---|
| **orchestrator** — 常駐 dispatch 本体（orchestrator.mjs・classify） | **rebuild** | 二重 dispatch（M8）・同期 dispatch の遅延（M7）・silent death 検知欠如（M9）。dispatch は単一 writer＋DB 一意性へ | issue #299/#256/#281 |
| orchestrator — 状態導出層（orchestrator-derive.mjs＋test） | **keep（コード参考＋原則）** | 「保存せず gh から導出」は実証済み（case 実機完走ログ）。資産① | issue #204・runbook 108-125 行 |
| **driver** — stage 進行（inner-loop*.mjs） | **rebuild** | resume 破壊（M2）・non-FF rework 停止（M5）・spawn 4 箇所分散と pin 貼り忘れ（runtime R5）。RunStore は DB 一次へ | issue #192/#229・cr-runtime §3 |
| driver — escalation triage（classifyEscalation＋unit test） | **keep（原則＋コード可搬）** | 三分岐の分類規約＋純関数。実弾発動実績は未確認 | 資産⑤・PR #273 |
| driver — 散文 prompt テンプレ（inner-loop-prompts.mjs） | **drop** | 型事故の温床（F1・ADR 0038 背景）。検査観点の文言のみデータ化して持ち込み | B6 |
| plan 契約（design/plan-format.md・6 セクション・過小 RED） | **keep（データ）** | 事故 2 件に接地（ADR 0025 監査・二重入口事故）＋#189 | 資産④・commit bbdeffd |
| **rubrics** — 中身（rubric.json 48 本・checks 58） | **keep（データ）** | origin が事故・裁定に接地。schema_v2 JSON を origin・checks・examples ごと移送 | 資産⑥⑧（「47 本」出典は未確認、実測 48） |
| rubrics — 枠組み（run.mjs/select.mjs、計 376 行） | **drop** | repo 固有配管。構造衝突の実例（meta/no-gate-tampering 廃止）。後継は「統治=契約のデータ化」 | B3・ADR 0038 §5 |
| **hooks** — 統治 hook（outer-harness/issue-create-guard 等） | **rebuild** | fail-open（欠落＝素通し）・配布されない・検証機構なし。「聞く」でなく権能分離（credential を持たせない）へ | cr-runtime §3 R1/R2 |
| hooks — verdict-guard（Stop hook） | **drop** | 二重課金の実害（#302）。書式は runtime の構造化出力で保証 | F4・cr-runtime §1 |
| hooks — git-guard（broad add/force-push 阻止） | **未評定（規律は keep 候補）** | 入力 4 本に評定なし＝**未確認**。FF-only・明示 add の規律自体は AGENTS.md 正本 | — |
| 分離の機械検証（harness-separation.test.mjs） | **keep（手法）＋rebuild（拡張）** | 手法は実証済み（#225）。ただし検査網の外に同型の穴 2 箇所（reviewerArgs・meta-loop） | 資産⑨・cr-runtime §3 |
| **explain 系** — 配信実装（orchestrator-explain.mjs・skill 起点の gh 投稿） | **rebuild** | `@file` 未展開 stub（F2/Q7）・二重生成（M8）・label 遷移 edge。配信は決定的スクリプト＋post-check へ | issue #299/#300・cr-github-defects §1 |
| explain 系 — explains/ 正本 23 ファイル（教材成果物） | **keep（データ）** | 生成済み教材の正本。Discussion との突合済み（差分は stub #295 と未 merge #303） | cr-github-defects §1.2 |
| explain 系 — 教材 2 段化要件（#288） | **keep（要件データ）** | 負例実物（Discussion #284・PdM 評価）＋「形容詞注文は無効・契約は構造で」の実証。コードは未実装 | 資産⑦ |
| **Projects 盤面** — 「Ready 列＝承認入力」の原則 | **keep（原則）** | ADR 0035（機械が読むのは Ready 列のみ）。ただし盤面の継続可否自体は未決（§5 D2） | AGENTS.md・ADR 0035 |
| Projects 盤面 — 接続実装（id 直書き→名前解決） | **rebuild** | option id 全再生成で silent 死（A2/Q4）。名前解決は対処済みだが contract test が無い | issue #201/#202 |
| **GitHub 連携** — issue=task・状態は導出（ADR 0031） | **keep（原則）＋rebuild（実装）** | 原則は実証済み（資産①）。実装は evidence 着地ラグ・label 書込失敗・fail-open continue が構造欠陥（cr-github-defects §4） | ADR 0031・issue #229/#294 |
| GitHub 連携 — gh 仕様癖台帳（Q1–Q7）＋REST 移行知見 | **keep（データ）** | 実際に踏んだ癖と対処の台帳。escalation 経路の REST 未移行は要修正 | cr-github-defects §3 |
| **case 常駐** — systemd unit・install | **rebuild** | E1–E4: 応急処置が case ローカルのみで正本未反映。KillMode 等を repo 正本化＋install self-check＋検収 4 点 | issue #281/#282 |
| Mac launchd 資材（ops/launchd/） | **drop** | case cutover 済み（#247 CLOSED）。**ただし 07-08 に併存が実測されており退役完了範囲は未確認**（§6-2） | B8・#237 OPEN |
| **CI** — PR+CI 単一着地ゲートの原則（ADR 0026） | **keep（原則）＋rebuild（実装）** | 原則は採用済み。実装は「ザル」（検証資産の全量未搭載、自己認定） | issue #279 |
| manifest ファイル正本（.lathe/runs/・DB 二次コピー） | **drop** | 二重データ層（ADR 0038 背景が名指し）。run telemetry は最初から DB 一次単一正本 | B2・schema.sql:24 |
| meta-loop.mjs（感知 loop） | **drop（コード）** | 実走実績ゼロ・未通電。result-classification taxonomy 文書は判断材料として保留 | B7・design/loops.md 27 行 |
| worktree 隔離・単一 writer・chip 禁止 | **keep（原則）** | 事故 2 件（2026-06-19 交錯・06-26 chip の設計判断迂回）に接地 | 資産⑨・AGENTS.md |
| ADR 0038 境界則＋design/loop-domain-architecture.md | **keep（設計）** | I/O ゼロ純ドメイン・4 context 表・二重台帳禁止。コード未実装＝設計として持ち込み、新基盤は最初からこの境界で建てる | 資産⑩ |
| harness-release loop（ADR 0036・loop 本体を loop で改修しない） | **keep（原則）** | 事故→成功の対照実測（#201 破壊 vs bootstrap 15 スライス 4 波 8 PR 着地） | 資産② |
| 切替検収 4 点基準（#282） | **keep（原則＋データ）** | PdM 承認済み（「いいだろう」）。適用実績（4 点照合 GREEN）は未確認 | 資産③ |
| skills（implement/verify/review/test-triage 等の手順書） | **rebuild** | 「手順書注入」は有用（verify skill が最実効・$0.08/run）だが Skill 機構である必要はない（codex は prompt inline で代替済み・呼び出し経路も不統一） | cr-runtime §1 |
| backend 抽象（ADR 0014・inner-loop-backends.mjs） | **keep（コード＋原則）** | claude/codex 混在稼働・cost 自前換算まで実測済み。「runtime は差し替え可能な 1 変数」の実態を担保 | cr-runtime §0/§4 |
| ingest provider（providers/claude.ts・codex.ts） | **keep（コード）** | 観測接続の正本。provider 抽象済みで adapter 追加コスト「低」 | cr-runtime §1 |
| Backlog.md/backlog/・intake 写し・task-id-unique check | **drop** | ADR 0031 §3 で廃止済み（二重帳簿の輸入元）。再導入しない | B4 |
| セッション外 memory・SESSION-HANDOFF 遺物 | **drop** | PdM 裁定 2026-07-08「メモリなんていう不確実なものに頼ることはない」。規律正本は repo 内文書のみ | B5・discipline.md 冒頭 |
| merge.mjs 型の driver 内 merge ゲート（worktree 残骸含む） | **drop** | 本体解体済み（fb129ac）。着地ゲートは PR+CI 単一で開始 | B1 |

---

## 4. 新基盤への要件リスト v0

### 必須（M）— 各要件は §2 の実弾 incident に接地

| # | 要件 | 根拠 incident |
|---|---|---|
| M1 | **二重実行の物理的不可能化**: dispatch は単一 writer、run の生成は DB 一次 RunStore の一意性制約で排他。fs マーカー・worktree 有無からの実行中導出を禁止。cross-machine（複数ホスト併存）も同一制約下に置く | M3/M4/M8（窓内 3 回実弾化・guard `eca8247` 後も再発）・#237 |
| M2 | **silent death 検知の常設**: 起動記録×live marker×outcome の 3 点突合を原因非依存・毎パスで実施。信号ゼロの死を人間の質問より先に機械が報じる | E1×M9（#281、発見 1 時間超・PdM 起点）・A1（#254、痕跡ゼロの永久 WAIT_PR） |
| M3 | **権能分離 fail-closed**: inner 実行体は起票・merge・承認系の credential を最初から持たない（token scope 分割 or 書き込みの driver/orchestrator 一元 proxy）。承認入力（Ready 移動・close・reaction）は agent 資格情報と分離された面に置く。hook（fail-open・配布されない・検証不能）を統治機構の置き場にしない | cr-runtime §3 R1/R2（#224＋pin 貼り忘れ 2 箇所現存）・G1（無承認起票）・G2（承認シグナル汚染、ADR 0034 §4 自認の限界） |
| M4 | **I/O の構造化**: 散文 prompt 契約の禁止。verdict・plan 書式・配信 body は runtime の構造化出力（JSON schema／envelope）と決定的スクリプトで機械保証。Stop hook による書式強制（prompt 再生成）は採用しない | F1（書式クラッシュ×2）・F2（stub #292/#295）・F4（二重課金 #302）・資産⑧（PdM 裁定「プロンプトに頼る前に機械的保証」） |
| M5 | **終端契約の機械執行＋書込失敗の補償**: stage 完了 = 「正本（issue/DB）への投稿完了」まで。書込失敗は「非致命 continue」で握りつぶさず、記録＋次パス補償（冪等 repair を done-explain 限定でなく全書き込み面に）。エラーメッセージは実在する参照のみ指す | P1（#239 transcript 死蔵）・P2/P3（#192 所見不達）・S1-3（#229 label/comment 両失敗の恒久化） |
| M6 | **runtime spawn の単一モジュール集約**: agent 呼び出しは 1 モジュール経由に強制し、全 caller をその経由に限定する機械検査を置く | cr-runtime R5（spawn 4 箇所分散・pin 貼り忘れ 2 箇所） |
| M7 | **版固定＋self-update**: LoopDefinition の版固定＋パス冒頭 ff-only self-update で stale 常駐を構造排除。外部 id（盤面 option id 等）のハードコード禁止・毎パス名前解決 | M1/M6（#263、5 commit 遅れ走行）・A2/Q4（#202 option id 失効） |
| M8 | **環境前提の repo 正本化＋install self-check＋切替検収 4 点基準**: KillMode・認証・依存はすべて repo 正本（ops/…・install script）に恒久化。導入・切替は (a) live marker 1 パス生存 (b) claude 応答 (c) 成果物の期限内出現 (d) outcome=success の 4 点機械照合で完了宣言 | E1〜E4（#281/#282。基準は PdM 承認済み・適用実績は未確認） |
| M9 | **投稿物の post-check**: 教材 Discussion・comment 等の外部投稿は、実在・非 stub（本文長・展開済み）・対象整合を投稿直後に機械照合。失敗は M5 の補償経路へ | Q7/F2（#292/#295 が承認材料として盤面に載った）・cr-github-defects §4-5 |
| M10 | **状態は保存せず正本から導出・二重台帳禁止**: ADR 0031 原則を維持しつつ、導出の証拠着地ラグは M1 の一意性制約で塞ぐ（導出だけに依存した再実行判定をしない） | 資産①（実証済み）・M1(ledger)（二重帳簿事故）・cr-github-defects §4-1（ラグが再実行の窓になる実測） |
| M11 | **loop 本体を loop で改修しない**: harness-release を別 loop（outer 一括編成）に分離 | G6（#201 で改修対象の不完全さが改修作業自体を破壊 → ADR 0036 の対照実測） |
| M12 | **外部契約の contract test**: gh API 挙動・盤面 id・CI action の前提を毎回検証する面を置き、「silent 障害→実測→hotfix」の順を逆転する | cr-github-defects §4-3（Q1〜Q6 がすべて事後発見）・A3 |
| M13 | **着地ゲート CI への検証資産の全量搭載**: PR+CI が単一着地ゲートである以上、テスト/rubric 資産の全量を CI に載せる | R2（#279「ザル」自己認定）・ADR 0026 |

### 推奨（R）

| # | 要件 | 根拠 |
|---|---|---|
| R1 | stage ごとの情報注入契約: 機械が既に知る情報（plan・diff・scope 照合結果）を agent に再発掘させない。コストの主因は runtime でなく turn 数（発掘と周回） | P4（#301、bash 37% 探索）・meta-audit（cache-read:output ≈ 108:1・LAND CHANGES 率 50%） |
| R2 | 非同期 dispatch（パス間隔の保証）: pass 内同期実行をやめ Ready→着手リードタイムを設計値に | M7(ledger)（#256、p95 52 分 vs 設定 300 秒） |
| R3 | 教材 2 段化＋密度の構造契約（予算・節・禁則・自己点検。形容詞注文は使わない） | #288・資産⑦（負例 Discussion #284 実物） |
| R4 | 決定的配置規則: 4 択正解位置等、機械で決められる配置は散文指示でなく決定的規則で | F3（#258、b に 66% 偏在） |
| R5 | backend 抽象の維持（段階移行・stage 単位 A/B）: runtime 選定を可逆にする | ADR 0014・cr-runtime §4（selectBackend 実装済み） |
| R6 | escalation triage 三分岐（context 自動再試行／environment 修理起票／decision needs-review） | 資産⑤（実装＋unit test 済み。実弾発動実績は未確認） |
| R7 | plan 契約 6 セクション＋見積り欄＋過小 RED の維持 | 資産④（#189・PR #267） |
| R8 | 優先度の第一級表現: label 未作成による body 退避（「p1-high（label 未作成のため body 記載）」）を解消し、機械可読の優先度面を持つ | cr-github-defects §2.2（#98/#102 実測） |

---

## 5. 未決の設計判断（PdM 裁定が要るもの）

### D1. runtime 選定 — CC 継続／pi／API 直叩き自作／併用段階移行

- 判断材料表は cr-runtime-requirements §4 が正本。要旨: CC 継続=観測接続◎・統制○・書式△・保守△（外部仕様追随）／pi=保守✗（bus factor 1・permission 自作）／自作=統制◎・書式◎（fail-closed を設計で直に満たす）・loop 全自前／併用=最小リスク（backend 抽象実装済み）。
- 判断基準の注意: **コスト削減は選定理由にならない**（コスト主因は turn 数で runtime 非依存、meta-audit 実測）。選定は「保証の置き場所（分離・書式・統制）」で決める。
- 未確認: claude backend の課金経路（API key か Max サブスク充当か）・pi の失敗時 exit code。

### D2. GitHub への依存度 — 状態正本・承認面・配信面をどこまで GitHub に置くか

- 緊張関係（入力間で立場が割れる・丸めない）: 資産①⑩は「task 状態の正は GitHub のまま（ADR 0031 継承）」を採用資産とする一方、cr-github-defects §4 は「GitHub を盤面・状態導出・着地ゲートに使う」設計の構造脆弱 5 点（証拠着地ラグ・fail-open 書込・契約不安定・evidence 経路と着地ゲートの直列結合・投稿検証層の不在）を実測から帰納している。
- 裁定対象: (a) 状態導出の正本を GitHub 継続か、ローカル DB 一次＋GitHub 投影へ逆転するか。(b) Projects 盤面（Ready 列=承認入力）を続けるか、ADR 0038 の「意図を DB に書く」UI へ移すか。(c) 承認 credential 分離の実現手段（別アカウント／GitHub App／署名等 — M3 の具体化）。(d) 教材 Discussion 配信の継続可否。

### D3. lathe との分離境界 — 新基盤を lathe repo 内で建てるか、別 repo か

- ADR 0038 は lathe repo 内の 4 context（packages/loop-domain）として設計済み（accepted・コード未実装）。一方 code red の前提は「lathe 開発は当面中止・開発基盤の全面再構築」であり、PdM 裁定（2026-07-08）には「プロジェクト外のハーネスは必要ない」がある（memory tombstone）。「lathe の外に基盤を建てない」裁定と「lathe 開発を止めて基盤を作り直す」方針の整合（＝基盤の置き場・repo 分割の要否）は PdM 裁定事項。
- 付随: rubric 48 本・plan 契約・ADR 群など keep 資産の移送先（新基盤 repo に正本を移すか、lathe 正本を参照するか）。

### D4. 観測（lathe ingest）の接続方式

- 選択肢: (a) transcript adapter 継続（providers/claude.ts・codex.ts 現存、pi でも adapter 1 枚・工数「低」）／(b) 自作 runtime が ingest schema へ直接書く（adapter 消滅・観測が正本になる。lathe の製品方向と整合）。
- 付随: 新基盤の RunStore（M1/M10 の DB 一次）と lathe DB（Postgres 55433）の関係 — 同居か分離か。D3 の裁定と連動。

---

## 6. 入力間の矛盾・未確認事項（丸めずに残す）

1. **rubric 本数**: 候補記載「47 本」vs 機械計数 48 本・checks 58（cr-keep-assets C1）。47 の出典は未確認（計数時点差とみられる）。
2. **launchd 退役の完了範囲**: cr-keep-assets B8 は「case systemd へ cutover 済み（#247 CLOSED）・launchd 資材は持ち込まない」とするが、cr-github-defects §1.3 は「07-08 は case 常駐と Mac launchd が**併存**した時期」と実測し（Discussion #294/#295 重複の発生時期・Mac 側 orchestrator.log/outcomes.jsonl に実走記録）、cross-machine 排他は #237（OPEN・hold）で計画中。#237 と #247 の分掌（タイトル重複）も未確認。→ 退役は完了と扱わず、M1 の cross-machine 排他要件に含めた。
3. **PdM 申告 vs 実測**: 「Claude Code は自動タスク・ハーネス構築に向いていない」に対し、cr-runtime §0 は「動かない、は不成立（66 run・326 stage・$150.9 完走）。ただし分離 fail-open・Stop hook 二重課金・ask=自動拒否の 3 点で申告の実質は支持」。両論のまま D1 の判断材料とする。
4. **「監査役 session に関所 hook 不在」（2026-07-08）**: 親セッション申告のみで repo 内一次記録なし＝**未確認**。ただし「掛からない経路」の構造的存在は機械確認済み（pin 貼り忘れ 2 箇所・install 検証機構の不在、cr-runtime §3）。
5. **G8/G9（scope 追加禁止・memory 全廃の PdM 裁定）**: 裁定自体は discipline.md に接地するが、直接契機となった個別事故は未確認。
6. **Q8（service token の UUID/client_id 混同）**: repo・issue/PR 横断検索で痕跡なし＝未確認（本 repo では踏んでいない可能性）。
7. **適用実績が未確認の keep 資産**: 切替検収 4 点基準（基準承認済み・GREEN 実績なし）・escalation triage（実装済み・実弾発動なし）・教材 2 段化と ADR 0038（設計のみ・コード未実装）。「実証済み」なのは方向を根拠づける事故・負例であり、実装の実績ではない。
8. **「無限に生成」の照合**: 現存する重複は 1 組（#294/#295）＋未遂 1 件＋stub 2 本であり「無限」は現存 Discussion 上で確認できない。ただし再発火条件（evidence 未着地×毎 5 分パス×guard なしの窓）は log で実証済みで、増殖構造は現存（cr-github-defects §1.4）。削除済み Discussion の有無は API から確認不能＝未確認。


---

# §3 やりたいこと（意図の正本）

- **体制**: 人間 1 人（PdM）＋ agent 群。人間は実装を一切せず、承認・裁定・vision 提示のみを行う。実装・レビュー・検証・運用はすべて LLM agent。
- **テンポ要求**: 1 日 10〜20 の変更着地。前の変更が着地する前に、次の作業が並行して生まれる「動的で高速」なループ。従来の 1 人開発の常識（日に 1〜2 PR）の約 10 倍域。この velocity 自体が要件であり、落とす選択肢はない。
- **統治要求**: すべての変更は plan（機械審査つき）を起点とする。人間の承認は**片手操作**でできること（実績: スマートフォンから GitHub Projects の列移動 = 承認)。承認判断のための「教材」（変更内容の解説文書）が自動生成されること。escalation（agent が判断に詰まった時の人間への差し戻し）が一元的に管理されること。
- **製品 vision**: この開発基盤自体が製品（lathe = ハーネスエンジニアリングプラットフォーム）の一部である。**駆動**（loop の実行)・**統治**（規範・承認・審査)・**観測**（transcript・コスト・実行履歴の取り込みと可視化）の三位一体。将来構想: loop 定義を UI で閲覧・編集し、実行履歴をノードグラフで再生し、meta-audit（実行データの監査分析）をボタンで発火する。自己開発（このループで自分自身を開発する self-hosting）は「版固定」— 走行中の loop を loop 自身に改修させず、版として一括切替 — で行う。
- **実証済みの譲れない条件**: ①観測の主権（agent transcript の完全取得 — 本書の診断のすべてはこれで可能になった) ②変更の可逆性 ③「プロンプト指示より機械的保証」（散文で agent に頼むのではなく、構造・配管・機械検証で保証する — 本失敗から抽出され規範化された原則)。

# §4 GitHub が想定しているもの vs やりたかったこと

- **GitHub の設計前提** [事実]: PR・issue・review・notification は「人間同士の・非同期の・時間〜日単位の協働」のための道具である。branch 儀式・review 待ち・eventually consistent な状態伝播・required checks による直列化は、その前提でうまく働く。
- **私たちの誤用** [事実]: それを機械の状態機械の基板として使った — label = 状態遷移、PR の有無 = 進行中判定、comment = 成果物の受け渡し、Projects 盤面列 = 承認入力。書き込みは失敗し得るのにトランザクションがなく、伝播にはラグがあるのに機械は 5 分ごとに全状態を再導出して判定した。
- **帰結 = テンポの不整合事故** [事実]: 仕事の生成速度（分単位）＞ 状態伝播の速度。二重実行は「前の実行の証拠が GitHub に着地する前に、次の判定が走る」窓の事故。non-FF 事故（push 済み履歴の書き換え衝突）は「PR が開いている間に世界が先へ進む」事故。1 日 20 PR は GitHub の協働モデルの想定外であり、ベンダーの自動化機能（Claude Code routines: 最小 1 時間間隔・日次実行上限・超過は silent drop）にとっても想定外。
- **再設計方向** [仮説・設計 v1]: **速い面と遅い面の分離**。速い面（task の状態機械・排他・生存監視・段遷移）は自前所有のエンジンに置き、秒単位・トランザクショナルに回す。遅い面（起票・人間の承認 UI・人間の読み物・コードの着地 = PR+CI）だけを GitHub に残す。GitHub は状態機械の基板から「人間との境界面」へ降格する。

---



# §5 二案比較の全記録（元資料 verbatim: 基盤裁定資料）

> 注: 「routines」の定義は付録 A 参照。以下は敵対 critique 込みの比較文書全文。

# 基盤裁定資料（最終比較・判定なし）

- 作成: 2026-07-08／read-only。読者: PdM。
- 入力: `routines-foundation-design-v0.md`・`self-built-foundation-design-v0.md`・`critique-routines.md`・`critique-self-built.md`・`code-red-charter-material.md`（すべて本 scratchpad）。
- 記法: 事実（一次証拠・実測）／critique の主張（設計側未応答）／**未確認** を峻別。本書は判定を書かない（§5 決定木のみ）。

---

## 1. 両案 1 枚図（同解像度）

層構成を揃えて併記。**太字**＝両案の差が出る層。

### routines 案・基線（cloud 全面／判定 B）

```
正本    GitHub: issue=task・PR+CI 単一着地ゲート（両案共通・ADR 0031/0026）
発火    cloud routines cron（cadence 5 分）… platform 管理＝宿主なし
排他    managed Postgres claim INSERT（ON CONFLICT DO NOTHING = 実行権）
実行    cloud session（fresh checkout・注入 prompt）… 環境差 E クラス消滅
書込    posting proxy（決定的 render＋post-check＋台帳）
        ※critique A-3: proxy/watchdog の実行基盤が cloud 上で規定されていない
監視    watchdog routine（3 点突合・補償）… 系外監視なし（critique B-1）
観測    OTel export → collector → lathe ingest ＝**劣化形（判定 B）**
        tool span/token/cost のみ・message history 不可・遡及不可
M3      **未解決（採用可否を左右）**: 実行 identity (g)・secret 注入 (d) が platform 仕様待ち
```

### 自作案・基線（case 単独・ローカル Postgres）

```
正本    GitHub: issue=task・PR+CI 単一着地ゲート（両案共通）
発火    systemd timer → dispatcher oneshot（常駐なし・ff-only self-update→re-exec）
排他    ローカル Postgres claim INSERT（同一 DDL・cross-machine は DB 単一化が条件）
実行    claude -p headless ローカル spawn（単一モジュール・env strip・worktree 隔離）
        … 環境差 E クラス＝**自前恒久負担**（systemd/認証/依存の repo 正本化）
書込    posting proxy（別 OS user＋LoadCredential・唯一の gh credential）
監視    watchdog oneshot ＋ **系外 heartbeat（GitHub Actions cron）**
観測    local JSONL 100% → lathe ingest（providers 変更ゼロ）＝**無劣化**
M3      構造で建つ設計・ただし OS user 分離の existence proof **未取得**（Step 0-i）
```

### routines 案・縮退形（hybrid: 統治=cloud・実行=ローカル runner）

両 critique が独立に「実質の比較対象」と指摘する第三形。観測＝local JSONL 無劣化（自作と同等）・排他＝同一 DB claim・**代償**＝E クラスと宿主 silent death が戻る（＝自作と同じ負担）＋統治面だけ platform 依存が残る。

---

## 2. 機能面の比較表（M1〜M13）

「充足」は各設計 v0 の自己申告に critique の未応答指摘を重ねた現時点評価。◎=構造保証／○=自前コード／△=条件付き／✗=未解決。

| # | 要件 | routines での充足 | 自作での充足 | どちらも未解決 |
|---|---|---|---|---|
| M1 | 二重実行の物理不可能化 | ○ DB claim（同一設計）。ただし DB 到達 (d) **未確認**。DB 不達→全 no-op が silent（critique B-2） | ◎ 同一 DDL・ローカル到達。cross-machine は DB 単一化が条件 | 移行期間中は旧 fs 排他×新 DB 排他が非共有＝S1-2 再発窓（自作 critique D-2。routines も同型） |
| M2 | silent death 検知常設 | △ watchdog 3 点突合。**系外監視なし**・platform 障害で監視側も同時沈黙（critique B-1） | ○ watchdog＋Actions cron 系外 heartbeat。マシン死の検知 SLO は Actions 遅延**未実測** | 「死因を語る証拠」: routines は最終 batch 未 flush で永久消失（critique C-2）・自作は JSONL 残存 |
| M3 | 権能分離 fail-closed | **✗ 最重大未解決**。(g)=本人身元なら actor 検証が汚染を正規化（critique D-1）・Step 1〜3 が分離なし実弾（D-2） | △ 構造設計あり。OS user 分離＋LoadCredential の existence proof **未取得**（不成立なら準構造に格下げ＝critique E-2） | credential 種別（GitHub App vs machine user PAT）の裁定は両案共通 |
| M4 | I/O 構造化（envelope） | △ **envelope の回収経路が cloud-full で不存在**（critique A-1: 最終メッセージは API 取得不可・設計内部矛盾） | ○ ローカル spawn の stdout JSON＝回収経路が自明。unparsable retry は keep 転用 | CC headless の schema 強制出力可否（**未確認**・両案共通の強度差要因） |
| M5 | 終端契約＋書込補償 | △ 設計あり。ただし M4 の envelope 受理が前提＝A-1 に連動 | ○ 台帳＋watchdog 補償（S1-3 #229 封じ） | — |
| M6 | spawn 単一モジュール | △ dispatcher→session 生成手段 (b) **未確認**・spike 項目に漏れ（critique A-2） | ○ backends.mjs 改造転用＋CI grep 検査 | — |
| M7 | 版固定＋self-update | ◎ 毎発火 fresh checkout（platform） | ◎ oneshot＝常駐なし＋ff-only re-exec | 外部 id の毎パス名前解決は両案自前 |
| M8 | 環境 repo 正本化＋検収 4 点 | ◎ cloud spec 化で宿主消滅——**ただし proxy/collector/DB 監視の自前常駐 2〜3 個が新設され集計と矛盾**（critique A-3） | ✗→○ **自前恒久負担**として全部残る＋unit 新規書き直し＝E1 級を踏み直す位置（critique B-1'）。self-check は未着手コード | 検収 4 点の適用実績なし（基準のみ PdM 承認済み） |
| M9 | 投稿物 post-check | ○ 設計同一。M4 経路に連動 | ○ 設計同一＋intent_sha256 冪等 | — |
| M10 | 状態は導出・二重台帳禁止 | ○ gh 導出維持＋claim/ledger は telemetry 単独正本 | ○ 同一（derive.mjs コード参考 keep） | — |
| M11 | loop を loop で改修しない | △ **routine 定義・cron 変更だけゲート外**。(b)(g) 成立時は inner が loop を書き換える経路が広がる（critique D-3） | ◎ 全部 repo コード＝PR+CI 内。install 実行のみ運用残余 | — |
| M12 | 外部契約 contract test | ○ watchdog 毎時＋CI | ○ 同一＋gh 癖台帳 Q1〜Q7 の test 化 | 第 1 号 timeline `labeled` actor 網羅性は**未確認**（承認検証の前提） |
| M13 | CI 検証資産全量 | ○ 基盤非依存（#279 解消） | ○ 同一＋カーネル自身のテスト | 両案とも「これから書く」——書くのは同一人物（自作 critique C-1 の自己参照問題は程度差で両案に掛かる） |

### R1〜R8 の差分のみ

| # | 差が出る点 |
|---|---|
| R1 注入契約 | 両案自前・同設計。routines は fire payload に注入を渡せるか**未確認**（critique A-2、劣化すると fail-closed が「起動後自殺」に落ちる） |
| R2 非同期 dispatch | 自作=timer 設計値保証（構造）／routines=cadence 下限・(a) イベント trigger **未確認**＋dispatch 用 LLM session 288 本/日の quota 未見積（critique C-3） |
| R5 backend 抽象 | **自作=維持（backends.mjs 転用・codex A/B 資産温存）／routines=縮退（Claude 固定の公算）**。hybrid なら維持 |
| R3/R4/R6/R7/R8 | 両案同一（contracts データ・乱択 render・triage 移植・plan schema・gov:p ラベル） |

### 両案共通で「どちらを選んでも建てるもの」（裁定不要・先行着手可能な共通部品）

claim DDL＋dedup／posting 台帳＋post-check 5 項目／envelope schema 群／contracts データ（plan.schema・explain 2 段・watchdog-checks）／label 語彙 `gov:*`/`run:*`／escalation triage 移植／M13 CI 全量。両設計 §4 は routine/loop 定義・skill 構成・label 語彙を**基盤非依存の共通正本**として既に共有している。

---

## 3. 戦略軸の比較（機能表とは独立）

| 軸 | routines（cloud 基線） | 自作（最小カーネル） |
|---|---|---|
| ① **保証の所有権**（壊れた時に自分で直せるか） | 発火・環境・版管理・実行 identity は platform 内＝**壊れても自分では直せない**（(c)(d)(g) の挙動変更に事後追随）。dedup・補償・post-check は自前＝直せる | 全層が自 repo コード＋systemd＝**全部自分で直せる。裏返しに全部自分でしか直らない**（bus factor 1・セキュリティ境界 proxy 含む。critique C-1/C-2） |
| ② **依存の非対称性** | GitHub（正本・承認・着地）＋Anthropic（発火・実行・観測経路）の**二枚依存**。どちらの仕様変更も系を止めうる・交渉力なし | GitHub 一枚＋自前保守。Anthropic 依存は「headless CLI の JSON 出力」1 点に縮小（backend 抽象で codex へ逃げ道あり）。代わりに保守が監査役個人に非対称集中 |
| ③ **観測の主権**（lathe の存在条件） | 判定 B＝durable log→best-effort stream への**質の変更**。今日の meta-audit 2 本との照合（critique E）: 効率監査の中核所見（再読 3.0/session・bash 37% 探索・Stop hook 二重課金の発見）は**判定 B では一つも導出できなかった**＝実測済みの事実。lathe が自分を dogfood できない製品になる | local JSONL 100%・ingest 変更ゼロ・**観測が今日と同じ深さで続く**。「自作 runtime が ingest schema へ直接書く」（D4-b・観測=正本）への発展経路もこちら側にのみ開く |
| ④ **製品戦略**（lathe は駆動を所有するか） | lathe＝**統治と観測に徹する製品**。駆動（loop 実行）は外部化し、契約（contracts・rubric・検収）だけを所有。駆動の改善知見は platform に帰属 | lathe＝**駆動を所有する製品**。loop 実行そのものが観測対象かつ改善対象＝「既存 agent の観測・改善・評価」（AGENTS.md）を自系で閉じる。代償: 駆動コードの増殖動力が残る（現行系 32 日 0→7k 行の実測・critique A-2'） |
| ⑤ **可逆性**（乗り換え・撤退の経路） | 撤退＝自前実行系の再構築（hybrid に落ちれば実行面は可逆・統治面の platform 依存は残る）。R5 縮退で codex A/B 資産を失うと復元コスト増 | 乗り換え＝spawn モジュール 1 点差し替え（CC→codex→pi→API 直・ADR 0014 維持）。**routines への後乗り換えも「dispatcher の発火面だけ platform 化」で可能**＝共通部品（§2 末尾）が両世界で使い回せる |

補足（軸①②に掛かる非対称・事実）: routines 案の未確認 (b)(d)(e)(g) は**自分では潰せず platform 仕様の実測でしか閉じない**。自作案の未確認（OS user 分離・Actions 遅延）は**自分の環境で 1〜2 日の spike で閉じる**。不確実性の「所有権」も非対称。

---

## 4. 両 critique の要点（対称・各 5 点）

### critique-routines（自作側からの攻撃）

1. **A-1 設計内部矛盾**: cloud session の最終メッセージを回収する確認済み経路がゼロ（retrieval API は transcript 取得不可・stream は常駐要）。M4/M5/M9 の 3 層保証が起点から未規定。**Step 0 の spike 項目にも入っていない**。
2. **A-2/A-3 「cloud 全面」の自壊**: dispatcher の spawn 手段 (b) が spike から漏れ、proxy・watchdog・OTel collector は cloud 上に置けない（LLM なし routine は存在できない）＝自前常駐 2〜3 個を新設しながら「platform が宿主を消す」と集計。
3. **B 相関故障**: dispatcher と watchdog が同一 platform・同一 DB 到達 (d) の上＝両者同時沈黙を報じる者が系内にいない。DB 不達 fail-closed は「全パス no-op」という最も検知しにくい停止形態を新設。
4. **D M3 の帰結は自己申告より重い**: (g)=本人身元なら actor 検証が bot の暴走 approve を「人間の承認」として通す（防御の反転）。Step 1〜3 は権能分離なしの実弾運転で、順序が自作案（Step 0 で existence proof 先行）と逆。
5. **E 判定 B の実証的棄却**: 今日の meta-audit 2 本を判定 B の観測で再現照合→効率監査はほぼ全滅。「劣化の受容」は開いた裁定ではなく、B 単独では要件を満たさないことが scratchpad 内の証拠で閉じている、と主張。

### critique-self-built（routines 側からの攻撃）

1. **A 「小さなカーネル」は会計境界の産物**: 2.5–3.5k 行に contracts 群・ops/ unit 群・install self-check・migration・テスト 6.2k 行超が入っていない。現行系は同じ人・同じ規律で **32 日 0→7,015 行**（機械計測）＝増殖を止める新機構は本案にない。driver 65〜76% 削減は未実測の楽観。
2. **B 常駐負荷の過小計上＋相関故障**: unit を新規に書き直す＝E1 級設定事故を踏み直す位置。Postgres が M1/M2 両方の単一依存点なのに運用工数が無計上。監視系が被監視系と同じマシン・同じ DB に立ち、最後の砦 Actions cron は best-effort＋60 日無活動で自動無効化仕様（本 repo 照合は**未確認**）。
3. **C bus factor 1**: 唯一の write credential を持つ proxy（新規 400–600 行）の設計・実装・テスト・レビューが全部同一人物＝自己参照的保証。#279「ザル」は同じ体制・同じ理念の下で起きた。lathe 開発再開後、最初に腐るのが自前カーネル（S2-1 は「係が不在」で起きた実績）。
4. **D 移行窓と恒久残余**: Step 1〜5 は旧 fs 排他×新 DB 排他が非共有＝S1-2 再発窓を内蔵したまま実 issue で PoC。E2 類（ローカル認証・課金経路未照合）は自作固有の恒久残余。
5. **E 比較枠の歪み**: 自作の 2 大優位のうち transcript 主権は **routines hybrid が完全に中和**し、M3 は Step 0 未実測の条件付き。「自作 vs cloud 全面」で比較枠を切った時点で結論が半分決まっており、裁定は「自作 vs hybrid」行と Step 0 実測を揃えてから。

### 両 critique が独立に一致する点（構図の事実）

- 実質の比較は「**自作 vs routines-hybrid**」であり、cloud 全面基線はどちらの critique からも支持されていない。
- hybrid に落とすと観測は両案同等（無劣化）になり、**残る差分は「統治・発火面を platform に置くか自前に置くか」＋「E クラス負担の所在」だけ**に縮む。
- dedup・proxy・post-check・envelope・contracts は両案共通の自前部品＝どちらの裁定でも無駄にならない。

---

## 5. 裁定の分解（決定木——判定は書かない）

この裁定は 1 つの選択ではなく、以下の順序の決定の束。上位が決まると下位の選択肢が絞られる。

```
D-0. 製品戦略（軸④）: lathe は駆動を所有する製品か、駆動を外部化し統治と観測に徹する製品か
│    ※最上位に置く根拠: この選択だけが他の全軸（保証所有権・依存・観測・可逆性）の重み付けを決める
│
├─「駆動を所有する」──────────────────────────────┐
│   D-1a. M3 実現手段: OS user 分離＋LoadCredential の existence proof（Step 0-i）│
│   │      成立 → 構造の M3。不成立 → 同一 user＋運用規律（routines の未解決と同格）│
│   │              に落ちることを受容するか、ここで撤退するか                     │
│   D-1b. 恒久保守の受容: E クラス管理・DB 運用・外部仕様追随・bus factor 1       │
│   │      （critique-self-built B/C。一時費用でなく恒久費用として裁定）           │
│   D-1c. DB 置き場: lathe Postgres 同居（観測=正本方向と整合）or 専用（境界優先） │
│   D-1d. 系外監視の経路: Actions cron（遅延・60 日仕様の実測後）or 代替           │
│   D-1e. 移行窓の閉じ方: PoC issue の旧系からの隔離手順（gov:hold・旧 timer 停止）│
│
├─「駆動を外部化する」────────────────────────────┐
│   D-2a. 観測劣化（判定 B）の受容 ※実測材料あり: 今日の meta-audit 照合で        │
│   │      効率監査は B で再現不能（critique E）。受容しない → hybrid 強制         │
│   │      → hybrid なら E クラス負担が戻り、対自作の差分は統治面のみに縮む        │
│   D-2b. M3: platform 仕様 (d)(g) の実測結果待ち。 (g)=本人身元なら              │
│   │      承認検証が成立しない（critique D-1）→ 採用可否ごと再裁定                │
│   D-2c. envelope 回収経路の設計し直し（critique A-1。仕様確認以前の設計課題）    │
│   D-2d. R5 縮退の受容: codex A/B 資産を失うか、dispatcher に抽象を自前保持か     │
│
└─ どちらでも共通に決めるもの（基盤選定と独立）
    D-3a. 承認面の正: gov:approve label（actor 検証つき）or Projects Ready 列継続
    D-3b. credential 種別: GitHub App or machine user PAT
    D-3c. 基盤の置き場（D3）: lathe repo 内（ADR 0038 packages）or 別 repo
           ※「プロジェクト外のハーネスは必要ない」裁定（2026-07-08）との整合
    D-3d. 共通部品（§2 末尾）の先行着手可否: 裁定前でも無駄にならない集合
    D-3e. Step 0 spike の実施承認（§6 の順で。両案並走 1〜2 日・相互に排他でない）
```

順序に関する両案・両 critique の一致点: **Step 0 spike が最も安い不確実性削減であり、D-0 の裁定材料（M3 成立可否・観測経路の実態）自体を spike が供給する**。D-0 を先に直感で決めることも、spike 結果を見てから決めることも可能——後者を選ぶ場合、§6 の 1〜4 が判明するまで D-0 を仮置きにできる。

---

## 6. 未確認事項の統合リスト（Step 0 spike で潰すべき順）

順序基準: 採用可否を左右するもの → 設計の骨格を決めるもの → 周辺。[R]=routines に効く／[S]=自作に効く／[共]=両案。

| # | 未確認事項 | 効く先 | 潰し方／判明した時の分岐 |
|---|---|---|---|
| 1 | **(g) routines 実行 identity**（本人身元か否か） | [R] 採用可否 | platform 実測。本人身元なら M3・承認検証が自壊（critique D-1）→ R 案は hybrid 込みで再設計 |
| 2 | **(d) secret 注入・cloud→DB 到達** | [R] 採用可否 | 不成立なら claim 排他が建たない＝R 案中止の裁定材料 |
| 3 | **OS user 分離＋LoadCredential の existence proof**（agent が repo を書けて token を読めない） | [S] 採用可否 | case 上で 1 日 spike。不成立なら S 案 M3 は準構造に後退＝受容裁定へ |
| 4 | **envelope 回収経路**（cloud session の最終出力を proxy がどう受けるか） | [R] 設計成立 | critique A-1 指摘・**現 Step 0 リストに無い→追加必須**。session 自身が DB へ書く形なら §4.3 全面書き直し |
| 5 | **(b) 動的 session 生成／dispatcher の spawn 手段**＋fire payload への注入可否 | [R] 設計成立 | critique A-2 指摘・spike 漏れ→追加必須。注入不可なら R1 fail-closed が劣化 |
| 6 | **(e) env/settings 注入＝OTel の cloud 有効化可否** | [R] D4 前提 | 不成立なら判定 B すら成立せず実質 C＝hybrid 強制 |
| 7 | **CC headless の schema 強制出力可否** | [共] M4 強度 | 不成立でも bounded retry で運用可（強度 1 段落ち）。両案同条件 |
| 8 | **timeline `labeled` イベントの actor 網羅性** | [共] 承認検証の前提 | M12 contract test 第 1 号。両案の承認機構が共通に依存 |
| 9 | **課金経路**（API key か Max サブスク充当か） | [共] D1 材料 | ローカル headless $150.9/66run の前提照合。S 案は現状維持＝中立、R 案は cloud 課金と比較要 |
| 10 | **GitHub Actions schedule の実遅延**＋60 日無活動の自動無効化仕様の本 repo 照合 | [S] M2 最終段 | SLO 未達なら系外監視の代替経路（別マシン・外部監視）裁定へ |
| 11 | **(c) run 上限・接近シグナルの有無** | [R] C-1 livelock | 警告なし kill なら stage>上限 の run が永久再実行（実測 306 turn/$7.70 の IMPLEMENT が既存）→ attempt cap の設計追加 |
| 12 | (a) イベント trigger の有無 | [R] R2 のみ | 基線は cron で成立＝採否に非影響・レイテンシのみ |
| 13 | Projects v2 API の actor 取得可否 | [共] D2-b | Ready 列継続を選ぶ場合のみ必要 |
| 14 | stage 別 allowlist の session 内切替可否 | [R] 最小権限 | 不可なら union 許可（権限主張の後退）か nested spawn（課金未確認） |
| 15 | OS user 分離×worktree の運用詳細（git 所有権・pnpm store 共有） | [S] 運用 | #3 の spike に同梱 |

補足: #1〜2（R 側）と #3（S 側）は**相互に排他でなく並走可能**（計 1〜2 日）。#4〜5 は仕様確認でなく R 案側の設計宿題であり、spike と独立に設計者へ差し戻せる。

---

## 7. 本書自身の限界

- 両 critique は敵対的レビューであり、指摘の一部（増殖力学・bus factor・比較枠）は推測を含む（各所で明記済み）。設計側の反論機会は未実施。
- 「判定 B で今日の監査が再現不能」（critique E）は scratchpad 内の照合として閉じているが、OTel の cloud 実測（#6）前であり、full I/O opt-in の cloud 適用可否次第で緩和の余地が残る（**未確認**）。
- charter 継承の未決（rubric 47/48・launchd 退役範囲・「CC は向いていない」両論）は両設計が同一の扱いで編入済み＝本書で再掲しない。



# §6 durable execution はどう関係するか — 機能ベースの対応

> 注: 前半は編纂済みの機能対応章（完成分）、後半は高速ループ設計 v1（velocity 確定値・エンジン二択・GitHub 再設計・Step 0 実測リスト）の全文。

# §6 durable execution はどう関係するか — 機能ベース

- 作成: 2026-07-09／read-only 編纂（repo・issue・PR への書き込みなし）
- 読者: 本プロジェクトを一切知らない外部の分析 AI（repo アクセス不可）を想定。内部用語は初出で定義し、参照先の内容は本文に収載する。
- 情報源: fl-temporal-design-v0（Temporal ベース基盤設計）・fl-alternatives（軽量代替の比較調査）・fast-loop-foundation-v1（統合設計材料・敵対 critique 反映済み）・code-red-charter-material（事故台帳と要件の正本）。いずれも 2026-07-08 作成の一次調査文書。
- 記法: 全主張に【事実】（一次証拠あり）／【設計仮説】（PdM 裁定前の設計提案）／【critique】（敵対検証者の指摘。設計側の主張への反論として峻別）／【未確認】のタグを付す。PdM = プロダクト裁定者（人間・本プロジェクトの意思決定者）。

---

## 6.0 前提 — この節を読むのに必要な最小文脈（用語定義込み）

### 6.0.1 プロジェクトと壊れた系【事実】

- **lathe**: AI コーディング agent の観測・改善・評価を行うプラットフォーム（Next.js + Postgres）。本節の主題は lathe 本体ではなく、**lathe の開発自体を回していた自律 agent ループ（開発基盤）**である。
- その開発基盤の形: GitHub issue = task（issue 番号がそのまま task ID）、**orchestrator**（5 分間隔で常駐発火するプロセス）が承認済み task を検出して **inner agent**（`claude -p`＝Claude Code CLI の headless・非対話モード）を **dispatch**（子プロセスとして起動）し、agent が plan（計画）→ PdM 承認待ち → implement（実装）→ verify（検証）→ land（PR 作成・CI 通過・merge）を進める。1 回の agent 走行を **run**、その内部工程を **stage** と呼ぶ。task の状態は保存せず GitHub から**導出**する原則（open PR あり=In Progress 等）。人間の承認入力は GitHub Projects 盤面の **Ready 列**（そこへ issue を移すことが承認）。
- 2026-07-08、PdM がこの基盤の**全面再構築（code red）を裁定**。実測 66〜79 run・326 stage・$150.9 の完走実績はあるが（「動かない」は不成立）、下記 5 つの事故クラスが実弾化していた。

### 6.0.2 構造で不可能にすべき事故クラス 5 つ【事実・incident 26 件からの帰納。原文 verbatim】

> 1. **二重 dispatch / 二重生成**（M3→M4→M8、窓内 3 回）— fs マーカー導出をやめ、DB 一次の一意性制約で「2 本目が物理的に生成できない」形へ。
> 2. **stale 常駐・stale 定数**（M1・M6・A2）— 版固定 LoopDefinition＋パス冒頭 ff-only self-update＋外部 id の毎パス名前解決。
> 3. **成果物・所見の transcript 死蔵**（P1–P3・A1）— stage 終端契約を「正本への投稿完了」まで機械執行、失敗は記録＋次パス補償。
> 4. **散文契約に依存する I/O**（F1–F4）— prompt 契約の構造化データ化・配信は決定的スクリプト・配置は決定的規則。
> 5. **silent death**（E1×M9・A1）— 起動記録×live marker×outcome の 3 点突合を原因非依存で常設＋install self-check＋検収 4 点。

（M3/M4/A1 等は incident 台帳の行 ID。代表実弾: **二重 dispatch** = 同一 task に agent が 2 本走り子 issue 8 件が重複投函・教材 2 本が 8 秒差で二重投稿、防止 guard 追加**後**にも再発／**silent death** = OS の cgroup 回収で dispatch 子プロセスが産まれた直後に全滅、ログ 0 byte・検知機構ゼロ・発見が 1 時間超後の人間の質問起点／**終端保証の破れ** = 通信断で GitHub への label 付与と comment 投稿が両方失敗したのに「非致命 continue」で握りつぶされ、系が「open PR=In Progress」と誤読して永久待機。）【事実】

### 6.0.3 新基盤への必須要件 M1〜M13【事実・正本 verbatim。本節の対応表が参照する要件 ID の定義】

> | # | 要件 | 根拠 incident |
> |---|---|---|
> | M1 | **二重実行の物理的不可能化**: dispatch は単一 writer、run の生成は DB 一次 RunStore の一意性制約で排他。fs マーカー・worktree 有無からの実行中導出を禁止。cross-machine（複数ホスト併存）も同一制約下に置く | M3/M4/M8（窓内 3 回実弾化・guard `eca8247` 後も再発）・#237 |
> | M2 | **silent death 検知の常設**: 起動記録×live marker×outcome の 3 点突合を原因非依存・毎パスで実施。信号ゼロの死を人間の質問より先に機械が報じる | E1×M9（#281、発見 1 時間超・PdM 起点）・A1（#254、痕跡ゼロの永久 WAIT_PR） |
> | M3 | **権能分離 fail-closed**: inner 実行体は起票・merge・承認系の credential を最初から持たない（token scope 分割 or 書き込みの driver/orchestrator 一元 proxy）。承認入力（Ready 移動・close・reaction）は agent 資格情報と分離された面に置く。hook（fail-open・配布されない・検証不能）を統治機構の置き場にしない | cr-runtime §3 R1/R2（#224＋pin 貼り忘れ 2 箇所現存）・G1（無承認起票）・G2（承認シグナル汚染、ADR 0034 §4 自認の限界） |
> | M4 | **I/O の構造化**: 散文 prompt 契約の禁止。verdict・plan 書式・配信 body は runtime の構造化出力（JSON schema／envelope）と決定的スクリプトで機械保証。Stop hook による書式強制（prompt 再生成）は採用しない | F1（書式クラッシュ×2）・F2（stub #292/#295）・F4（二重課金 #302）・資産⑧（PdM 裁定「プロンプトに頼る前に機械的保証」） |
> | M5 | **終端契約の機械執行＋書込失敗の補償**: stage 完了 = 「正本（issue/DB）への投稿完了」まで。書込失敗は「非致命 continue」で握りつぶさず、記録＋次パス補償（冪等 repair を done-explain 限定でなく全書き込み面に）。エラーメッセージは実在する参照のみ指す | P1（#239 transcript 死蔵）・P2/P3（#192 所見不達）・S1-3（#229 label/comment 両失敗の恒久化） |
> | M6 | **runtime spawn の単一モジュール集約**: agent 呼び出しは 1 モジュール経由に強制し、全 caller をその経由に限定する機械検査を置く | cr-runtime R5（spawn 4 箇所分散・pin 貼り忘れ 2 箇所） |
> | M7 | **版固定＋self-update**: LoopDefinition の版固定＋パス冒頭 ff-only self-update で stale 常駐を構造排除。外部 id（盤面 option id 等）のハードコード禁止・毎パス名前解決 | M1/M6（#263、5 commit 遅れ走行）・A2/Q4（#202 option id 失効） |
> | M8 | **環境前提の repo 正本化＋install self-check＋切替検収 4 点基準**: KillMode・認証・依存はすべて repo 正本（ops/…・install script）に恒久化。導入・切替は (a) live marker 1 パス生存 (b) claude 応答 (c) 成果物の期限内出現 (d) outcome=success の 4 点機械照合で完了宣言 | E1〜E4（#281/#282。基準は PdM 承認済み・適用実績は未確認） |
> | M9 | **投稿物の post-check**: 教材 Discussion・comment 等の外部投稿は、実在・非 stub（本文長・展開済み）・対象整合を投稿直後に機械照合。失敗は M5 の補償経路へ | Q7/F2（#292/#295 が承認材料として盤面に載った）・cr-github-defects §4-5 |
> | M10 | **状態は保存せず正本から導出・二重台帳禁止**: ADR 0031 原則を維持しつつ、導出の証拠着地ラグは M1 の一意性制約で塞ぐ（導出だけに依存した再実行判定をしない） | 資産①（実証済み）・M1(ledger)（二重帳簿事故）・cr-github-defects §4-1（ラグが再実行の窓になる実測） |
> | M11 | **loop 本体を loop で改修しない**: harness-release を別 loop（outer 一括編成）に分離 | G6（#201 で改修対象の不完全さが改修作業自体を破壊 → ADR 0036 の対照実測） |
> | M12 | **外部契約の contract test**: gh API 挙動・盤面 id・CI action の前提を毎回検証する面を置き、「silent 障害→実測→hotfix」の順を逆転する | cr-github-defects §4-3（Q1〜Q6 がすべて事後発見）・A3 |
> | M13 | **着地ゲート CI への検証資産の全量搭載**: PR+CI が単一着地ゲートである以上、テスト/rubric 資産の全量を CI に載せる | R2（#279「ザル」自己認定）・ADR 0026 |

（表中の #N は GitHub issue 番号、`eca8247` 等は git commit ID、ADR NNNN は Architecture Decision Record 番号。読者は参照先にアクセスできない前提のため、必要な内容は本文に展開済み。）

### 6.0.4 durable execution とは【事実・一般定義】

**durable execution** = ワークフロー（多段の処理列）の各ステップの結果と発火予定を永続ストアに記録し、プロセス・マシンの crash 後に**記録（履歴）を replay して「最後に完了したステップの続きから」再開できる**実行モデル。代表実装は Temporal（OSS サーバー＋SDK）、DBOS（Postgres 上のライブラリ）、Restate・Inngest 等。共通して提供される primitive は概ね次の 7 つ:

1. **排他的 claim**（workflow ID 一意性）: 同一 ID のワークフローは同時に 1 実行しか存在できない（エンジンが原子的に保証）。
2. **exactly-once activity / step checkpoint**: 副作用を持つステップ（activity/step）の完了結果を履歴に記録し、replay 時は再実行せず記録値を返す。完了記録は 1 回だが、**実行自体は retry で複数回走り得る（at-least-once 実行）**——ここは本節の対応表で正直に扱う。
3. **永続 timer**: プロセス再起動を跨いで発火が保証される sleep / cron（durable sleep・Schedules）。
4. **heartbeat / 生存監視**: 長時間 activity が定期 heartbeat を送り、途絶（heartbeat timeout）・超過（start-to-close timeout）をエンジンが検知して retry policy で自動再試行。
5. **実行履歴の永続化**: 何がいつ起き・何が返ったかの event history / checkpoint がエンジン DB に単独正本として残る。
6. **signal（外部入力の注入）**: 走行中ワークフローへ外部から入力を注入する口（Temporal: signal=非同期／update=同期・受理前 validate 可）。
7. **workflow versioning**: 走行中ワークフローは開始時のコード版で完走し、新規のみ新版で開始（Temporal Worker Versioning の pinned モード等）。

---

## 6.1 中心対応表 — durable execution の提供保証 ↔ 本系の事故クラス / 要件

PdM の問い「提供するもの（機能・保証）がどう関係するのか」への直接回答。各行 =「この保証を採用すると、どの事故クラス対策が**自前コードから primitive へ**移るか」。

| durable execution の保証 | 移る事故クラス / 要件 | 「自前コード → primitive」の内訳（1 行） | タグ |
|---|---|---|---|
| ① 排他的 claim（workflow ID 一意性） | **二重 dispatch / 二重生成**（事故クラス 1・M1） | 自前の claims テーブル DDL＋fs マーカー導出＋dedup guard（guard 後も再発した）が、「issue #N = workflow ID `task-N`、同時 open は 1 本」というエンジンの原子的 hard guarantee に置換。cross-machine 排他も同一エンジン配下なら自動 | 【事実】（保証は Temporal 公式明記）＋【critique B-1】保証は「**同時 open** 1 本」のみで、close 後の再 start は既定 Policy（Allow Duplicate）が止めない → **再開始判定の設計は自前に残る**（実装は消えるが設計は消えない） |
| ② exactly-once activity（step checkpoint・記録値 replay） | **終端保証**（事故クラス 3=transcript 死蔵・S1-3 fail-open 握りつぶし・M5）＋二重生成の残余 | 「書込失敗を非致命 continue で握りつぶす」自前 driver コードが、「activity 失敗は retry policy で自動再試行・最終失敗はワークフローへ返り compensate 分岐が必須になる」構造に置換＝**『失敗を無視して先へ進む』が書きにくい形**になる。stage 間の再開処理（自前 resume）も「完了 activity は replay で再実行されない」に置換 | 【事実】（機構は公式）＋【事実・正直な限界】activity **内部**は checkpoint されない: worker が agent run の途中で死ねば retry は stage 頭からやり直し＝**stage 内の冪等性（worktree リセット等）は自前責務のまま**。DBOS では step 書込と durability 記録が同一 Postgres トランザクションで commit＝トランザクショナル exactly-once（DBOS 公式 blog の主張・第三者検証は未実施） |
| ③ 永続 timer（durable sleep / Schedules） | **dispatch 遅延**（S3-1: 5 分設定に対し実測パス間隔 median 15 分・Ready→着手 p95 52 分。要件 R2/V2）＋silent death の補助 | 自前の launchd/systemd 5 分 cron ＋ pass 内同期実行（遅延の根因）が、エンジンの timer/schedule（プロセス再起動を跨いで発火保証・非 blocking 起動）に置換 | 【事実】（機構）＋【設計仮説】（V2: 反応遅延 p95≤15 分の充足手段としての採用）。注意: 永続 timer は 5 事故クラスの直接対策ではなく**効率要件（velocity）側**の対応物 |
| ④ heartbeat / 生存監視 | **silent death**（事故クラス 5・M2） | 自前 watchdog（起動記録×live marker×outcome の 3 点突合。plan 承認済み・**実装未**）の大半が、activity heartbeat（30 秒毎）＋heartbeat timeout（≤2.5 分）＋start-to-close timeout（90 分）＋自動 retry に置換。「信号ゼロの死」をエンジンが検知・再試行 | 【事実】（Temporal の機構は公式）＋【事実・限界】**マシンごと死・エンジンサービスごと死は検知不能**＝系外 heartbeat（GitHub Actions cron 等、系の外からの死活監視）はどの案でも自前に残る。**DBOS はここが急所**: 「プロセスが生きたまま hang」の検知が公式に明記されておらず【未確認】、採用時は自前 watchdog 併設が条件 |
| ⑤ 実行履歴の永続化（event history / PG checkpoint） | **transcript 死蔵**（事故クラス 3・M5 の回収経路）＋**I/O 構造化**（M4 の記録面）＋二重台帳の解消（M10） | 自前 manifest ファイル層（run/stage の試行記録。DB との二重データ層で drop 判定済み）が、エンジンの履歴＝「実行 telemetry の単独正本」に置換。activity 戻り値（構造化 envelope JSON）がそのまま履歴に永続記録され、「成果物が agent の transcript の中にしか無い」状態が構造的に起きにくくなる | 【事実】（機構）＋【設計仮説】（envelope を activity 戻り値に載せる設計）＋【設計・規律】エンジン履歴は lathe の transcript 観測とは**別物**＝重複投資にしない規律が要る。task 状態を workflow 内部変数に溜めると GitHub との二重台帳が再発 → 「実行状態はエンジン一次・人間入力のみ GitHub から読む」の方向規律とセット（6.5 節） |
| ⑥ signal（外部入力の注入） | **承認待ちの状態機械**（二重 dispatch の一種である「承認済みかの導出誤読」窓・統治面 M3 の一部） | 自前の「polling で GitHub 盤面を読み、承認済みかを毎回導出し直す」状態機械が、`await approval`（signal/update 待ち）1 行に置換。update なら受理前 validate（不正入力の拒否）も可能。承認の正本は GitHub ラベルのまま、検出役 activity がラベル→signal に変換 | 【事実】（機構＋Replit Agent が「update で人間同意を注入して agent 再開」の同型を production 実証・公式 case study）＋【未確認】承認者の本人性検証（GitHub timeline の labeled イベント actor 網羅性）は全案共通で未実測＝自前責務 |
| ⑦ workflow versioning（pinned） | **stale 常駐**（事故クラス 2・M7）＋**loop を loop で改修しない**（M11） | 自前の self-update 規律（パス冒頭 ff-only pull。不在で 5 commit 遅れの旧コードが走行した実弾あり）と「走行中 loop に改修を混ぜない」**運用**規律が、「走行中 workflow は開始時の版の worker で完走・新 task のみ新版」というエンジンの**機械強制**に置換。副産物として replay test（旧履歴×新コードの互換を機械検証）という新しい CI 資産 | 【事実】（Temporal Worker Versioning GA・公式）＋【事実・裏面】worker という**常駐プロセス自体の stale 化リスクが戻る**（自作案は使い捨て oneshot で構造排除する方針だった）。**DBOS には版固定の機械強制なし**＝プロセス再起動規律＋CI からの版付き deploy という運用担保に留まる |

**要約（機能ベースの結論）**【設計仮説・critique C-2 反映】: 5 事故クラスのうち、**二重 dispatch（①）・silent death の run/worker 死部分（④）・終端保証の骨組み（②）・stale 常駐（⑦・Temporal のみ機械強制）** が「自前コードで保証を書く」から「エンジンの primitive を使う」へ移る。**移らないもの** = 系外の死活監視（マシン/エンジン丸ごと死）・stage 内冪等性・再開始判定の設計・投稿物の内容検証（post-check）・承認者の本人性検証・権能分離（OS user 分離）・観測（transcript 主権）。throughput は論点にならない（実測数 task/日に対し、先行事例は 10M activities/日級＝容量は 2〜4 桁の余裕）。**選定は容量でなく「保証の置き場」と値札（運用・学習・新バグクラス）の交換**で決まる。

---

## 6.2 手作りしていた対応物の一覧 — 「知らずに durable execution を再発明していた」考古学

現行系（再構築対象）には、durable execution の各 primitive に対応する**手作り版**が既に存在し、それぞれ実測の欠陥を持つ。この対応が「エンジン導入 = 新規概念の輸入」ではなく「**既に必要だと判明した機構を、自前実装から既製の保証に置き換える**」ことを示す。

| 手作り部品（現行系・実在コード） | durable execution での対応 primitive | 手作り版の実測欠陥【事実】 |
|---|---|---|
| **manifest**（`.lathe/runs/` 配下の JSON。run/stage の試行記録。DB に二次コピーされ二重データ層） | **event history**（実行イベント史の永続化） | 二重データ層そのものが設計文書（ADR 0038）に名指しで問題視され drop 判定。evidence の GitHub 着地ラグが「未完了と誤読 → 再実行」の窓になる実測あり |
| **live marker**（fs 上の実行中マーカー。orchestrator が「実行中 skip」判定に使用） | **liveness / heartbeat**（生存の一次信号） | 実行中検出が worktree（作業ディレクトリ）有無のみで plan 段 task を見逃す欠陥を実測 → 二重 dispatch 実弾化の起点。fs マーカー由来の実行中導出は M1 で明示的に禁止対象 |
| **circuit breaker**（`outcomes.jsonl` ledger を fold し、連続 failure が閾値到達で dispatch 抑制。success でリセット・escalation は故障と数えない） | **supervision / retry policy**（失敗の集約と再試行統制） | 誤 open（止めるべきでない時に dispatch を止める）が実弾化し、PLAN_REVIEW の RED ループとの合わせ技で恒久対処 commit が必要になった（repo commit 履歴 5cb8679 に「RED ループと breaker 誤 open の恒久対処」と明記） |
| **resume**（`recordAttempt` が manifest に試行を書き、`decideResumeState` が再開位置を決める自前再開機構） | **replay**（完了 activity は再実行されない履歴再生） | recordAttempt は plan 段も記録するのに decideResumeState が IMPLEMENT 起点前提 → **plan 段を通った run の `--resume` が常に失敗**（issue #192）。「履歴を書く側と読む側の前提ずれ」という、replay をエンジンに任せれば型ごと消えるバグクラス |
| **dedup guard**（dispatch 重複防止の強化 commit `eca8247`） | **排他的 claim**（workflow ID 一意性） | guard 追加（07-07）の**翌日（07-08）に二重生成が再発**＝「発火の瞬間だけ塞ぐ」guard では危険窓（run 終了後の投影ラグ含む in-flight 全期間）を覆えないことが反証済み |
| **watchdog 3 点突合**（起動記録×live marker×outcome の突合。issue #281 の plan として PdM 承認済み・**実装未**） | **heartbeat timeout ＋ 生存監視** | 実装される前に code red 裁定。DBOS 採用時は（hang 検知未確認のため）この自前 watchdog の併設が採用条件として復活する【設計仮説】 |
| **launchd/systemd 5 分 cron ＋ pass 内同期実行**（orchestrator の駆動） | **永続 timer / Schedules** | 同期実行によりパス間隔 median 15 分・最大 51.9 分（設定 300 秒）・Ready→着手 p95 52 分（issue #256 実測） |
| **承認 polling**（GitHub Projects の Ready 列を毎パス読み直して承認を導出） | **signal / update**（外部入力の注入） | 状態の読み戻し（投影ラグ窓）が二重 dispatch の再発火条件の一部。盤面の内部 id 全再生成で検出が silent に停止した実弾もある（issue #201/#202） |

**この表の含意**【設計仮説】: 手作り版 8 部品はすべて「必要性が実弾事故で証明されたが、実装が壊れていた」もの。durable execution の採用とは、この 8 部品のうち上 6 行を**保証ごと**エンジンに移し、自前に残すのは「系外監視」と「承認の本人性・内容検証」だけにする、という機能の再配置である。逆に言えば、エンジンを採用しない場合はこの 8 部品を自前で正しく作り直す義務が残る（自作カーネル案の見積り: 新規 2.5〜3.5k 行）。

---

## 6.3 エンジン二択の機能差 — Temporal self-host vs DBOS Transact TS

候補は統合設計材料の時点で二択に収束している【設計仮説・PdM 裁定前】。ここでは PdM 指示に従い**機能差（提供する保証・運用の重さ・先行例）だけ**を並べる。価格・実装行数は §他節に譲る。

### 6.3.1 前提の定義【事実】

- **Temporal self-host**: OSS のワークフローエンジン。専用サーバー群（コンテナ 3〜4 個: server＋専用 Postgres＋管理 UI）を自分のマシンに常駐させ、アプリ側は「worker」プロセスがサーバーへ outbound 接続して仕事を受ける。ワークフローコードは**決定的**（乱数・時計・I/O 禁止）でなければならず、TypeScript SDK はこれを sandbox（Webpack バンドル・`Date.now` 差し替え等）で**機械強制**する。
- **DBOS Transact TS**: アプリ内ライブラリ（npm install するだけ）。**追加常駐物ゼロ**で、既存の Postgres（本系には稼働中の Postgres が既にある）に system database を同居させ、workflow/step 注釈だけで durable execution を得る。MIT license・1.3k★・企業バックあり・Temporal 比で採用実績は浅い。

### 6.3.2 機能差の対比表【事実ベース＋タグ付き】

| 機能軸 | 案 T: Temporal self-host | 案 D: DBOS Transact TS |
|---|---|---|
| **運用の重さ**（常駐・保守） | **三案中最重**【事実】: コンテナ 3〜4 個＋専用 Postgres が常駐純増。サーバー版上げに schema migration 手順。UI は無認証既定（ローカル bind 運用）。バックアップ対象 DB が 2 系統 | **三案中最軽**【事実】: 追加常駐ゼロ。既存 Postgres に論理 DB 追加のみ。版上げ = npm 更新 |
| **排他的 claim** | 同時 open 1 本は platform hard guarantee・cross-machine 自動【事実・公式】。close 後再 start は Policy 裁定＋再開始判定の設計が残る【critique B-1】 | workflow ID の exactly-once 起動＋Postgres 一意性。**自前の claim 台帳と同一 DB・同一トランザクション**で書けるのが固有の強み【事実・公式主張】 |
| **生存監視（hang 検知）** | **◎ activity heartbeat が platform 提供**（30 秒毎送信・timeout ≤2.5 分で V3=「silent death 検知 5 分以内」要件を充足）【事実・公式】 | **△ 急所**: crash 後の再開は PENDING scan で可（○）だが、「プロセスが生きたまま hang」の検知は公式に明記なし【未確認】→ 自前 watchdog 併設が採用条件【設計仮説】 |
| **版固定（stale 常駐対策・M7/M11）** | **◎ 機械強制**: pinned で走行中は旧版完走・新 task のみ新版。replay test（旧履歴×新コード互換の機械検証）が CI 資産として付いてくる【事実・公式 GA】 | **△ 運用担保のみ**: プロセス再起動規律＋CI からの版付き deploy。機械強制なし【事実】 |
| **決定性の強制** | TS SDK が sandbox で機械強制（「決定性はレビューで守る」でなく構造で守る）【事実・公式】。裏面: **non-determinism error という現行系に存在しない新バグクラス**と学習領域（目安 1〜2 週間【推測・実測なし】） | 決定性 sandbox なし＝新バグクラスの輸入も小さい。既知の道具（TS ライブラリ＋Postgres）の延長【事実】 |
| **履歴の置き場** | 専用 Postgres 内の event history（管理 UI で timeline・retry・signal 履歴を可視化） | 既存 Postgres 内の checkpoint。**「エンジンが観測（lathe ingest）schema へ直接書く」発展経路が既定で開く**（同一 DB 同居のため）【設計仮説】 |
| **LLM agent ループでの先行例** | **強い existence proof**【事実・一次情報】: OpenAI Codex（coding agent が Temporal 上で production・数百万リクエスト。内部構成は非公開＝設計参照は不可【未確認】）・Replit Agent（**agent session ごとに 1 workflow・workflow ID 一意性で「同時に 1 agent」・update で人間承認を注入**＝本設計と同型が production 実証・公式 case study）・Dust（10M+ activities/日）。公式 AI cookbook に agentic loop パターンが正典化 | 調査資料内に LLM agent ループの先行例の記載**なし**【未確認＝「無い」ではなく本調査で未発見】 |
| **両案共通の穴** | **「headless CLI（`claude -p`）を engine の activity/step として subprocess spawn する」公開先行例は両エンジンとも未発見**【未確認】。技術的障壁は特定されていないが、先行実装の裏取りが無い → 導入前 spike で自前 existence proof を取る計画 | 同左 |

### 6.3.3 交換の要約【設計仮説・敵対 critique C-2 反映済み。原文 verbatim】

> **交換の要約（C-2 反映）**: Temporal 固有の実利は 3 点に縮む——①M11 の機械強制＋replay test ②activity heartbeat による hang 検知（DBOS の急所を platform で埋める） ③保証実装の bus factor 緩和。**値札** = 常駐 1 式（podman 4 コンテナ＋PG 追加）＋non-determinism という新バグクラス＋学習 1〜2 週【推測・実測なし】。DBOS 側の同 3 点の自前コスト: ①CI deploy 規律＋再起動運用（機械強制なし） ②watchdog 純関数 5 個＋oneshot（#281 plan で PdM 承認済み・実装未） ③自前保証の bus factor 1 が残る。**throughput（V1/V5/V7）は三案とも余裕で満たし選定を弁別しない**。PdM 裁定「プロジェクト外のハーネスは必要ない」に形態が最も適合するのは app 内ライブラリ＋既存 PG（案 D）——ただしこの整合は形態論であり、保証の強度（②の未確認）と交換関係にある。

### 6.3.4 要件充足の三案比較表【事実＋設計評価・統合設計材料 §4 の原文 verbatim。◎=構造/platform 保証・○=自前コードで充足・△=条件付き・✗=未解決】

（routines 列は「実行を外部 SaaS platform に預ける」旧第三案の参考再掲。）

> | # | 要件 | 案 T: Temporal self-host | 案 D: DBOS＋自前 watchdog | 参考: routines（cloud/hybrid） |
> |---|---|---|---|---|
> | M1 | 二重実行の物理不可能化 | **○→◎条件付**: 同時 open 1 本は platform hard・cross-machine 自動。ただし Reuse Policy 既定は close 後再 start を許す（B-1）→ Policy 裁定＋再開始判定の engine 照会化で ◎ | **○**: workflow ID exactly-once 起動＋PG 一意性（claim と同一 DB・同一 Tx）。再開始判定の設計宿題は案 T と同じ | ○ DB claim 同設計。DB 到達 (d) 未確認・不達 no-op が silent |
> | M2 | silent death 検知 | **◎（run/worker 死）**: heartbeat 30 秒・timeout ≤2.5 分で V3 充足＋自動 retry。サービス/マシン丸ごと死は系外 heartbeat 必要（共通） | **△**: **hang 検知未確認（#281 直撃の急所）** → 自前 3 点突合 watchdog 併設が採用条件。crash 再開は PENDING scan で ○ | △ 系外監視なし・platform 相関故障（監視も同時沈黙） |
> | M3 | 権能分離 fail-closed | △ task queue 分離＋別 OS user。**existence proof 未取得（三案共通）** | △ プロセス分離＋別 OS user（同上） | ✗ 実行 identity (g) 仕様待ち・最重大未解決 |
> | M4 | I/O 構造化 | ○ activity 戻り値が history 永続（回収経路構造化） | ○ step 戻り値が PG checkpoint | △ envelope 回収経路が cloud-full で不存在 |
> | M5 | 終端契約＋補償 | ○ retry policy＋compensate 分岐が骨組み。post-check 自前 | ○ step retry＋durable 再開。post-check 自前 | △ M4 連動で未規定 |
> | M6 | spawn 単一モジュール | ○ 自前＋CI grep（三案同一） | ○ 同 | △ session 生成手段 (b) 未確認 |
> | M7 | 版固定＋self-update | **◎ pinned が機械強制**（走行中は旧版完走・replay test）。裏面: worker 常駐の stale 化が戻る（deploy 規律で緩和） | △ ライブラリ＝プロセス再起動で版切替（oneshot 化は durable 再開と両立させる設計次第）。外部 id 名前解決は自前（共通） | ◎ 毎発火 fresh checkout |
> | M8 | 環境正本化＋検収 4 点 | **✗→○ 三案中最重**: E クラス全残＋Temporal service 運用純増（podman 4 コンテナ・PG もう 1 系統・版上げ schema migration） | **○ 三案中最軽**: E クラス全残・**追加常駐ゼロ**・PG は既存 55433 | ◎/△ cloud で宿主消滅だが proxy 等の自前常駐 2〜3 新設で集計矛盾 |
> | M9 | 投稿物 post-check | ○ 三案同一の自前設計 | ○ 同 | ○ 同（M4 経路に連動） |
> | M10 | 状態は導出・二重台帳禁止 | ○ **修正後**: 人間入力のみ gh 読み・実行状態は engine 一次（E-1 解消） | ○ 同（PG 一次が最短） | ○ gh 導出維持＝投影 lag 窓の S1-2 残余あり |
> | M11 | loop を loop で改修しない | **◎ 三案中最強**: repo コード＋PR+CI に加え pinned が走行中混入を機械禁止 | ○ repo コード＋PR+CI（機械強制なし・運用規律） | △ routine 定義・cron 変更がゲート外 |
> | M12 | 外部契約 contract test | ○ 共通＋Temporal 契約は SDK 型と replay test が肩代わり | ○ 共通＋DBOS 契約面は npm ライブラリ（薄い） | ○ 共通 |
> | M13 | CI 検証資産全量 | ○ 共通＋**replay test という新資産** | ○ 共通 | ○ 共通 |

---

## 6.4 「軽い代替＋自前薄層」に戻る場合、何が自前に残るか

エンジン二択の外側に「Postgres ネイティブの job queue（pg-boss / graphile-worker 等の成熟ライブラリ）＋自前の薄い層」という更に軽い選択肢がある。調査結果【事実】: **「キュー」は買えるが「durable execution」は買えない**。

### 6.4.1 買える部分【事実】

SKIP LOCKED による安全な job 取り出し・retry/backoff・cron・遅延 job・DLQ（dead letter queue）・LISTEN/NOTIFY 低遅延（<3ms）。既存 Postgres にそのまま乗り、常駐物ゼロ、TypeScript 親和も最高。queue としての実績は 2010 年代後半からと長い。

### 6.4.2 自前に戻る部分【事実・調査資料の原文 verbatim】

> **自作に戻る部分（正直に）**: durable execution 級に必要な「step 単位 checkpoint と再開」「途中結果の journal と決定的 replay」「durable timer（週単位 sleep）」「workflow 履歴のモデル」は queue の上に**自分で設計・実装**することになる。想定事故クラス: 非冪等 step の二重実行（at-least-once ＋自前 checkpoint の隙間）・checkpoint スキーマの migration 事故・「job は成功したが workflow 状態の更新に失敗」の分裂・自前 replay の determinism バグ。これは lathe が避けたい「自作 harness の保守」がそのまま戻る構図。

6.1 の対応表に写像すると【設計仮説】: 軽い代替で primitive 化できるのは **③永続 timer（部分: cron/遅延 job まで。週単位 durable sleep は不可）** のみ。**①排他 claim・②exactly-once step・④生存監視・⑤履歴・⑥signal・⑦versioning はすべて自前に残る**＝6.2 の手作り 8 部品のうち 7 部品を正しく作り直す義務が戻る。しかも queue の実行保証は at-least-once（worker crash 時に再配送）であり、自前 checkpoint との隙間が**二重実行（事故クラス 1 の同型）を再輸入**する。

付随事実【事実】: この「薄層を自作した人」の existence proof は存在する（pg-boss 上に durable execution を実装した個人 repo）が、その作者自身が docs で「大規模用途には Temporal/Inngest/DBOS 等を推奨」している。また pg-boss は実質単独メンテ（bus factor 低）。

### 6.4.3 参考: 軽量代替の全候補比較表【事実・調査資料の原文 verbatim】

> | 候補 | 形態 | 保証（exactly-once / timer / heartbeat / 履歴） | 常駐物の増加 | 既存 PG 55433 活用 | TS/Node 親和 | 成熟度・license |
> |---|---|---|---|---|---|---|
> | **DBOS Transact TS** | app 内ライブラリ | step checkpoint で再開・イベント起点 workflow の exactly-once 起動・durable sleep（週単位可）・履歴は PG 内＋API で照会可。**heartbeat 明記なし**（単一ノードは起動時 PENDING scan で回復。分散回復は Conductor(SaaS) か手動※要注意） | **0**（app + PG のみ） | ◎ system database として同居可（1 物理 PG に複数論理 DB） | ◎ npm `@dbos-inc/dbos-sdk`・TS first | MIT・1.3k★・v4.23 (2026-06-30)・DBOS Inc.（企業バック） |
> | **Restate** | 独自 server（Rust 単一バイナリ） | journal ベース durable execution・**通信 exactly-once semantics**・durable timers/promises・K/V state。fsync 済み単一ノードでも耐久 | **+1**（restate-server。DB 追加不要） | ✗ 独自埋め込みストレージ（log+state 同居）。PG 資産は使わない | ○ 公式 sdk-typescript あり。ただし「Restate のサービスモデル」への書き換えが要る | **BSL 1.1**（内部利用・self-host は明示的に許可、4 年後 Apache-2.0）・4.1k★・v1.7.2 (2026-07-06)・元 Flink 創設者ら |
> | **Inngest（self-host）** | 独自 server（単一バイナリ、HTTP で app を起動） | step 単位の永続化＋step 単位 retry・sleep（日単位）・イベント待ち。app 側 worker 常駐不要（HTTP 呼び出しモデル） | **+1**（inngest server。SQLite 内蔵 or 外部 PG/Redis） | △ 永続化先に自前 PG を指定可（`postgres-uri`）。ただし本番マルチノードは PG+Redis 両方要 | ◎ TS SDK が主力 | **SSPL + DOSP(遅延 Apache-2.0)**・self-host は公式サポート対象外（DB 自動 cleanup なし等の注記あり）・signing key 必須 (2026-02〜) |
> | **pg-boss** | app 内ライブラリ（queue） | 「exactly-once **delivery**」（SKIP LOCKED）＝実行は実質 at-least-once・retry/backoff・cron・遅延 job・DLQ。**workflow の step 再開・履歴 replay は無い**（job dependency orchestration どまり） | 0 | ◎ そのまま乗る（PG 13+） | ◎ TS 96.8% | MIT・3.7k★・12.25.1 (2026-07)・**実質単独メンテ（timgit）＝bus factor 低** |
> | **graphile-worker** | app 内ライブラリ（queue） | at-least-once・retry 25 回/約 3 日・crontab・LISTEN/NOTIFY で低遅延 (<3ms)。durable execution（step checkpoint）は無い。crash 時 lock 回復のタイムアウト値は**未確認** | 0 | ◎ そのまま乗る | ◎ TS 主体 | MIT・2.3k★・クラウドファンド型（Benjie 中心）＝bus factor 中 |
> | **River** | Go ライブラリ | transactional enqueue・retry・cron・step 型 workflow あり | 0（ただし Go worker プロセス） | ◎ | **✗ worker は Go 専用**（enqueue のみ Python/Ruby 対応。Node 非対応） | MPL-2.0・5.4k★・v0.40.0 (2026-07-02) |
> | **Absurd**（調査中に発見） | PG 内（PLpgSQL）＋薄い SDK | Postgres だけで durable execution（step checkpoint・retry・スケジュール・event 待ち・exactly-once semantics を標榜） | 0 | ◎ PG のみで完結 | ○ TS SDK あり（Python/Go も） | Apache-2.0・2.2k★・**0.4.0 (2026-05) = pre-1.0**・「AI 支援で構築」と明記・本番実績主張なし |

（PG 55433 = 本系で既に稼働している Postgres インスタンスのポート。Restate/Inngest は「常駐＋1」の時点で、Absurd/pg_durable（Microsoft の PG 拡張）は成熟度で、River は言語不適合で、それぞれ二択から外れている【事実・調査時の適合順位】。）

### 6.4.4 どのエンジンを選んでも自前に残るもの（エンジンでは買えない機能）【設計仮説・全案共通】

1. **系外の死活監視**: マシン丸ごと・エンジンサービス丸ごとの死は、系の内側からは検知できない（監視も同時に沈黙する相関故障）。GitHub Actions cron 等、系の外に置く heartbeat 監視は全案で自前。
2. **stage 内の冪等性**: activity/step の途中死は「stage 頭からやり直し」になるため、worktree リセット等の再実行安全化は自前。
3. **再開始判定の設計**: 「同時 open 1 本」保証は close 後の再 start を止めない。「この task をもう一度走らせてよいか」の判定ロジックは自前設計（エンジン履歴 or 台帳への照会）。
4. **権能分離（M3）**: agent 実行体に GitHub 書込 credential を持たせない構造（OS user 分離＋書込専用プロセス）。エンジンは routing（どの仕事をどの worker に渡すか）を提供するだけで、分離の実体は OS 設計。existence proof 未取得【未確認・全案共通】。
5. **投稿物の内容検証（M9 post-check）**: 「投稿が実在する・stub でない・対象と整合する」の機械照合。エンジンは「投稿 activity が成功した」ことしか知らない。
6. **承認者の本人性検証**: 承認ラベルを付けたのが許可された人間かの検証（GitHub timeline actor の網羅性は未確認【未確認】）。
7. **I/O の schema 設計（M4 の中身）**: envelope JSON の schema・agent が schema 通り出力するかの検証と bounded retry（headless CLI の schema 強制出力可否は未確認【未確認・全案共通】）。
8. **エンジン非依存の keep 資産**: spawn 単一モジュール・posting 台帳＋post-check・contracts データ（plan 契約 6 節等）・rubric（機械検査規範）48 本・escalation triage 純関数・GitHub API 癖台帳。これらはどの案でも同じ場所に載る＝裁定前の先行着手が無駄にならない【設計仮説】。

---

## 6.5 GitHub 再設計の要約 — 速い面／遅い面の分離と durable execution の関係

### 6.5.1 分離の原理【設計仮説・敵対 critique E-1 反映済み】

再設計の中核は**面の分割**:

- **速い面**（実行状態・排他・再実行判定）= durable execution エンジンの DB が**一次所有**。機械が読み書きする状態はすべてここ。
- **遅い面**（人間の入力・読み物・着地）= GitHub に**限定**。残る役割は (a) 起票面（issue 作成・採番）、(b) 承認・裁定の入力面（承認ラベル/盤面・裁定 comment）、(c) 読む面（人間向け投影・恒久記録）、(d) PR+CI の単一着地ゲート（コードが main に入る唯一の経路）。
- **方向規律**: **機械は GitHub から「状態」を読み戻さない**。GitHub から読むのは人間の入力（新規 issue・承認ラベル・裁定 comment）のみ。GitHub 上の状態表示は engine からの一方向投影（台帳＋キャッシュ）に格下げ。

### 6.5.2 なぜこの分離が事故クラスに効くか【設計仮説・実測根拠は事実】

旧系は「GitHub への evidence 書込 → GitHub から状態を導出 → 導出結果で dispatch 判定」という**往復**を機械の判定経路に置いていた。GitHub は結果整合的（書込の着地ラグがある）・書込は fail-open（失敗しても系が止まらず握りつぶされる）・API 契約は不安定（内部 id の silent 再生成等）であり、この往復こそが二重 dispatch の再発火条件（着地ラグ×毎 5 分パス）と永久待機（fail-open 書込→誤導出）の実測根因だった【事実】。速い面をエンジン一次に移すと、**GitHub の結果整合性が機械の判定経路から外れる**＝保証を要求されない面に退く。これが「durable execution が GitHub 再設計を可能にする」関係の機能的核心: **エンジンが①排他・⑤履歴・③timer・④生存監視の正本を引き受けるから、GitHub は正本業務から解放できる**。

### 6.5.3 遅い面の確定方向（要点のみ）【設計仮説・裁定前】

- **着地**: 1 task 1 PR を維持（複数 task の batch 着地は棄却——rework 混入確率 89〜97% の試算・事故の再輸入。PR を経ない direct-to-main は過去事故の制度化として棄却）。強化: branch 最新化の機械強制（strict モード）＋エンジンによる直列 arm＋main への push 時 CI。**寿命条件**【critique E-2】: 現在の「CI 51 秒」前提の数字であり、検証資産全量搭載（M13）後に CI が 10 分級になれば直列 arm は再設計。
- **承認入力**: 現行の盤面列 drag（Ready 列）から `gov:approve` ラベルへの変更が候補優位（actor の機械検証がしやすい）。ただし**未確認×未確認の比較**【critique D-1】＝両方式とも actor 取得可否・PdM 操作性が未実測であり、実測＋移行ハザード対策（ラベル忘れで統治が silent 停止する窓）を裁定条件とする。durable execution 側では、どちらの入力面でも「検出 activity → workflow への signal/update 注入」に正規化される（6.1 表⑥）。
- **教材配信**: 承認材料（plan の教材化文書）は「承認が起きる場所」へ一次配信し、投稿直後に post-check（実在・非 stub・整合）。GitHub Discussion は放送・アーカイブ面に格下げ（存廃は裁定待ち）。旧系では `@file` 未展開の 59〜64 字の壊れた stub が承認材料として盤面に載った実弾がある【事実】。

### 6.5.4 残余（分離しても消えないもの）【設計仮説・隠さない】

- 人間が GitHub 投影を読んで誤解する余地（投影 stale）は残る——ただし機械の判定には接続しないため事故クラス 1 には戻らない。緩和: 台帳⇄GitHub の毎パス突合＋生成時刻の刻印。
- 移行窓（旧系と新系の併走期間）の二重 dispatch は、新系内のテストでは検証できない切替時運用リスクとして残置【critique・両検証者共通指摘】。
- V1（日次 10〜20 PR 着地）という velocity 目標自体の錨が一次出典なし【未接地】であり、人間の承認読解時間（1〜数時間/日）が成立しない場合、エンジン投資は「拘束されていない制約の最適化」になる【critique A-1/A-3】——durable execution の採否とは独立に、要件の根の照合が先行する。

---

## 6.6 本節の結論（機能ベースの一枚絵）

【設計仮説・PdM 裁定前】durable execution は本系にとって「新しい能力の追加」ではなく、**実弾事故で必要性が証明済みの 8 つの手作り機構（manifest・live marker・breaker・resume・dedup guard・watchdog・cron 駆動・承認 polling）を、保証ごと既製 primitive に置き換える再配置**である。置き換えの対応は: 排他 claim→二重 dispatch（M1）／heartbeat→silent death（M2）／exactly-once step＋履歴→終端保証と transcript 死蔵（M5・M4）／versioning→stale 常駐と loop 自己改修（M7・M11）／signal→承認注入／永続 timer→dispatch 遅延（R2）。移らないのは系外監視・stage 内冪等性・再開始判定・権能分離・投稿検証・承認者検証で、これらは全案共通の自前責務。エンジン二択の機能差は「hang 検知と版固定の機械強制（Temporal ◎）」対「運用の軽さと既存 Postgres 同居（DBOS ◎）」の交換に縮約され、throughput は弁別しない。軽い代替（PG queue＋薄層)へ戻ると 7/8 部品の自作義務が復活し「自作 harness の保守」構図が再輸入される。GitHub 再設計はこの再配置の系: エンジンが状態の正本を引き受けることで、GitHub を「人間の入力と着地ゲート」だけの遅い面に限定でき、結果整合性・fail-open 書込・契約不安定という GitHub 固有の弱点が機械の判定経路から外れる。

**未確認の筆頭（本節スコープ）**: headless CLI spawn の engine 内先行例（両エンジンとも未発見・spike で自前実証予定）／DBOS の hang 検知／OS user 分離の existence proof／承認 actor の網羅性／V1 錨の PdM 本人照合。

# 高速ループ基盤 設計材料 v1（統合）

- 作成: 2026-07-08／read-only。読者: PdM。判定は書かない（§6 決定木のみ）。
- 入力: fl-velocity-requirements / fl-temporal-design-v0 / fl-alternatives / fl-github-role-redesign ＋ fl-critique（敵対検証・全指摘を本書に反映）＋ code-red-charter-material（M1〜M13/R1〜R8/S 系の正本）＋ foundation-decision-material（旧比較 routines vs 自作・runtime 子問題）。
- critique 反映の方針: 高重大度（A-1/A-3/B-1/C-1/E-1/E-2）は本文の設計・数値を**修正**、中低は注記。反映しきれない残余は §5 に隠さず列挙。
- 記法: 【接地】= 一次証拠あり／【未接地】【未確認】明記。数値正誤の統一: 07-04 merged = **31 件**（fl-github §2 の 5 件は窓切れ誤り・critique D-4）／run 母数 = **79 manifest**（66 は数え方の差・fl-velocity §1.6）／rework 率は二定義併存: **run 単位 36%**（25/70）と **stage 単位 50%**（CHANGES 18/LAND_REVIEW 36）——用途を都度明記（critique E-4）。

---

## 1. TL;DR

1. 構図 = **速い面／遅い面の分割**: 実行状態・排他・再実行判定は実行エンジン（DB 一次）が所有し、GitHub は「人間の入力面（起票・承認・裁定）＋読む面＋PR+CI 着地」に限定。**機械は GitHub から状態を読み戻さない**（方向規律）——S1-2（二重 dispatch/生成、窓内 3 回実弾・guard 後再発）の再発火条件を根治する。
2. エンジンは**二択に収束**: **Temporal self-host**（保証最強・値札 = 常駐 1 式＋non-determinism 新バグクラス＋学習 1〜2 週）vs **DBOS Transact TS**（追加常駐ゼロ・既存 PG 55433・急所 = プロセス生存中 hang の検知【未確認】）。routines は M3/M4 未解決（旧比較）で参考列に降格。
3. throughput は**全候補が 2〜4 桁の余裕で満たす**＝選定は容量でなく「保証の置き場」（M1 排他・M2 死活・M11 版固定）と値札の交換で決める。
4. Temporal の看板「claims テーブル消滅」は**過大**: Workflow ID の hard guarantee は「同時 open 1 本」のみで、Reuse Policy 既定（Allow Duplicate）は close 後の再 start を止めない。**再開始判定の設計は消えない**（critique B-1 反映済み・§3.1 で修正）。
5. velocity 要件のうち V2（p95≤15 分）・V3（≤5 分）は PdM 承認済み issue に接地。**V1（10〜20 PR/日）の錨は資料束に出典なし【未接地】**＝PdM 本人照合＋「人間律速の予算」（承認読解 1〜数時間/日）の成立確認が要件確定の前提（A-1/A-3）。
6. GitHub 着地は **1 task 1 PR 維持＋A'（strict=true・エンジン直列 arm・update-before-arm）＋push:main CI** が推奨。ただし定量根拠は「CI 51 秒」の世界の数字であり、**M13（heavy 層 CI 搭載）後の CI 予算で感度分析するまで「ほぼ無料」とは確定しない**（E-2）。
7. 承認入力の label 化（`gov:approve`）は機械検証面で優位だが、**未確認×未確認の比較**（timeline actor 網羅性 vs Projects actor 取得可否、両操作性とも未実測）。前日裁定 ADR 0035 の統治資産を置換する前に PdM 動線実測＋移行ハザード対策（drag だけして label 忘れ→統治 silent 停止）を条件化（D-1/D-2）。
8. 観測 = どちらのエンジンでも**無劣化**: `claude -p` はローカル worker/プロセスが spawn → local JSONL 100% → lathe ingest 変更ゼロ。Temporal Cloud を選んでも worker はローカル＝transcript 主権は保たれる。ただし「headless CLI を engine の step/activity で spawn」する公開先行例は**未発見**＝Step 0 で自前 existence proof を取る。
9. keep 資産（spawn 抽象・posting 台帳＋post-check・envelope・contracts・rubric 48 本・plan 契約・triage・gh 癖台帳）は**エンジン非依存の共通部品**として全案で同じ場所に載る＝裁定前の先行着手が無駄にならない。
10. 最安の不確実性削減 = **Step 0 spike 1〜2 日・並走可**（§7 の順: 錨照合→OS user 分離→spawn 実証→DBOS hang→Temporal podman/Policy）。

---

## 2. velocity 要件（確定数値案）

前提修正（critique 反映）: 「実測に正当化された目標」と言えるのは V2/V3/V6/V7。V1 は**目標としては可・実測正当化は不可**（単日ピーク 22 の 1 回到達 ≠ 毎日再現。直近 5 日の自律 loop 産は 31 日窓でなく 9・2・0・22・11＝中央値 ≈9）。

| # | 指標 | 確定数値案 | 接地状況・critique 反映 |
|---|---|---|---|
| V1 | 日次着地（**task loop PR に限定**・explain は別指標） | **10〜20 PR/日・5 営業日移動平均** | 【未接地】「PdM 発言」の一次出典なし（A-1）→ **裁定時に本人照合必須**。inner+explain 合算は Goodhart 脆弱（教材 PR で目標充足できる）のため task PR 限定に修正（A-6） |
| V1' | **人間律速の予算**（新設・V1 の成立条件） | PdM 承認読解 **20 件/日 × O(数分〜十分) = 1〜数時間/日** を PdM が受容するか | 【未検証】（A-3）。Ready→着手 p95 52 分の「機械遅延 vs PdM 不在時間」分解を §7-1 で先行実施。不成立なら V1 持続は基盤選定と独立に不成立＝V2 以降が非拘束制約の最適化になる |
| V2 | 反応遅延 Ready→着手 | **p95 ≤ 15 分**・設計値 pass ≤5 分＋非同期 dispatch | 【接地】issue #256（PdM「1,2,3 承認」）で本文一致確認済み |
| V3 | silent death 検知 | **≤ 1 pass（5 分）** | 【接地】issue #281（PdM「いいだろう」）。エンジン側の設定値対応を §3 に明記（B-3 反映） |
| V4 | 着地遅延（run 終端→merge） | **p95 ≤ 5 分**。ただし **wave（k≥6 同時 arm）時は k×CI 分の尾を正常系として許容**と再定義 | E-3 反映: V7（バースト正常系）と A' 直列 arm は素の p95 5 分と衝突する。再定義の採否は PdM 裁定 |
| V5 | 同時実行数 | **定常 3〜5・設計上限 10** | 導出を mean ベースで締め直し（A-4）: active は右裾分布（median 18.3・p90 46.2 分）＝mean 25〜30 分 → 20 PR/日で 8〜10h agent-busy → 3〜5 並列で日中窓。結論は維持・導出の甘さを明記 |
| V6 | 排他保証の窓 | **in-flight 全期間＋run 終了後の投影 lag 窓**（run wall p90 ≈150 分＋着地 lag）で二重生成が物理不可。cross-machine 込み | B-1 反映: 危険窓は run 終了後にも延びる（EXPLAIN#236 型＝同時 open だけでなく、close 後の「未完了」誤読も塞ぐ）。5 分だけ塞ぐ guard は `eca8247` で反証済み |
| V7 | イベント処理能力 | **分あたり複数 dispatch・1 pass 6+ を正常系** | 【接地】実測（<60 秒間隔起動 25%・1 pass 最大 6 dispatch） |
| V8 | 予算包絡 | **要件から降格 → PdM 裁定事項**: $70〜200/日（月 $2,100〜6,000）の支出承認 | A-5 反映: charter D1「コスト削減は選定理由にならない」は選定統制であって支出承認ではない。承認まで要件表に載せない |

連立性（不変）: V2/V5/V7 を維持する限り、現行部品（fs 導出 dedup・同期 dispatch・fail-open 書込）は構造的に壊れる（B1〜B10 照合表 = fl-velocity §3）。**V6・V3・V4 の同時採用で初めて充足可能**。「遅くして直す」は V2 と矛盾し選択肢にない。

---

## 3. 全体像

### 3.1 速い面 — エンジン 2 構成図

共通則（両案同一）: 実行状態・排他・再実行判定は engine DB 一次／`claude -p` spawn は**単一モジュール・ローカル実行**（credential なし・env strip・worktree 隔離）／gh 書込は**別 OS user の posting 面のみ**（唯一の credential・render→intent 台帳→REST→post-check→confirmed・失敗は台帳 failed＋次パス補償）／**intake が gh から読むのは人間の入力（新規 issue・承認 label・裁定 comment）のみ、状態は読み戻さない**（E-1 解消: fl-temporal 旧 M10「gh 導出維持」は本規律に書き換え済み）。

```
[案 T] Temporal self-host（保証を OSS engine から借りる）
  GitHub（入力・読み物・PR+CI 着地）＋ Actions cron = 系外 heartbeat
     ▲ 読み=人間入力のみ         ▲ 書込= worker B のみ    ▲ PR/auto-merge
  ┌ case ────────────────────────────────┐
  │ Temporal Service（podman compose: server+専用PG+UI、server≥v1.29.1）│
  │   = timer/retry/signal/history の正本。workflow ID task-N          │
  │ worker A（orchestration・credential なし・Versioning pinned）      │
  │   taskWorkflow: plan→投稿→await 承認(update)→implement→verify→land │
  │   spawn activity: claude -p ローカル spawn＋30 秒毎 heartbeat       │
  │   （heartbeat timeout ≤2.5 分・start-to-close 90 分 ⇒ V3 充足）     │
  │ worker B（posting・別 OS user・唯一の gh credential・別 task queue）│
  └── local JSONL 100% → lathe ingest（providers 変更ゼロ）──────┘
  M1 の正確な形（B-1 修正済み）: 「同時 open 1 本」は platform hard。
  close 後の再 start は Reuse Policy 裁定＋**intake の再開始判定を
  Temporal 照会（同 ID 実行履歴）or posting 台帳で行う**（gh 導出禁止）。
  ⇒ claims の「実装」は消えるが「再開始判定の設計」は残る。

[案 D] DBOS Transact TS（軽量代替最有力・ライブラリで既存 PG に建てる）
  GitHub（同上）＋ Actions cron = 系外 heartbeat
     ▲ 読み=人間入力のみ         ▲ 書込= posting proxy のみ ▲ PR/auto-merge
  ┌ case ────────────────────────────────┐
  │ engine プロセス（systemd 常駐 Node・DBOS ライブラリ・追加常駐ゼロ） │
  │   PG 55433 に system DB 同居。workflow ID task-N = exactly-once 起動 │
  │   step checkpoint→crash 後は最終完了 step から再開・durable sleep    │
  │   spawn step: claude -p ローカル spawn（案 T と同一モジュール）      │
  │   【急所】プロセス生存中 hang の検知は未確認 ⇒ 自前 watchdog        │
  │   （#281 の 3 点突合・純関数 5 個・PdM 承認済み plan）を oneshot 併設 │
  │ posting proxy（別 OS user・唯一の gh credential）= 自作案と同一部品  │
  └── local JSONL 100% → lathe ingest（providers 変更ゼロ）──────┘
  再開始判定: PG 一次（claim/台帳と同一 DB・同一トランザクション）＝
  「step 書込と durability 記録が同一 commit」のトランザクショナル保証。
```

### 3.2 遅い面 — GitHub の再設計後の役割

| 面 | 確定方向（裁定は §6） | 補強・条件 |
|---|---|---|
| 着地 | **1 task 1 PR 維持**（batch 棄却: ρ≈1.4%・P(rework 混入)≈89〜97%・S2-4 再輸入／direct-to-main 棄却: ADR 0026 事故の制度化・M3 放棄／merge queue: 個人 repo 不可=一次情報） | **A' = strict:true＋エンジン直列 arm＋update-before-arm（merge commit 方式・rebase 禁止）＋squash 統一＋push:main CI**。現存穴「merge 後合成状態が無検査」（strict:false・push CI なし=実測）を塞ぐ。**寿命条件**: M13 後 CI が 10 分級になれば +10 分/件・wave 尾 k×10 分＝直列 arm の再設計（並列 arm＋strict 別形）が要る（E-2）。judge を CI に上げる場合の LLM key 配置は M3 と緊張＝未設計 |
| 承認入力 | 遅延は決め手にならない（人間段 O(分〜十分) ≫ polling 5 分）。決め手 = actor 機械検証・PdM 操作性・契約面の広さ | **B 案（`gov:approve` label・polling 床・webhook は加速器限定）が候補優位だが、裁定は D-1/D-2 の条件付き**: ①timeline actor contract test（M12 第 1 号）GREEN ②PdM 承認動線の実測（drag vs label タップ・デバイス・所要） ③移行ハザード対策（移行期間は Ready 列と label を**等価に読む**＋watchdog が「Ready 在中×gov:approve 不在×N 分」を検出して注意 comment）。将来 = lathe UI intent（DB 権限で fail-closed・S2-11 の唯一の構造解） |
| issue | 起票面（`gh issue create`・採番・却下ゼロ = ADR 0031 実証資産・task key = issue 番号維持）＋読む面＋恒久記録。承認 = **その時点 plan の sha 固定 snapshot を engine が取り込む**（承認後編集の曖昧さ排除） | 二重台帳は方向規律で「台帳＋キャッシュ」に降格。残余 = 投影 stale で人間が誤読（S1 系には戻らない）→ 台帳⇄gh 毎パス突合＋generated-at 刻印 |
| 教材配信 | 承認材料は**承認が起きる場所へ一次配信**（REST・post-check 5 項目・intent_sha256 冪等）。Discussion は放送・アーカイブ面に格下げ（存廃裁定）。explains/ 正本 keep・auto-PR を承認 evidence に直列させない | D-3 反映: 「issue comment へ全文投下」は読む面を自分で劣化させる（#281 実物: plan×3＋escalation 堆積）。**一次配信の形式（collapsed section／固定 comment 更新／先頭要約＋リンク）は実装前に設計**——1 面化の狙いと全文投下は別物 |

### 3.3 観測 — transcript 主権の担保方式

- 両案とも spawn はローカル＝**local JSONL 100%・ingest providers 変更ゼロ・観測無劣化**。routines cloud の判定 B（効率監査の中核所見が一つも導出できない=実測済み）はどちらでも発生しない。Temporal Cloud 選択時も worker はローカル＝主権維持（Cloud は history だけ預かる）。
- 【未確認】「headless CLI subprocess を engine の activity/step で spawn」の公開先行例は Temporal/DBOS とも未発見（「無い」でなく「未発見」・技術的障壁は特定されていない）→ **Step 0 で両エンジンの自前 existence proof**（JSONL 残存＋ingest 成功まで）。
- 発展経路: 「engine が ingest schema へ直接書く」（D4-b・観測=正本）は engine DB を PG 55433 同居にした場合にのみ自然に開く＝案 D は既定で同居・案 T は Temporal 用 PG の置き場裁定に依存。

### 3.4 keep 資産の載せ場所（エンジン非依存＝先行着手可能）

| keep 資産 | 案 T での置き場 | 案 D での置き場 |
|---|---|---|
| spawn 単一モジュール（backends.mjs 改造・R5 backend 抽象維持） | worker A の activity 実装 | engine の step 実装（同一コード） |
| posting 台帳＋post-check 5 項目＋intent_sha256 | worker B（edge activities） | posting proxy（自作案部品そのまま） |
| envelope schema 群（M4） | activity 戻り値（history 永続） | step 戻り値（PG checkpoint） |
| contracts データ（plan 契約 6 節・explain 2 段化・watchdog-checks）・rubric 48 本 JSON・label 語彙 `gov:*`/`run:*` | repo データ（両案共通・エンジン外） | 同左 |
| escalation triage（純関数＋unit test）・R7 plan schema・R8 `gov:p1/p2/p3` | workflow の分岐関数 | workflow の分岐関数 |
| gh 癖台帳 Q1〜Q7・REST 移行知見 | M12 contract test 化（毎時＋CI） | 同左 |
| ADR 0031「導出」原則 | **方向規律に改訂**: 人間入力のみ gh から導出・実行状態は engine 一次（両案共通・E-1 の解） | 同左 |
| ADR 0036 版固定 | Worker Versioning pinned＋replay test（機械強制） | systemd 再起動規律＋CI からの版付き deploy（運用担保） |
| worktree 単一 writer・chip 禁止・切替検収 4 点（#282） | 運用規律として不変 | 同左 |

---

## 4. M1〜M13 三案比較表（critique C-1 の充足・同一物差し）

◎=構造/platform 保証・○=自前コードで充足・△=条件付き・✗=未解決。routines 列は旧比較（foundation-decision-material §2）の現時点評価を再掲（hybrid 込み）。

| # | 要件 | 案 T: Temporal self-host | 案 D: DBOS＋自前 watchdog | 参考: routines（cloud/hybrid） |
|---|---|---|---|---|
| M1 | 二重実行の物理不可能化 | **○→◎条件付**: 同時 open 1 本は platform hard・cross-machine 自動。ただし Reuse Policy 既定は close 後再 start を許す（B-1）→ Policy 裁定＋再開始判定の engine 照会化で ◎ | **○**: workflow ID exactly-once 起動＋PG 一意性（claim と同一 DB・同一 Tx）。再開始判定の設計宿題は案 T と同じ | ○ DB claim 同設計。DB 到達 (d) 未確認・不達 no-op が silent |
| M2 | silent death 検知 | **◎（run/worker 死）**: heartbeat 30 秒・timeout ≤2.5 分で V3 充足＋自動 retry。サービス/マシン丸ごと死は系外 heartbeat 必要（共通） | **△**: **hang 検知未確認（#281 直撃の急所）** → 自前 3 点突合 watchdog 併設が採用条件。crash 再開は PENDING scan で ○ | △ 系外監視なし・platform 相関故障（監視も同時沈黙） |
| M3 | 権能分離 fail-closed | △ task queue 分離＋別 OS user。**existence proof 未取得（三案共通）** | △ プロセス分離＋別 OS user（同上） | ✗ 実行 identity (g) 仕様待ち・最重大未解決 |
| M4 | I/O 構造化 | ○ activity 戻り値が history 永続（回収経路構造化） | ○ step 戻り値が PG checkpoint | △ envelope 回収経路が cloud-full で不存在 |
| M5 | 終端契約＋補償 | ○ retry policy＋compensate 分岐が骨組み。post-check 自前 | ○ step retry＋durable 再開。post-check 自前 | △ M4 連動で未規定 |
| M6 | spawn 単一モジュール | ○ 自前＋CI grep（三案同一） | ○ 同 | △ session 生成手段 (b) 未確認 |
| M7 | 版固定＋self-update | **◎ pinned が機械強制**（走行中は旧版完走・replay test）。裏面: worker 常駐の stale 化が戻る（deploy 規律で緩和） | △ ライブラリ＝プロセス再起動で版切替（oneshot 化は durable 再開と両立させる設計次第）。外部 id 名前解決は自前（共通） | ◎ 毎発火 fresh checkout |
| M8 | 環境正本化＋検収 4 点 | **✗→○ 三案中最重**: E クラス全残＋Temporal service 運用純増（podman 4 コンテナ・PG もう 1 系統・版上げ schema migration） | **○ 三案中最軽**: E クラス全残・**追加常駐ゼロ**・PG は既存 55433 | ◎/△ cloud で宿主消滅だが proxy 等の自前常駐 2〜3 新設で集計矛盾 |
| M9 | 投稿物 post-check | ○ 三案同一の自前設計 | ○ 同 | ○ 同（M4 経路に連動） |
| M10 | 状態は導出・二重台帳禁止 | ○ **修正後**: 人間入力のみ gh 読み・実行状態は engine 一次（E-1 解消） | ○ 同（PG 一次が最短） | ○ gh 導出維持＝投影 lag 窓の S1-2 残余あり |
| M11 | loop を loop で改修しない | **◎ 三案中最強**: repo コード＋PR+CI に加え pinned が走行中混入を機械禁止 | ○ repo コード＋PR+CI（機械強制なし・運用規律） | △ routine 定義・cron 変更がゲート外 |
| M12 | 外部契約 contract test | ○ 共通＋Temporal 契約は SDK 型と replay test が肩代わり | ○ 共通＋DBOS 契約面は npm ライブラリ（薄い） | ○ 共通 |
| M13 | CI 検証資産全量 | ○ 共通＋**replay test という新資産** | ○ 共通 | ○ 共通 |

**交換の要約（C-2 反映）**: Temporal 固有の実利は 3 点に縮む——①M11 の機械強制＋replay test ②activity heartbeat による hang 検知（DBOS の急所を platform で埋める） ③保証実装の bus factor 緩和。**値札** = 常駐 1 式（podman 4 コンテナ＋PG 追加）＋non-determinism という新バグクラス＋学習 1〜2 週【推測・実測なし】。DBOS 側の同 3 点の自前コスト: ①CI deploy 規律＋再起動運用（機械強制なし） ②watchdog 純関数 5 個＋oneshot（#281 plan で PdM 承認済み・実装未） ③自前保証の bus factor 1 が残る。**throughput（V1/V5/V7）は三案とも余裕で満たし選定を弁別しない**。PdM 裁定「プロジェクト外のハーネスは必要ない」に形態が最も適合するのは app 内ライブラリ＋既存 PG（案 D）——ただしこの整合は形態論であり、保証の強度（②の未確認）と交換関係にある。

---

## 5. critique 反映後の残リスク（隠さない）

1. **V1 の錨が未接地のまま**（A-1）: 「10〜20 PR/日」の一次出典なし。本書は本人照合を前提条件化したが、照合前に下流（V5 導出・予算包絡）が仮数値で走るリスクは残る。
2. **人間律速の予算が未検証**（A-3）: 承認 1〜数時間/日 が不成立なら、エンジン投資自体が非拘束制約の最適化。p95 52 分の内訳分解（§7-1）を先行させる以外の緩和なし。
3. **headless spawn の先行実例なし**（両案共通）: Step 0 の自前 existence proof が落ちた場合の代替（API 直叩き・ADR 0014 の別 backend）は設計未着手。
4. **M3 の existence proof 未取得**（三案共通）: OS user 分離＋LoadCredential が不成立なら fail-closed は準構造（運用規律）に後退＝受容裁定が要る。
5. **案 D の急所は未確認のまま**: DBOS の hang 検知は spike で潰す計画だが、「watchdog 併設で足りる」は #281 plan の設計信頼に依存（適用実績なし）。fan-out 時の PG ロック/WAL 負荷・1.3k★ の採用実績の浅さも残る。
6. **案 T の値札は消えない**: 学習コスト【推測】・schema migration の実務負荷【未調査】・「Temporal を知る人間 1 人」という新 bus factor。規模ミスマッチ（数 task/日 vs 百万/日級の道具）の構図も残る。
7. **A' の定量根拠に寿命**（E-2）: M13 後の CI 予算が未計測。CI が 10 分級なら直列 arm・V4 再定義とも再設計。judge の CI 昇格と M3（LLM key 配置）の緊張は未設計。
8. **承認 label 化の両側未実測**（D-1）: 本書は「実測後に裁定」に修正したが、実測（§7-9）自体が未実施。移行ハザード対策（D-2）も設計のみ・適用実績なし。
9. **移行窓の旧新併走二重**（S1-2 再発窓・両 critique 共通指摘）: gov:hold＋旧 timer/orchestrator 停止→新系 PoC の隔離手順を Step に明記したが、旧新併走の二重を検証する試験は「新系内の並列 2 issue」では代替できない＝切替時の運用リスクとして残置。
10. 細部: rework「15 分/件」の時間実測なし（与件）／V4 wave 尾の再定義は PdM 未承認／系外 heartbeat（Actions cron）の遅延・60 日無効化仕様は未実測／Temporal Cloud 価格は未照合。

---

## 6. 決定木（判定は書かない。根 = PdM の仮説採否は済み: 速い面=エンジン所有・遅い面=GitHub 限定・観測主権維持）

```
FL-0. velocity 数値の確定（他の全分岐の物差し）
│  0a. V1 の錨: 「10〜20 PR/日」を PdM 本人が確認（出典 or 口頭裁定として記録）
│  0b. 人間律速予算: 承認読解 1〜数時間/日 を受容するか
│      → 受容しない場合: V1 を下方修正 or 承認粒度の再設計（重要 task のみ Ready 承認等）
│      → ここが崩れると FL-1 の投資規模の妥当性が変わる
│  0c. V8: $70〜200/日 の支出包絡を承認するか
│
FL-1. エンジン選定（Step 0 spike 結果を待って裁定可能）
│  ├ 案 T (Temporal self-host):
│  │   T-a. Reuse/Conflict Policy と再開始判定の設計裁定（B-1。RejectDuplicate は正当再走も塞ぐ）
│  │   T-b. SDK 言語（基線 TS: Node 資産と地続き・sandbox 強制）
│  │   T-c. Temporal 用 PG: 55433 同居 or 専用
│  │   T-d. self-host 基線・Cloud（$100/月）は縮退先として保持（可逆）
│  ├ 案 D (DBOS):
│  │   D-a. hang 検知の補完方式（自前 watchdog oneshot 併設 = 既定）
│  │   D-b. system DB は 55433 同居（既定）→「観測=正本」発展経路が開く
│  │   D-c. 版固定の運用形（systemd 再起動規律＋CI 版付き deploy）で M7/M11 の機械強制なしを受容するか
│  └ 共通: M3 existence proof 不成立時 → 準構造（同一 user＋運用規律）受容 or 撤退
│
FL-2. 承認入力（FL-1 と独立・ただし実測 §7-6/9 が前提）
│  ├ Ready 列継続（ADR 0035 資産温存・S2-2 面と actor 未検証を受容する裁定として記録）
│  ├ gov:approve label 化（actor contract test GREEN＋動線実測＋移行期間の両入力等価読みが条件）
│  └ 将来: lathe UI intent への移行予約（ADR 0031 §6 の扉）を今認めるか
│
FL-3. 着地面
│  ├ A（現状＋push:main CI のみ）or A'（strict=true＋直列 arm・推奨）
│  ├ squash 統一の追認
│  └ M13 後 CI 予算の感度分析（§7-8）後に A' の直列度を再確認（>10 分なら再設計）
│
FL-4. 配信面: Discussion 存廃／教材一次配信の形式（全文 or 要約＋リンク or 固定 comment 更新）
│
FL-5. 共通に決めるもの（エンジン非依存）
│   credential 種別（GitHub App or machine user PAT）／基盤の置き場
│   （lathe repo 内 ADR 0038 packages or 別 repo——「プロジェクト外のハーネス不要」裁定との整合）
│   ／共通部品（§3.4）の先行着手承認／Step 0 spike の実施承認
```

---

## 7. Step 0 検証項目の統合リスト（実測で潰す順・1〜2 日で並走可）

順序基準: 要件の根 → 採用可否を左右 → 設計の骨格 → 周辺。[T]=Temporal に効く・[D]=DBOS に効く・[共]=両案/裁定全体。

| # | 検証項目 | 効く先 | 潰し方／分岐 |
|---|---|---|---|
| 1 | **V1 錨の PdM 本人照合＋人間律速の分解**（Ready→着手 p95 52 分の機械遅延 vs PdM 不在時間。07-07 の承認所要の復元） | [共] FL-0（要件の根） | spike でなく裁定前確認。不成立なら V1 下方修正＝エンジン投資規模の再考 |
| 2 | **OS user 分離＋LoadCredential の existence proof**（agent が repo を書けて token を読めない） | [共] M3 採用可否 | case 上 1 日。不成立→準構造受容の裁定へ |
| 3 | **headless `claude -p` spawn の engine 内実証**: [T] 長時間 activity＋heartbeat＋worker kill→retry／[D] step 内 spawn＋crash→PENDING 再開。**両方で local JSONL 残存＋lathe ingest 成功まで確認** | [共] 設計成立・観測主権 | 先行実例未発見の穴を自前で閉じる。落ちたら backend 差し替え（ADR 0014）設計へ |
| 4 | **DBOS: プロセス生存中 hang の検知可否**（公式に heartbeat 明記なし） | [D] M2 採用可否 | 1 日 spike。検知不能なら「自前 watchdog 併設」が正式条件＝案 D の値札に計上 |
| 5 | **Temporal: case podman で compose 実測**（Postgres 構成・server ≥v1.29.1/CLI ≥v1.4.1/UI ≥v2.38.0＝Versioning GA 条件）＋**Reuse Policy 挙動実測**（close 後の同 ID 再 start・Conflict Policy） | [T] 採用可否・T-a | 動作報告はあるが本環境未検証。Policy 実測は B-1 の設計裁定の材料 |
| 6 | **timeline `labeled` イベントの actor 網羅性**（M12 contract test 第 1 号） | [共] FL-2 前提 | 承認検証の共通前提。取れなければ label 化の優位が崩れる |
| 7 | **CC headless の schema 強制出力可否** | [共] M4 強度 | 不成立でも bounded retry で運用可（強度 1 段落ち・三案同条件） |
| 8 | **M13 後 CI 予算の計測**（heavy 層 e2e/storybook/integration/judge を CI 相当で回した実測値） | [共] FL-3 感度 | CI >10 分なら A' 直列 arm・V4 再定義とも再設計。judge の key 配置（M3 緊張）も此処で設計 |
| 9 | **PdM 承認動線の実測**（Ready drag vs label 付与の実タップ数・所要・デバイス） | [共] FL-2 | 未確認×未確認の比較を実測に置換してから裁定（D-1） |
| 10 | **Actions cron の実遅延＋60 日無活動自動無効化の本 repo 照合** | [共] M2 系外段 | SLO 未達なら系外監視の代替（別マシン・外部監視）裁定へ |
| 11 | 課金経路（API key か Max サブスク充当か） | [共] V8/D1 材料 | $150.9/79run 前提の照合 |
| 12 | OS user 分離×worktree 運用詳細（git 所有権・pnpm store 共有） | [共] 運用 | #2 に同梱 |
| 13 | Projects v2 列移動 actor の API 取得可否 | [共] FL-2 で Ready 継続を選ぶ場合のみ | 選ばなければ不要 |

補足: #2〜5 は相互に排他でなく並走可能（計 1〜2 日）。#1・#8・#9 は spike でなく計測・照合であり、裁定日程と独立に着手できる。§3.4 の共通部品（claim/台帳 DDL・post-check・envelope・contracts・triage・M13 CI 全量）は**どの分岐でも無駄にならない**＝Step 0 と並行の先行着手候補。


---

# §7 未決の裁定点と、あなた（外部分析者）への問い

## 7.1 未決の裁定点

最上位: **D-0 製品戦略** — lathe は「駆動を所有する製品」（loop 実行そのものが観測・改善対象 = 自系で閉じる）になるか、「駆動を外部化し統治と観測に徹する製品」になるか。この選択だけが他の全軸（保証の所有権・依存・観測・可逆性）の重み付けを決める。以下の決定木・裁定分解は §5 末尾（決定木）と §6 末尾（Step 0 実測リスト）に収載。

主要な下位裁定: エンジン選定（Temporal self-host / DBOS / Postgres queue＋自前薄層)・観測劣化の受容可否（実測照合済み: cloud 実行の劣化観測では本書 §2 レベルの診断は再現不能)・権能分離の実現手段（agent に書き込み credential を持たせない構造をどう作るか)・GitHub 上の承認面の形（label / 盤面 / 専用 UI)・基盤の置き場（製品 repo 内か独立 repo か）。

## 7.2 外部分析者への問い

1. **根因診断への反証**: 「事故の主因は、分散した状態を非トランザクショナルな他人のサイト上に置き、短命プロセス群で高速ループを回したこと」という診断（§4・§6）に、見落としや別解釈はあるか。26 incident の分布（§2）を別の単一原因でより良く説明できるか。
2. **D-0 の判断軸**: 「駆動を所有する」vs「駆動を外部化する」の二択の重み付けで、本書の戦略 5 軸（保証の所有権・依存の非対称性・観測の主権・製品戦略・可逆性）に欠けている軸はあるか。
3. **エンジン選定の適正規模**: 個人＋agent 群・数十 task/日という規模に対し、Temporal self-host / DBOS / Postgres queue＋自前薄層はそれぞれ overkill / underkill か。判定の基準は何であるべきか。
4. **GitHub 再設計案の盲点**: 「1 task 1 PR は維持・状態機械は追い出す・承認は label または専用 UI・issue は人間の読み物」という再設計（§4・§5）の見落としは何か。
5. **体制固有のリスク**: 「設計・実装・レビュー・運用を LLM agent が担い、人間は承認のみ」という体制に固有のリスクで、本資料が未対処のものは何か。特に: 自己申告の連鎖（agent が agent の報告を検証せず中継する — 本運用で 3 回実際に起きた)・bus factor 1・統治違反（承認なしの行動 — 9 件実績）の構造的抑止。
6. **段階移行計画の危険点**: Step 0（仕様の実測 spike・1〜2 日）→ PoC（実 task 1 件の無人一巡を 4 点機械検収）→ 段階展開、という計画（§6 末尾）の危険点はどこか。特に新旧システムの併存窓（旧排他と新排他が互いを見えない期間）の扱い。
7. **資料自体の品質**: この分析を行う上で、本資料に不足している情報は何か（それは今後の観測設計の欠陥リストとして使う)。

---

# 付録 A: 用語集（本文で使う内部用語）

| 用語 | 意味 |
|---|---|
| PdM | 人間のオーナー 1 名。承認・裁定・vision のみ担当 |
| 監査役 | outer 側の主 agent（本書の編纂者)。監視・issue 化・rubric 管理・escalation 対応を担う |
| inner / outer | inner = task を実装する自動ループ側。outer = それを監督する人間＋監査役側 |
| task / issue | GitHub issue がそのまま task（1 task = 1 issue)。状態は保存せず GitHub から毎回導出する原則だった |
| driver | 1 つの task を plan→審査→実装→着地まで進める実行プロセス（自作 node スクリプト群) |
| orchestrator | 5 分ごとに全 issue を分類し driver を起動する常駐プロセス |
| stage | driver 内の段（TASK_PLAN / PLAN_REVIEW / IMPLEMENT / LAND_REVIEW 等) |
| verdict | 各 stage の agent 出力末尾の機械判定トークン（PLAN_READY / PASS / RED / CHANGES / IMPL_DONE 等) |
| plan 契約 | plan が必ず持つ 6 セクション構造（問題/選択肢/方針/契約/検証/見積り)。見積り過小は差し戻し |
| rubric | コード規範の台帳（48 本)。決定的検査（grep 等）と agent-judge（LLM が違反数を数える）の 2 種 |
| agent-judge | rubric のうち機械式で書けない規範を LLM に判定させる検査器 |
| escalation | agent が自力で進められない時に人間の裁定キューへ差し戻す仕組み。文脈不足/環境起因/意思決定の三分岐（triage） |
| needs-review | 人間の承認が必要な task に付く label。教材生成→承認待ちのレールに乗る |
| 盤面 / Ready 列 | GitHub Projects のかんばん。人間が task を Ready 列に動かす = 承認、という規約 |
| 教材 / explain | 承認判断のために自動生成される解説文書（GitHub Discussion に投稿) |
| worktree | git worktree。実装は必ず隔離 worktree で行い main は単一 writer とする規律 |
| 検収 4 点基準 | 基盤切替の完了条件: 実 dispatch 1 件で ①子プロセスの生存 ②agent 応答 ③成果物の期限内出現 ④成功記録、の機械照合 |
| 版固定 / harness-release | 走行中の loop を loop 自身に改修させず、改修は版として一括実装・切替する規約（ADR 0036) |
| silent death | 子プロセスが痕跡ゼロで死に、システムが異常を報じない事故クラス |
| dispatch | orchestrator が task に対して実行プロセスを起動すること |
| manifest | 各 run の段別記録ファイル（所要・費用・判定・出力)。本書の実測の一次資料 |
| lathe | この開発基盤が属する製品。agent 開発の観測・改善・評価のプラットフォーム（transcript ingest・コスト分析・UI） |
| routines | Claude Code のクラウド自動実行機能。schedule / GitHub イベント（label 条件つき）/ API で発火し、ベンダー管理のクラウドで agent session を実行する |
| durable execution | workflow の状態・タイマー・再試行・生存監視をエンジンが永続的に保証する実行モデル（Temporal・DBOS 等) |
