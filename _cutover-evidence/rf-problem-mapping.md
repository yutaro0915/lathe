# 問題 → routines 世界での解決 対応表

- 作成: 2026-07-08／入力: `code-red-charter-material.md`（S1〜S3・構造 5 クラス・M1〜M13・R1〜R8）
- 現行実装の意味論は repo で機械確認済み: `scripts/inner-loop-core.mjs:55`（`TASK_LOOP_STAGES = ['TASK_PLAN','PLAN_REVIEW','IMPLEMENT']`＋LAND phase `LAND_REVIEW`/`LAND_REWORK`）・`scripts/dispatch-runner.mjs`（fs live marker で排他）・`scripts/orchestrator.mjs`（`outcomes.jsonl` cross-pass breaker）・`design/loops.md`（loop 台帳）。
- read-only。repo・issue・PR への書き込みなし。

## 0. 前提 — 「routines 世界」のモデル（事実と未確認を峻別）

**機械確認できた事実**（本環境の scheduled-task/Cron tool schema 実測）:
- trigger は **cron（定期）または fireAt（一回）** のみ。発火ごとに **fresh session（前会話の記憶なし・prompt は self-contained 必須）**。prompt は SKILL.md として保存。完了通知（notifyOnCompletion）あり。
- ローカル版はアプリ起動中のみ実行（closed 中はスキップ→次回 launch で catch-up）。

**未確認**（cloud Routines の仕様。以下の対応表はこれらに依存する箇所を明記）:
- (a) GitHub イベント（label 付与・PR comment 等）を trigger にできるか
- (b) session 内から routine を動的生成・削除できるか（プログラマブル API）
- (c) 実行時間・並列数・コストの run 上限値
- (d) secret 注入（DATABASE_URL 等）と egress 制御・credential を「持たせない」構成の可否
- (e) settings/hook の session への持ち込み可否
- (f) session transcript の export API（lathe ingest 接続 = D4）
- (g) 実行 identity（本人アカウントか App/bot か）

**用語**: dispatcher = 毎 N 分発火する配車 routine（現 orchestrator の後継）。claim = DB の `(issue, stage, attempt)` 一意行。ledger = run/stage の DB 一次記録（M10 と非矛盾: 実行 telemetry は DB 単独正本・task 状態は gh 導出のまま＝同一事実の二重書きではない）。

---

## 1. 最重要設計判断 — 多段ライフサイクル（TASK_PLAN→PLAN_REVIEW→IMPLEMENT→LAND）を単発 session でどう表現するか

現行: driver 1 プロセスが全段連続実行（stage 間に人間承認は無い。人間ゲートは前=Ready・後=CI/merge のみ、`design/loops.md` 実測）。fresh-session 世界での選択肢 3 案:

| 軸 | 案A: 1 発火=1 issue 全段 | 案B: 段ごと routine（label/状態遷移で継走） | **案C: dispatcher＋stage-ledger 冪等再開（推奨）** |
|---|---|---|---|
| 機構 | dispatcher が claim → その session 内で全段完走（決定的 driver script を Bash 実行） | stage=1 session。終端で状態を正本へ書き、次の発火が次段を拾う | dispatcher が claim → session は「ledger の未完 stage から進めるだけ進む」。stage 境界ごとに ledger へ冪等記録し、上限接近・CI 待ちで graceful 終了→次発火が続きから |
| 段間レイテンシ | ゼロ（session 内） | 1 cadence×段数（4 段+review 2 周で 30 分超） | 通常ゼロ・中断時のみ 1 cadence |
| run 上限（未確認 (c)）耐性 | 弱（全段が 1 上限に晒される・LAND の CI 待ちで浪費） | 強 | 強（stage 境界で分割吸収） |
| 途中死 | ledger 無しなら全損（M2 型の再来） | stage 粒度で局所 | stage 粒度で局所・再開は ledger 導出（`decideResumeState` の IMPLEMENT 起点前提バグ S2-3 を機構ごと廃止） |
| 二重実行排他 | issue 粒度 claim で足りる | stage 粒度 claim 必須 | stage 粒度 claim（§2） |
| 所見の受け渡し（P1–P3） | session 内=死蔵リスク再来 | 構造強制（正本着地しないと次段が読めない） | 構造強制（ledger/issue が唯一の受け渡し面） |
| rework 周回（CHANGES 差し戻し） | session 内で回せるが上限を食う | 次発火が LAND_REWORK として拾う | 同左（PR コメント正本→導出） |
| 遷移状態機械 | 不要 | gh label/DB 上に自前実装（新しい故障面） | 「状態は導出」のまま（gh＋ledger から次 stage を計算。label 遷移機械は作らない） |

**判定**: 案C。案B の「label 遷移で session を繋ぐ」は内部遷移（PLAN_REVIEW→IMPLEMENT）まで gh に露出させ、書込ラグ（cr-github-defects §4-1）を段数分踏む。案A は run 上限 (c) と途中死で M2 を再輸入する。案C は現行 driver の決定的スクリプト資産を「1 発火で進めるだけ進む・どこで死んでも ledger から再開」に組み替えるだけで、S2-3（resume 破壊）・S2-4（rework 停止）・run 上限を同一機構で吸収する。イベント trigger (a) が使えるなら中断時レイテンシも消えるが、**設計は (a) 無しでも成立する形（cron polling）を基線**とする。

---

## 2. 共通部品の設計案（対応表が参照する 3 部品）

### 2-1. [自前:dedup] 一意性部品（M1 の具体化）

「発火→実行前に照合」ではなく **「INSERT 成功＝実行権」**（check-then-act の TOCTOU を残さない）。session は開始直後に claim `INSERT INTO claims(issue, stage, attempt, lease_expires, …) … ON CONFLICT DO NOTHING` を打ち、行が取れなければ**即終了**。fs マーカー・worktree 有無からの導出（現 `dispatch-runner.mjs` の live marker）は全廃。cross-machine（cloud×Mac 併存 #237）も同一 DB 制約下に入る。

claim 正本の置き場 3 択:

| 正本 | 原子性 | cloud session から到達 | 評定 |
|---|---|---|---|
| **DB（managed Postgres）unique 制約** | ◎（DBMS 保証） | 要 secret 注入＋egress（未確認 (d)） | **一次候補**。watchdog の照合面と同一にでき、M10 の「導出ラグに依存した再実行判定をしない」を文言どおり満たす。DB 不達時は **fail-closed（実行しない）** |
| git ref CAS（`refs/claims/issue-N-stage` を API createRef、既存なら失敗） | ○（server-side、ただし API の原子性保証水準は未確認） | gh credential のみで可 | DB 不可の場合のフォールバック。lease/掃除が自前・消し忘れ=永久 block・観測面が貧弱 |
| GitHub comment/label 照合 | ✗（書込→読取ラグ＝まさに S1-2 の窓、cr-github-defects §4-1 実測） | 可 | **不採用** |

repo 内 ledger file（commit/push を CAS に使う）も不採用: main を claim で汚し CI を発火させ、push 競合の解決自体が新しい故障面になる。

### 2-2. [自前:watchdog] 毎時突合 routine（M2/M5/M12 の具体化）

毎時 1 本（＋dispatcher 毎パスに軽量版を同居）。**何と何を突合するか**:
1. **cron 期待発火 × dispatcher heartbeat 行**（DB）— dispatcher 自身の silent death を dead-man's switch で検知。watchdog と dispatcher は相互に相手の最終実行時刻を検査（片方が生きていれば報知できる。両方同時死は platform 通知 (未確認) 頼み＝残余リスクとして明記）
2. **open claim × heartbeat 更新時刻 × lease 期限** — 失踪 run の検出・lease 失効で claim 解放・escalation issue 起票（S1-1 の「信号ゼロの死を人間より先に機械が報じる」）
3. **DB の「投稿済み」宣言 × gh 実在物**（PR/comment/Discussion の存在・本文長・`@file` 展開済み）— M5 書込失敗補償の事後網＋M9 post-check の二重化（S1-3/S1-4）
4. **gh Ready 列 × claim/outcome** — 「Ready なのに N 分未着手」の SLO 監視（S3-1）
5. **外部 id の名前解決 contract check**（盤面 option id・label 存在・gh API 前提）— M7/M12 を同居させ「silent 障害→実測→hotfix」の順を逆転

### 2-3. [自前:終端契約＋post-check]（M4/M5/M9 の具体化）

stage の「完了」= 決定的スクリプトが (i) 構造化出力（JSON schema）を検証し (ii) 正本（issue/DB）へ投稿し (iii) **投稿直後に読み戻して実在・非 stub・対象整合を照合**し (iv) ledger に terminal 行を書く、まで。失敗は「非致命 continue」でなく ledger に未達記録→watchdog 2-2-3 が補償。散文 prompt 契約・Stop hook 書式強制は持ち込まない。

---

## 3. 対応表 — S1（黙って止まる／重複が実弾化）

| # | 事象 | 種別 | routines 世界での解決（1 行） |
|---|---|---|---|
| S1-1 | silent death（cgroup 回収・検知ゼロ） | **[platform]＋[自前:watchdog]** | systemd/cgroup 系死因は managed cloud で消滅。ただし「発火したはずの run が無い」「cloud 側失敗」は残るため §2-2-1/2 の 3 点突合（claim×heartbeat×outcome）を常設 |
| S1-2 | 二重 dispatch 3 回実弾化（guard 後も再発） | **[自前:dedup]** | fs マーカー導出を全廃し §2-1 の claim INSERT＝実行権へ。dispatcher を単一 routine に限定（M6）し、cloud×Mac 併存も同一 DB 制約下 |
| S1-3 | 書込失敗の fail-open 握りつぶし→永久 WAIT_PR | **[自前:watchdog]＋[自前:終端契約]** | §2-3 で書込失敗を ledger に記録（continue で握りつぶさない）→ §2-2-3 が gh 実在と突合して次パス補償。エラーメッセージは ledger の実在参照のみ指す |
| S1-4 | `@file` 未展開 stub が承認材料化 | **[自前:post-check]** | 配信は決定的スクリプト（prompt 展開を LLM に任せない）＋投稿直後の読み戻し照合（本文長・展開・対象整合、§2-3-(iii)）。routines 自体は解決しない |

## 4. 対応表 — S2（古い前提・壊れた配管のまま走る）

| # | 事象 | 種別 | routines 世界での解決（1 行） |
|---|---|---|---|
| S2-1 | stale 常駐（5 commit 遅れ走行） | **[platform]＋[skill契約]** | 毎発火 fresh session＋fresh checkout で常駐プロセスの stale が構造消滅。ただし **routine prompt（SKILL.md）自体の stale は残る**→prompt は「repo の scripts/X を実行せよ」だけの thin bootstrap にし正本を repo（PR+CI ゲート下）に置く規約 |
| S2-2 | 外部 id の silent 失効（option id 直書き） | **[自前:watchdog]** | routines 非依存の自前問題。毎パス名前解決＋§2-2-5 の contract check（M7/M12） |
| S2-3 | resume 破壊（IMPLEMENT 起点前提） | **[platform]＋[自前:dedup]** | fresh session 世界では resume 機構そのものを廃止し、§1 案C の stage-ledger 導出再開に置換（claim 台帳が resume 状態の正本を兼ねる） |
| S2-4 | rework の non-FF 停止 | **[自前:dedup]（＋残余は cadence レイテンシ）** | fresh checkout＋「push 済み履歴は追記のみ（rebase 禁止・force-push 禁止は server 側 branch protection で機械化）」。CHANGES 差し戻しは PR コメント正本→次発火が LAND_REWORK として導出（§1 案C）。周回ごと最大 1 cadence の遅延は残る |
| S2-5 | Stop hook の二重課金 | **[自前:構造化出力]** | Stop hook を持ち込まない（drop 確定と整合）。verdict は headless の構造化出力＋§2-3 の schema 検証で保証、再生成強制は発生しない |
| S2-6 | settings 暗黙 load の分離破れ（pin 貼り忘れ 2 箇所） | **[自前:単一 spawn]＋一部[未解決]** | spawn 面が「dispatcher が起こす cloud session」1 経路に収斂すれば pin 分散は構造消滅（M6）。ただし session 側の settings/hook 持ち込み仕様 (e) と credential 分離 (d) は未確認＝fail-closed をどこで保証するかは M3 と同じ未決 |
| S2-7 | plan 所見の不達（盲目再生成・false RED） | **[自前:配管]** | 所見は issue/ledger へ着地させ、次 stage の prompt へ決定的スクリプトが注入（R1 情報注入契約）。fresh session は transcript 持ち越し不能＝正本着地が構造強制される（方向として routines と好相性） |
| S2-8 | 成果物の transcript 死蔵（ASK_PDM 終端） | **[自前:終端契約]** | §2-3: 「正本への投稿完了＋読み戻し照合」までが stage 完了。fresh session では transcript は毎回消えるため、この契約なしでは系が成立しない＝必須部品に格上げ |
| S2-9 | FILE_CHILDREN 書式クラッシュ×2 | **[自前:構造化 I/O]** | 散文契約の追放（M4）。子 issue 定義は JSON schema 出力→決定的スクリプトが投函。routines 非依存 |
| S2-10 | 環境応急処置の未恒久化（E1–E3） | **[platform]** | 宿主環境差（cgroup/OAuth/pnpm 欠品）は managed cloud で消滅。環境定義は routine/環境 spec としてコード化し repo 正本に。**切替検収 4 点（#282）は cloud 移行時にそのまま適用**（M8） |
| S2-11 | 承認シグナル汚染（PdM 認証で agent が動く） | **[未解決（悪化リスク）]** | routines は**本人身元で実行される可能性が高く**（(g) 未確認）、汚染はむしろ悪化しうる。緩和は書込を GitHub App/bot token の proxy に固定する自前策だが、session に本人 credential を「持たせない」構成の可否は (d)(g) 次第＝**D2(c) の PdM 裁定＋platform 仕様確認が前提** |
| S2-12 | CI が「ザル」（検証資産の全量未搭載） | **[自前:CI]** | routines 非依存。M13 どおり PR+CI 単一ゲートに全量搭載。thin-prompt 規約（S2-1）により routine の中身も CI ゲート下に入る副次効果 |

## 5. 対応表 — S3（効率・品質・統治の劣化）

| # | 事象 | 種別 | routines 世界での解決（1 行） |
|---|---|---|---|
| S3-1 | dispatch 遅延（同期 pass・p95 52 分） | **[platform]（一部未確認）＋[自前]** | 発火=独立 session で pass 内同期詰まりは消滅。並列度は「dispatcher 1 発火 1 claim×cadence」が基線、issue ごと fireAt one-shot の動的生成 (b) やイベント trigger (a) が使えればリードタイムは設計値に——**(a)(b) は未確認**。§2-2-4 の SLO 突合で劣化を検知 |
| S3-2 | ナビ再発掘（bash の 37% が探索） | **[自前:注入契約]** | R1: 機械が既に知る情報（plan・diff・scope 照合）を prompt 生成スクリプトが注入。fresh session では毎回ゼロから探索になるため**現行より必須度が上がる** |
| S3-3 | 4 択正解位置バイアス（b に 66%） | **[自前:決定的規則]** | R4: 配置は乱択スクリプトで決定（散文指示では直らないと実証済み）。routines 非依存 |
| S3-4 | gh 仕様癖の被弾（Q1–Q6） | **[自前:contract test]** | 癖台帳（keep 資産）を §2-2-5 の contract check に翻訳し事前検知へ。escalation 経路の REST 移行も同枠 |
| S3-5 | 統治系（無承認起票・誤レール・自己改修破壊） | **[自前:権能分離]＋[skill契約]＋一部[未解決]** | hook（fail-open・配布されない・(e) 未確認）を統治の置き場にせず、起票・merge 権能を token scope／branch protection／CODEOWNERS の server 側で fail-closed に（M3）。「loop 本体を loop で改修しない」（M11）は thin-prompt＋PR ゲートで機械化。credential 分離の実現手段は S2-11 と同じ未決 |
| S3-6 | 優先度 label の不在（body 退避） | **[自前]** | R8: priority label を作成し機械可読面に。routines 非依存・即日可能 |
| S3-7 | 教材の情報密度過多（形容詞注文は無効） | **[skill契約]＋[自前:post-check]** | 密度は構造契約（予算・節・禁則・自己点検、R3/#288）で規定し、予算超過・節欠落は post-check で機械 RED に倒す（「プロンプトより機械的保証」rubric に従い検証可能部分はすべて機械側へ） |

## 6. 対応表 — 構造 5 クラス（事故を不可能にする面）

| # | クラス | 種別 | routines 世界での解決（1 行） |
|---|---|---|---|
| C1 | 二重 dispatch／二重生成 | **[自前:dedup]** | §2-1: claim INSERT＝実行権。fs/worktree 導出の全廃。「2 本目が物理的に生成できない」を DBMS が保証 |
| C2 | stale 常駐・stale 定数 | **[platform]＋[自前]** | fresh checkout が self-update を不要化（M7 前半は platform が代替）。thin-prompt 規約＋外部 id の毎パス名前解決は自前 |
| C3 | 成果物・所見の transcript 死蔵 | **[自前:終端契約]** | §2-3。fresh session は死蔵を「次段が読めない」即時故障に変える＝隠れなくなる方向に platform が働くが、保証は自前契約 |
| C4 | 散文契約に依存する I/O | **[自前:構造化 I/O]** | M4: JSON schema＋決定的スクリプト＋決定的配置。routines は解決も悪化もしない（可搬） |
| C5 | silent death | **[platform]＋[自前:watchdog]** | 死因のうち宿主起因は消滅、検知は §2-2 の 3 点突合＋dead-man's switch を原因非依存で常設 |

## 7. 対応表 — 必須要件 M1〜M13

| # | 要件 | 種別 | routines 基盤での充足（1 行） |
|---|---|---|---|
| M1 | 二重実行の物理的不可能化 | **[自前:dedup]** | §2-1（DB 一次 claim・fail-closed・cross-machine 同一制約）。routines はむしろ発火起点が増えるため本部品なしでは運転不可 |
| M2 | silent death 検知の常設 | **[自前:watchdog]** | §2-2 の 5 突合＋毎時発火。platform の完了通知/実行履歴は補助（未確認 (c) 相当の API 仕様依存） |
| M3 | 権能分離 fail-closed | **[未解決（裁定＋仕様確認待ち）]** | 「credential を最初から持たせない」は (d)(g) 未確認。実現案は GitHub App／bot token／書込 proxy だが、routines が本人身元実行なら**現行より後退**。D2(c) 裁定の先行が必要 |
| M4 | I/O の構造化 | **[自前]** | headless 構造化出力＋schema 検証＋決定的スクリプト（§2-3）。Stop hook 不採用と整合。runtime 非依存で可搬 |
| M5 | 終端契約の機械執行＋書込失敗の補償 | **[自前:終端契約＋watchdog]** | §2-3（失敗は ledger 記録）→ §2-2-3（次パス補償）。「非致命 continue」の構造禁止 |
| M6 | spawn の単一モジュール集約 | **[自前]＋[platform]** | session 生成者を dispatcher routine 1 本に限定。routine 一覧（list API）と ledger の突合で「dispatcher 以外が起こした run」を機械検出。動的生成 (b) の仕様確認要 |
| M7 | 版固定＋self-update | **[platform]（前半）＋[自前]（後半）** | fresh checkout が stale を構造排除（self-update 係が不要に）。外部 id ハードコード禁止・毎パス名前解決は自前（§2-2-5） |
| M8 | 環境 repo 正本化＋install self-check＋検収 4 点 | **[platform]＋[自前:検収]** | 環境は cloud spec としてコード化＝宿主依存の恒久化問題が消滅。**cloud 切替そのものに検収 4 点（live 1 パス生存・応答・成果物期限内・outcome=success）を適用**して完了宣言 |
| M9 | 投稿物の post-check | **[自前:post-check]** | §2-3-(iii)。失敗は M5 補償経路へ。routines 非依存 |
| M10 | 状態は導出・二重台帳禁止 | **[自前]** | task 状態は gh 導出を維持。claim/ledger は「実行 telemetry の DB 単独正本」であり同一事実の二重書きではない＝非違反。再実行判定は導出でなく claim 制約（M1）に寄せる |
| M11 | loop 本体を loop で改修しない | **[skill契約→自前化]** | thin-prompt 規約により loop 本体=repo コード＝改修は必ず PR+CI（走行中 routine は次発火から新版）。routine 定義自体の変更だけは手動＋記録の運用規律が残る |
| M12 | 外部契約の contract test | **[自前:watchdog]** | §2-2-5 を毎時実行＋CI にも搭載。「silent 障害→実測→hotfix」の順を逆転 |
| M13 | CI への検証資産全量搭載 | **[自前:CI]** | routines 非依存。PR+CI 単一ゲート（ADR 0026）を維持する以上、基盤選定と独立に必須 |

## 8. 対応表 — 推奨要件 R1〜R8

| # | 要件 | 種別 | routines 基盤での充足（1 行） |
|---|---|---|---|
| R1 | stage ごとの情報注入契約 | **[自前:注入]** | prompt 生成を決定的スクリプトに一元化し plan/diff/照合結果を注入。fresh session 化でコスト効果は現行より大（毎回の再発掘が完全にゼロベースになるため） |
| R2 | 非同期 dispatch（リードタイム保証） | **[platform]（(a)(b) 未確認）＋[自前:SLO 突合]** | 発火=独立 session で同期詰まり消滅。イベント trigger (a) があれば設計値到達、なければ cadence が下限。§2-2-4 で SLO を常時計測 |
| R3 | 教材 2 段化＋密度の構造契約 | **[skill契約]＋[自前:post-check]** | 契約は構造（予算・節・禁則・自己点検）で書き、検証可能部分（予算・節・stub）は機械 RED へ倒す |
| R4 | 決定的配置規則 | **[自前]** | 正解位置等は乱択スクリプトで決定。LLM に任せない |
| R5 | backend 抽象の維持（codex A/B） | **[未解決（縮退）]** | routines の runtime は Claude 固定の公算＝stage 単位 A/B・codex 併用（実測済み資産）は**失われる**。可逆性を残すなら「dispatcher が cloud routine 以外の backend も起こせる」抽象を自前保持（コスト増）。D1 裁定事項 |
| R6 | escalation triage 三分岐 | **[自前:コード可搬]** | classifyEscalation（純関数＋unit test）を session 終端の exit 分類として移植し、結果は label＋ledger へ。platform の失敗通知との統合は (c) 未確認 |
| R7 | plan 契約 6 セクション＋過小 RED | **[自前:データ keep]** | plan-format＋plan-validate を構造化 I/O（M4）の schema として移送。routines 非依存 |
| R8 | 優先度の第一級表現 | **[自前]** | priority label 新設＋dispatcher の claim 順序に反映。routines 非依存 |

## 9. 未解決・悪化・要仕様確認の総括（正直な残余）

1. **[未解決] 承認汚染／権能分離（S2-11・M3・S3-5）**: routines が本人身元で実行されるなら現行の「PdM gh 認証で agent が動く」問題は**構造的に悪化**。GitHub App/bot/proxy の自前策は (d)(g) の仕様確認と D2(c) 裁定が前提。**routines 採用の可否を左右する第一級の未決**。
2. **[未解決→設計で緩和] run 上限 (c)**: 全段 1 session は上限に晒される。§1 案C（stage 境界 graceful 中断→ledger 再開）で吸収するが、上限値・課金モデルが未確認のため IMPLEMENT 長尺 task の成立性は未検証。
3. **[未解決→cadence で妥協] 多段遷移 trigger（(a)(b) 未確認）**: イベント trigger も動的 routine 生成も未確認のため、基線は cron polling＝中断・rework 周回ごと最大 1 cadence の遅延。実測 p95 52 分（S3-1）よりは改善見込みだが設計値保証は (a) 次第。
4. **[縮退] backend 抽象（R5）**: codex 併用・stage 単位 A/B の実測資産が失われる。D1 と一体で裁定。
5. **[platform で解決だが影響あり] worktree 相当の隔離**: session ごと独立 sandbox＋main への書込は PR 経由のみ＝単一 writer は構造保証（現行 worktree 規律の後継）。ただし「監査役が main を直接触る」運用面が消えるため outer の作業様式が変わる。
6. **[未確認] 観測接続（D4）**: cloud session transcript の export (f) が無ければ lathe ingest（providers/claude.ts）が接続不能＝観測プラットフォームとしての lathe の根幹に関わる。**routines 採用判断の前に (f) の existence proof が必須**。
7. **[残余リスク] watchdog と dispatcher の同時死**: 相互 dead-man's switch は片方生存が前提。両方同時死は platform の実行履歴/通知 API（未確認）か第三の外部監視（例: 期待 heartbeat の外形監視）が要る。
8. **[運用規律として残る] routine 定義そのものの変更管理（M11 の残り）**: thin-prompt 化で本体は PR ゲート下に入るが、routine の作成・削除・cron 変更だけは platform UI/API 操作＝ゲート外。変更記録の規律（もしくは (b) があれば定義の repo 正本化＋同期スクリプト）が必要。

## 10. 種別集計（サニティチェック）

- [platform] 単独または主: S1-1(半)・S2-1(半)・S2-3(半)・S2-10・C2(半)・C5(半)・M7(半)・M8・隔離（§9-5）＝**E 系環境差・stale 常駐・隔離は構造消滅**という見立ては成立。
- [自前:dedup]: S1-2・S2-3(半)・S2-4・C1・M1。**基盤採用と同時に最初に建てる部品**。
- [自前:watchdog]: S1-1(半)・S1-3・S2-2・C5(半)・M2・M5(半)・M12・R2(半)。
- [自前その他]（終端契約/post-check/構造化 I/O/注入/CI）: S1-3(半)・S1-4・S2-5・S2-7〜S2-9・S2-12・S3-2〜S3-4・S3-6・C3・C4・M4・M5(半)・M9・M10・M13・R1・R4・R6〜R8。
- [skill契約]（毎回「機械化可能か」を自問した上で残るもの）: thin-prompt 規約（S2-1）・教材構造契約の非検証部分（S3-7/R3）・M11 の運用残余のみ。**それ以外はすべて機械側に倒した**。
- [未解決/縮退/未確認]: M3（承認・権能分離＝最重大）・R5（backend 縮退）・run 上限・trigger 方式・観測 export・watchdog 同時死・routine 定義の変更管理。
