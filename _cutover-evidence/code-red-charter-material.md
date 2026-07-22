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
