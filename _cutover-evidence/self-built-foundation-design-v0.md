# 自作基盤（最小カーネル）設計 v0

- 作成: 2026-07-08／read-only（repo・issue・PR への書き込みなし）
- 入力: `code-red-charter-material.md`（S/C/M/R・keep-drop・D1〜D4）・`cr-runtime-requirements.md`（runtime 要件の実測導出）・現行実装 `/Users/cherie/LLMWiki/projects/lathe/scripts/*`（教訓の持ち込み元。本書のために行数・テスト数を機械再計測）
- 記法: 事実（一次証拠・実測に接地）／設計提案（PdM 裁定前）／**未確認**を峻別。入力間の矛盾は §7 に丸めず残す。
- 対案: `routines-foundation-design-v0.md`（同 scratchpad）。章立て・解像度を揃え、両案を同じ物差しで比較できる形にする。

---

## 1. TL;DR（10 行）

1. **自作 = 保証の最小核 5 部品だけを自前で建てる**: ①dispatcher（DB 一意性 claim・非同期 spawn）②spawn 単一モジュール（runtime = Claude Code headless の**ローカル実行**）③watchdog（3 点突合・原因非依存）④終端 proxy（gh 書込一元化＋補償＝権能分離 fail-closed の実体）⑤版固定 self-update。agent loop 本体（tool dispatch・context 管理）は作らない＝CC headless を使う。
2. **最大の優位 = transcript 主権**: ローカル実行なので local JSONL が 100% 残り、lathe ingest（providers/claude.ts・codex.ts）は**変更ゼロ・観測無劣化**。routines 案の判定 B（劣化観測）・D4 裁定・OTel 未確認群がこの案では**発生しない**。
3. **第二の優位 = M3 権能分離が構造で建つ**: 書込 credential は proxy プロセスだけが持ち（OS user 分離＋systemd credential）、inner agent は gh token を**最初から持たない**。routines 案で「採用可否を左右する最重大未解決」だった点が、ここでは実現可能な設計になる（残余 = OS user 分離の徹底、§3-M3・§6-1）。
4. **正直な代償 = 常駐が戻ってくる**: 実行マシン（case）・電源・環境差 E クラス（cgroup 回収・OAuth 欠落・pnpm 欠品 = 今日の事故 E1〜E3）の管理は**全部自分持ち**。routines 案で [platform] が消すはずだった分が M2/M8 の恒久自前部品として残る（§3-M8）。
5. **常駐 daemon は置かない**: dispatcher/watchdog は systemd timer 発火の oneshot＝毎パス fresh 起動・パス冒頭 ff-only self-update→re-exec。stale 常駐（S2-1）を「常駐しない」ことで構造排除。マシンごと死ぬ最終段は**外部 heartbeat 監視**（GitHub Actions cron の突合・§4.6）で覆う。
6. M1〜M13・R1〜R8 は §3 で全網羅。[platform] 枠は存在せず、代わりに **[構造]**（DB unique・credential 不在・oneshot＝コードの正しさに依存しない保証）と **[自前:コード]** を峻別する。**[未解決]** は M3 の OS 分離徹底・DB 置き場の 2 点。
7. **R5（backend 抽象・codex A/B）と M11（改修ゲート）は routines 案より優位**: backends.mjs は keep 資産としてほぼ転用、kernel 改修はすべて repo コード＝PR+CI ゲート内（routines 案の「routine 定義だけゲート外」問題が消える）。
8. **再構築規模（実測接地）**: 現行 orchestrator 系 1,424 行（申告「1,400 行」と整合）・driver 系 3,387 行・loop 系実装計 ~6.2k 行・unit 895 pass（申告「892」は時点差、§7-1）。カーネル v0 は keep 転用込みで**新規 2.5〜3.5k 行＋テスト同等以上**と見積もる（§4.7。過大にも過小にも盛らない）。
9. 導入は PoC 先行: **claims table＋dispatcher oneshot＋driver（案C stage-ledger）＋envelope で実 issue 1 件を plan→merge まで一巡→切替検収 4 点の機械照合**（§5 Step 1）。
10. PdM 裁定 8 点を優先順で §6（筆頭は M3 実現手段と「保守は監査役工数」の受容）。矛盾・未確認 8 点は §7。

---

## 2. 全体構成図

### 2.1 基線構成（case サーバー単独実行・ローカル Postgres）

```
                ┌────────────── GitHub（task/承認/着地の正本）───────────────┐
                │ issue = task（ADR 0031）  label: task / needs-plan / gov:* / run:*   │
                │ PR + CI = 単一着地ゲート（ADR 0026・検証資産全量 M13）                │
                │ ＋ Actions cron = 外部 heartbeat 監視（マシン死の最終段検知・§4.6）   │
                └───▲──────────────▲──────────────────▲───┘
         導出(read only)│    書込は proxy のみ（bot token）│        PR 作成 / auto-merge arm│
   ┌── case サーバー（systemd）────────────────────────────────────┐
   │  timer 毎N分 ─► dispatcher（oneshot・fresh）        ┌─────────────────┐ │
   │    パス冒頭: ff-only self-update → re-exec（M7）    │ posting proxy（別 OS user・  │ │
   │    gh 導出 → trigger 述語 → claim INSERT           │ 唯一の gh 書込 credential 保持│ │
   │    → spawn 指令を enqueue して即 exit（R2）         │ 決定的 render＋post-check＋台帳）│ │
   │         │claim INSERT=実行権                        └───▲─────────────┘ │
   │  ┌──▼──────────────────────────────┐  │envelope（unix socket/DB 経由）│
   │  │ Postgres（claims / stage-ledger / posting台帳 /       │  │                          │
   │  │ heartbeat。lathe DB 同居か専用かは §6-2 裁定）        │  │                          │
   │  └──┬────────────────────▲──────┘  │                          │
   │        │spawn 単一モジュール（backend 抽象 keep）│watchdog（timer 毎時＋軽量毎パス）│
   │  ┌──▼──────────────────┐   │ 3点突合・posting補償・actor監査・    │
   │  │ run プロセス（detached transient unit・ │   │ stale/契約check・cross-machine 検査 │
   │  │ claude -p headless／codex exec・        │   │                                      │
   │  │ **gh credential なし**・worktree 隔離・  │───┘ 最終メッセージ = envelope JSON ──┘
   │  │ 案C: stage-ledger の未完 stage から進む） │
   │  └──┬──────────────────┘
   │        │ local JSONL transcript（~/.claude/projects/**）＝ 100% 残る
   └────┼──────────────────────────────────────────┘
   ┌────▼─────────────────────────┐
   │ lathe ingest（providers/claude.ts・codex.ts **変更ゼロ**）│ ＝観測接続（無劣化）
   └──────────────────────────────┘
```

要点:
- 多段ライフサイクル（TASK_PLAN→PLAN_REVIEW→IMPLEMENT→LAND）は routines 案と同じ**案C**: 1 発火 = 進めるだけ進む・stage 境界を ledger に冪等記録・run 上限接近や CI 待ちで graceful 終了→次発火が ledger から再開。`--resume`（S2-3 の事故源・実測でも全 call site 未使用のデッドコード）は廃止。
- dispatcher は**常駐しない**（oneshot）。spawn は `systemd-run --user` の transient unit（detached）＝パス内同期実行（S3-1、p95 52 分）を構造で解消。
- 権能の物理配置: **run プロセスの環境に gh token を入れない**（env strip＋gh config 隔離）。書込はすべて envelope→proxy。proxy は別 OS user＋systemd `LoadCredential` で token を保持し、agent user からは読めない（**未確認**: この構成の実測は Step 0、§7-6）。

### 2.2 縮退・変形

- **cross-machine（Mac 併用）**: claims DB を単一のネットワーク到達可能な Postgres に置けば同一制約で排他される（M1 は DB の単一性にのみ依存）。ただし基線は **case 単独＋Mac launchd 完全退役**を推す（管理面の縮小。#237/#247 の分掌解消込み・§5 Step 6）。
- **runtime 変形**: spawn 単一モジュールは backend 抽象（ADR 0014・inner-loop-backends.mjs keep）を維持するため、CC→codex→pi→API 直叩きへの段階移行が**この基盤を壊さずに**できる。D1 裁定が「併用」でも「自作 loop へ将来移行」でも、カーネル 5 部品は不変。

---

## 3. 問題→解決の対応表（M1〜M13・R1〜R8 全網羅）

種別タグ: **[構造]**=DB 制約・credential 不在・oneshot 等、コードの正しさに依存しない保証／**[自前:コード]**=自前部品のコードが正しく動くことに依存／**[skill契約]**=散文契約として残す／**[運用残余]**=規律で担保／**[未解決]**=裁定・実測待ち。

### 3.1 必須 M1〜M13

| # | 要件 | 種別 | 自作カーネルでの充足（1 行） |
|---|---|---|---|
| M1 | 二重実行の物理的不可能化 | **[構造]** | claim `INSERT … ON CONFLICT DO NOTHING` = 実行権（Postgres unique・fail-closed）。fs マーカー・worktree 導出は全廃。cross-machine も同一 DB 制約下（DB 単一化が前提・§6-2）。DB 不達時は実行しない |
| M2 | silent death 検知の常設 | **[自前:コード]＋[構造(外部)]** | watchdog 3 点突合（claim 行×heartbeat×outcome）＋dispatcher⇄watchdog 相互 dead-man's switch。**マシンごと死ぬ最終段は自前 watchdog では原理的に検知不能**→GitHub Actions cron の外部 heartbeat 突合で覆う（§4.6。Actions schedule の遅延は未実測・§7-7） |
| M3 | 権能分離 fail-closed | **[構造]＋[未解決(徹底度)]** | inner は gh credential を**最初から持たない**（env strip＋config 隔離）。書込は proxy のみ（GitHub App or machine user token・別 OS user・LoadCredential）。hook で「聞く」機構は全廃。**残余**: 同一 OS user 運用だと agent の Bash が token に到達しうる→OS user 分離の徹底が条件（Step 0 実測・§6-1） |
| M4 | I/O の構造化 | **[自前:コード]** | 最終メッセージ = envelope JSON（schema 固定・§4.4）＋決定的スクリプト。Stop hook 不採用（#302 二重課金 drop と整合）。unparsable retry backstop は現行 `runStageWithUnparsableRetry` を keep 転用。**未確認**: CC headless の schema 強制出力可否（あれば retry 不要化） |
| M5 | 終端契約＋書込失敗の補償 | **[自前:コード]** | stage 完了 =「envelope 受理＋posting 台帳 confirmed」まで。失敗は台帳 status=failed＋エラー全文→次パス watchdog が補償（「非致命 continue」= S1-3 #229 の構造禁止） |
| M6 | spawn の単一モジュール集約 | **[自前:コード]＋[構造(検査)]** | spawn は 1 モジュール（§4.2）のみ。CI 機械検査「`spawnSync.*claude\|codex` の出現 = 当該モジュール 1 箇所」を常設（現行 4 箇所分散・pin 貼り忘れ 2 箇所の再発防止。harness-separation.test の後継） |
| M7 | 版固定＋self-update | **[構造]** | 常駐なし（oneshot）＝stale 常駐（S2-1、5 commit 遅れ走行）が発生しえない。パス冒頭 ff-only fetch→re-exec で毎パス最新 main。外部 id（盤面 option id 等）は毎パス名前解決（A2/Q4 封じ） |
| M8 | 環境 repo 正本化＋検収 4 点 | **[自前:恒久負担]** | **routines 案で platform が消した分がここに全部残る**: systemd unit（KillMode 等・E1）・認証（E2）・依存（pnpm・E3）を ops/ に repo 正本化＋install self-check＋切替検収 4 点の機械照合。**新しい導入先では毎回この負担を払う**（正直に明記） |
| M9 | 投稿物の post-check | **[自前:コード]** | proxy が投稿直後に GET 読み戻し: 実在・本文長≥契約 min・未展開 placeholder 不在・対象 id 一致・必須節存在（S1-4 stub #292/#295 封じ・§4.5） |
| M10 | 状態は導出・二重台帳禁止 | **[自前:コード]** | task 状態は gh 導出を維持（orchestrator-derive.mjs はコード参考 keep）。claims/ledger は「実行 telemetry の DB 単独正本」＝同一事実の二重書きではない。manifest ファイル層（.lathe/runs/）は drop・最初から DB 一次 |
| M11 | loop 本体を loop で改修しない | **[構造]** | カーネルは**全部 repo コード**＝改修は必ず PR+CI（ADR 0036 の harness-release 別編成 keep）。routines 案の「routine 定義の作成・cron 変更だけゲート外」問題が**存在しない**（systemd unit も ops/ 正本＝PR 経由。install 実行だけが運用残余） |
| M12 | 外部契約の contract test | **[自前:コード]** | watchdog 毎時＋CI。第 1 号 = timeline `labeled` イベントの actor 取得（承認検証の前提・**未確認**）。gh 癖台帳 Q1〜Q7 を test 化して持ち込む |
| M13 | CI への検証資産全量搭載 | **[自前:コード]** | 基盤選定と独立に必須（#279「ザル」の解消）。カーネル自身のテストも全量 CI へ |

### 3.2 推奨 R1〜R8

| # | 要件 | 種別 | 充足（1 行） |
|---|---|---|---|
| R1 | stage ごとの情報注入契約 | **[自前:コード]** | prompt 生成を決定的スクリプトに一元化・注入必須リスト欠落時は spawn 拒否（fail-closed）。案C の fresh 再開でも ledger から前 stage 成果物を注入（#301 の bash 37% 探索の解消） |
| R2 | 非同期 dispatch | **[構造]** | dispatcher は enqueue して即 exit・run は detached transient unit＝パス間隔 = timer 設定値で**設計値保証**（routines 案の「(a) イベント trigger 未確認」依存がない。cadence 下限も自分で決められる） |
| R3 | 教材 2 段化＋密度の構造契約 | **[skill契約]＋[自前:post-check]** | 予算・必須節・禁則・self_check は contracts データ。検証可能部分は機械 RED（routines 案 §4 と共通） |
| R4 | 決定的配置規則 | **[自前:コード]** | 正解位置等は proxy の render 時に乱択スクリプトで確定（F3・b 66% 偏在の封じ。routines 案と同一） |
| R5 | backend 抽象の維持 | **[構造(keep)]** | inner-loop-backends.mjs（claude/codex 混在稼働・cost 自前換算実測済み）を**ほぼ転用**。codex 併用・stage 単位 A/B の実測資産を**失わない**（routines 案の縮退が発生しない。D1 の可逆性をカーネル側で担保） |
| R6 | escalation triage 三分岐 | **[自前:コード可搬]** | `classifyEscalation`（純関数＋unit test）を keep 転用。結果は label＋ledger |
| R7 | plan 契約 6 セクション＋過小 RED | **[自前:データ keep]** | `contracts/plan.schema.json` へ移送（inner-loop-plan-validate.mjs 208 行はコード参考） |
| R8 | 優先度の第一級表現 | **[自前:コード]** | `gov:p1/p2/p3` label 新設＋dispatcher の claim 順序に反映（routines 案と同一・即日可能） |

集計（正直な帳尻）: routines 案で [platform] だった E 系環境差・stale 常駐・隔離のうち、**stale 常駐は oneshot で構造解決・環境差 E クラスは自前恒久負担として残る・隔離は worktree（現行 keep）で従来通り**。dedup・watchdog・終端契約・post-check・構造化 I/O は両案とも自前＝差がつかない。差がつくのは **観測（無劣化 vs 劣化 B）・M3（構造で建つ vs 最重大未解決）・M11（全ゲート内 vs 定義ゲート外）・R5（維持 vs 縮退）— いずれも自作優位** と、**M2 最終段・M8・保守工数 — いずれも自作の負担**。

---

## 4. 部品定義 v0（実物）

### 4.0 前提モデル（5 点）

1. **loop 定義 = 版固定されたデータ**: `contracts/loops/<name>.json` = `{name, version, trigger, injection, allowlist, skills, envelope_schema}`。trigger 述語・9 loop の一覧・skill 構成（keep 9＋新設 plan/plan-review・凍結 lathe-ui）・label 語彙（`gov:*`/`run:*`・進行状態 label は作らない）は **routines 案 §4.1/§4.2/§4.4 と基盤非依存に共通**＝本書では差分のみ収載（重複させない。共通部の正本は routines 案 §4 とする）。
2. **dispatcher は oneshot**（常駐なし）。毎パス: self-update→gh 導出（M10）→trigger 述語→claim INSERT（M1）→spawn enqueue→exit。
3. **inner 実行体は GitHub credential を持たない**（M3。実現 = env strip＋OS user 分離、§4.2/§4.5）。gh 書込は全て proxy が envelope から決定的に行う。
4. **入力は注入・出力は envelope**（M4・R1）。注入 1 つでも取得失敗なら spawn しない（fail-closed）。
5. permission は **allow 列挙＋deny デフォルト・`ask` 不使用**（headless の ask=自動拒否という対話前提の名残を設計から排除）。allowlist は CC の `--allowedTools` を spawn モジュールが明示注入（settings ファイル暗黙 load 禁止＝S2-6 封じ。--settings pin 方式は捨て、**settings に依存しない**）。

### 4.1 部品① dispatcher（目標 ~300–400 行・現行 orchestrator 系 1,424 行の後継）

- 発火: systemd timer 毎 N 分（v0 = 5 分・再測定対象）。oneshot・fresh プロセス。
- パス手順（決定的・LLM なし）: (1) `git fetch && git merge --ff-only` → 自版と origin/main の sha 照合 → 不一致なら re-exec（M7）　(2) gh から状態導出（derive は現行 orchestrator-derive.mjs 279 行＋test をコード参考 keep）　(3) `contracts/loops/*.json` の trigger 述語を評価　(4) 候補ごとに `INSERT INTO claims … ON CONFLICT DO NOTHING` — **INSERT 成功 = 実行権**（M1）　(5) 成功分を spawn モジュール経由で detached 起動（R2）　(6) 自 heartbeat を DB に記録して exit。
- claims DDL v0: `claims(loop_name, subject_key /* issue#×stage-class */, claimed_at, run_id, machine, PRIMARY KEY(loop_name, subject_key))`＋`runs(run_id, …, heartbeat_at, outcome)`＋`stage_ledger(run_id, stage, status, artifact_ref, UNIQUE(run_id, stage))`＋`posting_ledger(intent_sha256 UNIQUE, kind, target, body_sha256, status, error)`。
- lease: claim は TTL 付き。期限切れ×outcome なし = watchdog が dead 判定して補償（claim の自動解放はしない・人間可視の escalation 経由）。

### 4.2 部品② spawn 単一モジュール（目標 ~300–450 行・backends.mjs 440 行を基に改造）

- **系内で agent プロセスを生成できる唯一の場所**（M6）。CI 検査: spawn 呼び出しの grep 出現 = 本モジュール 1 箇所のみ。
- runtime: `claude -p --output-format json` のローカル実行が基線（**transcript 主権**: local JSONL→lathe ingest 無劣化）。backend 抽象（ADR 0014）を維持し `codex exec --json` も同 I/F（R5）。
- 環境の明示構築: env は **allowlist で組み立てる**（現 env の継承 strip）— `GH_TOKEN`/`GITHUB_TOKEN` 不注入・`HOME`/`XDG_CONFIG_HOME` を run 専用に向け gh config を隔離。allowedTools は loop 定義 JSON から明示注入。worktree 隔離（keep 原則）。
- 注入契約（R1）: `contracts/injection/<loop>.json` の必須リストを解決して prompt を決定的に生成。1 つでも欠落なら spawn せず escalation(context)。
- cost: envelope `total_cost_usd`（claude）／token×pricing.json 換算（codex・実装済み keep）を runs に記録（G9 異常検知の接続点）。

### 4.3 部品③ driver（run 内 stage 進行・目標 ~800–1,200 行・現行 inner-loop 系 3,387 行の後継）

- run プロセスの中で案C を駆動する決定的スクリプト: stage_ledger の未完 stage から順に spawn モジュールで stage 実行→envelope 受理→ledger 記録→次 stage。run 上限接近・CI 待ちで graceful 終了（次発火が再開）。
- keep 転用: `classifyEscalation`（純関数・R6）・`runStageWithUnparsableRetry`（bounded retry 2 回・M4 backstop）・plan validate（R7）。
- drop: 散文 prompt テンプレ（inner-loop-prompts.mjs 417 行→contracts データ化）・resume 機構（S2-3）・manifest ファイル層・driver 内 merge ゲート。
- 縮小根拠: prompts 417＋projects 263＋manifest/resume 分の消滅＋envelope 化による分岐削減。**過小に見せない注記**: rework（CHANGES 差し戻し・non-FF 対策 S2-4）と land の gh 癖対処（Q1〜Q3・A3）は複雑さの本体でありなくならない→800 行を下回る見積りはしない。

### 4.4 出力契約（envelope・3 層機械保証 — routines 案 §4.3 と同一構造）

1. **生成時**: 最終メッセージ = envelope JSON 1 個（`{loop, issue, run_id（注入値エコーバック）, verdict(enum), summary, artifacts[]{kind, body=全文}, escalate{class, reason}}`）。`@file`・パス参照は schema で禁止（P1/F2 封じ）。UNPARSABLE→エラー全文＋schema 注入で bounded retry 2 回→超過は decision escalation。
2. **配信時**: proxy が決定的 render（配置乱択 R4）→台帳 intent（sha256）→gh REST 投稿（GraphQL label 系は Q5 回避）→**投稿直後 post-check**→confirmed。
3. **事後**: watchdog が台帳⇄gh を突合し missing 再投稿・stub 補修・label 補正。3 層のどれが落ちても「正本に成果物がある」へ収束。

### 4.5 部品④ 終端 proxy（目標 ~400–600 行・新規）

- **系内で唯一 gh 書込 credential を持つプロセス**。別 OS user で常駐 or socket-activated・token は systemd `LoadCredential`（agent user から読めない）。credential 種別（GitHub App / machine user PAT）は §6-1 裁定。
- 入力: envelope（DB 経由 or unix socket）。処理: schema validate→テンプレート**関数**で render→posting_ledger に intent→REST 投稿→post-check 5 項目→confirmed／failed（エラー全文記録・握りつぶし禁止 = S1-3 封じ）。
- 冪等: intent_sha256 UNIQUE＝同一投稿の二重実行が DB 制約で不可能（Discussion #294/#295 の 8 秒差二重投函クラスを構造で封じる）。
- 承認の効力判定（M3 の 3 層・routines 案と共通）: (1) credential 分離（本部品が実体） (2) `gov:*` は timeline `labeled` actor ∈ 人間 allowlist で効力判定（**未確認**・M12 第 1 号） (3) watchdog が allowlist 外 `gov:*` を剥がす。

### 4.6 部品③' watchdog＋外部 heartbeat（目標 ~300–500 行・新規）

- systemd timer 毎時（＋dispatcher パス同居の軽量版）。LLM なし・決定的。検査項目は `contracts/watchdog-checks.json`（routines 案 §4.1 の 1〜8 と同一: 3 点突合／posting 補償／escalation 終端補償／gov:* actor 監査／run:* 投影整合／stale 検査／cross-machine 二重検査／検収 4 点）＋**9. ingest 突合**（runs ⇄ lathe sessions の到着確認。ローカルなので OTel 依存なし・providers そのまま）。
- **最終段（マシン死・電源断・timer 自体の停止）**: dispatcher/watchdog が毎パス gh 側に heartbeat 痕跡（例: 専用 issue へのコメント更新 or gist）を残し、**GitHub Actions scheduled workflow** が「最終 heartbeat が閾値超過なら issue 起票＋通知」を突合。自前 watchdog では原理的に検知できない死（S1-1 の一般化）を系外から覆う。**未確認**: Actions schedule の実遅延（公称 best-effort・§7-7）。
- dead-man's switch: dispatcher⇄watchdog が相互の最終実行時刻を検査。

### 4.7 再構築規模（実測接地・2026-07-08 機械計測）

| 現行（実測） | 行数 | 新カーネル | 見積り |
|---|---|---|---|
| orchestrator 系（orchestrator/derive/classify/explain/logs） | 1,424 | ①dispatcher | 300–400（derive はコード参考 keep） |
| driver 系（inner-loop* 12 ファイル） | 3,387 | ③driver | 800–1,200（keep 転用: triage/validate/retry） |
| backends（spawn） | 440 | ②spawn 単一モジュール | 300–450（改造転用） |
| （該当なし・新規） | — | ④proxy＋post-check＋台帳 | 400–600 |
| （該当なし・新規） | — | ③'watchdog＋外部 heartbeat | 300–500＋Actions yml |
| dispatch-runner/case-dispatch/review-engine/meta-loop/preflight | 1,375 | drop（review は loop 定義へ・meta-loop 未通電） | 0 |
| **loop 系実装 計** | **~6.2k** | **カーネル計** | **2.5–3.5k 行（新規＋改造）** |
| テスト（scripts *.test.mjs） | 6,183 行・**unit 895 pass** | テスト | 同等以上を必須（M13。特に claim 競合・補償・env strip の意地悪系を追加） |

- 工数の物差し: harness-release bootstrap の実績（15 スライス 4 波 8 PR 着地）が同規模先例。**保守は監査役の工数**であり、外部仕様（CC の JSON 出力・gh API）追随・E クラス対応・Postgres 運用が恒久に乗る（§6-3 で受容を裁定）。

---

## 5. 段階導入計画

各 Step は「先へ進む条件」を機械照合で判定（記憶・印象で完了宣言しない）。

| Step | 内容 | 先へ進む条件 |
|---|---|---|
| **0. 実測 spike**（1〜2 日） | (i) OS user 分離＋LoadCredential で「agent user が repo を書けて token を読めない」existence proof（M3 の要）　(ii) GitHub App or machine user の作成と bot token の scope 確認　(iii) CC headless の schema 強制出力可否　(iv) claims DB の置き場決定（lathe Postgres 55433 同居 or 専用）と到達確認　(v) Actions schedule 遅延の実測 | (i) が不成立なら M3 は「同一 user＋運用規律」へ後退＝**採用可否の裁定材料として §6-1 へ**。成立なら Step 1 |
| **1. PoC（最小 1 loop で issue 1 件を一巡）** | claims table＋dispatcher oneshot（timer 5 分）＋driver（案C 最小）＋envelope（plan/implement/verify 最小 schema）＋proxy は**暫定で同一 user・手動承認**（gov:approve 手貼り）。trivial 実 issue 1 件を plan→PR→merge まで一巡。ingest 到着（lathe sessions）も同時確認 | **切替検収 4 点の機械照合 GREEN**: (a) heartbeat 1 パス生存 (b) runtime 応答 (c) 成果物の期限内出現 (d) outcome=success。RED は result-classification で類別して戻る |
| **2. dedup＋watchdog 本設**（M1/M2） | claim 排他の全面化（fs 導出全廃）・watchdog 検査 1〜5＋9 常設・dead-man's switch・**外部 heartbeat（Actions cron）**接続 | 並列 2 issue で二重 dispatch 不発を機械確認（意図的競合テスト）・模擬 dead run と「timer 停止」の両方が検知される |
| **3. posting proxy＋post-check＋台帳**（M4/M5/M9 全面） | 全書込を proxy 経由に・explain 2 段搭載（stub 事故 S1-4 封じの実証面）・intent_sha256 冪等 | post-check 5 項目が CI＋実投稿で GREEN・模擬書込失敗が台帳→次パス補償で回収・同一 intent の二重投稿が DB 制約で拒否される |
| **4. 権能分離本設**（M3。**§6-1 裁定後**） | proxy を別 OS user＋LoadCredential へ・env strip の CI 検査・actor 検証・contract test 第 1 号（timeline actor）・allowlist 外 gov:* 剥がし | 「run プロセス内から gh 書込を試みて物理的に失敗する」＋「bot が gov:approve を貼っても implement が発火しない」を実測 |
| **5. 全 loop 展開＋CI 全量** | 9 loop 展開・M13 全量搭載・M12 毎時 contract test・E クラス対策（KillMode/認証/pnpm）の ops/ 正本化＋install self-check（M8） | 各 loop の envelope validate 率・escalation 三分岐の実弾動作・CI GREEN・新 clone への install self-check GREEN |
| **6. 旧系退役** | 現行 orchestrator/driver（launchd・case systemd 旧 unit）退役・Mac launchd 完全退役 | **cross-machine 排他が DB claim に入った後・検収 4 点 GREEN 後のみ**。#237/#247 の分掌解消込み・「退役完了」を機械照合なしに宣言しない |

数値パラメータ（timer 5 分・retry 2 回・差し戻し 2 周・lease TTL 等）は現行 loops.md 値の継承＝**新基盤で再測定対象**。

---

## 6. PdM 裁定が要る点（優先順）

1. **【採用可否を左右】M3 実現手段と徹底度**: (a) credential 種別 — GitHub App（installation token・権限最小・要 App 管理）か machine user PAT（簡便・アカウント 1 個増）か。(b) **OS user 分離を必須とするか** — 分離なし（同一 user）だと agent の Bash が token に到達しうる＝「hook で聞く」より強いが fail-closed とは言い切れない。Step 0 (i) の existence proof とセットで裁定。routines 案では platform 仕様待ちだった点が、本案では**自分の裁定だけで決まる**。
2. **DB・実行マシンの置き場**: claims/ledger DB を lathe Postgres（55433）同居か専用か（D3/D4 連動: 「観測が正本」方向なら同居が整合的、分離境界を立てるなら専用）。実行は case 単独か Mac 併用継続か（基線は case 単独＋Mac 完全退役）。
3. **保守負担の受容（自作の本質的代償）**: カーネル 2.5–3.5k 行＋テストの新規構築（bootstrap 15 スライス級）と、恒久の E クラス管理・外部仕様追随・Postgres 運用が**監査役の工数**に乗る。routines 案（保守を platform に外出し・代わりに観測劣化と M3 未解決）との比較裁定 = **D1 の実体**。コスト削減は選定理由にしない（コスト主因は turn 数・runtime 非依存）。
4. **D3 — 基盤の置き場**: lathe repo 内（ADR 0038 packages 構成）か別 repo か。「プロジェクト外のハーネスは必要ない」裁定（2026-07-08）との整合、keep 資産（rubric 48 本・plan 契約・ADR 群）の移送先も連動。
5. **D2(a)(b) — 承認面の正**: `gov:approve` label（actor 検証つき）か Projects Ready 列継続（ADR 0035）か。trigger 述語は adapter 差し替えで両対応（routines 案と共通の裁定）。
6. **Step 0/1 の実施承認と PoC 対象 issue の指名**（trivial class 1 件）。
7. **label 語彙 v0 と数値パラメータの暫定承認**（routines 案 §4.4 と共通・`gov:`/`run:` 新設・timer/retry 値は再測定前提の暫定）。
8. **外部 heartbeat の経路承認**: GitHub Actions cron（public repo・無料枠）を系外監視に使うか、代替（別マシン・外部監視サービス）か。「GitHub への依存度」（D2）の一部として裁定。

---

## 7. 入力間の矛盾・未確認（丸めずに残す）

1. **「1,400 行 892 テスト」の照合**: 本書の機械再計測（2026-07-08）では orchestrator 系 = **1,424 行**（orchestrator/derive/classify/explain/logs 合算）＝「1,400 行」と整合、unit test は **895 pass**（`pnpm test` 実行結果）＝「892」は近時点の計数差とみられる（出典時点は未確認）。ただし**「1,400 行」は orchestrator 系のみ**であり、driver 系 3,387 行・backends 440 行を含む loop 系実装は ~6.2k 行。再構築規模の見積り（§4.7）は 6.2k 行側を母数にした——「1,400 行を作り直すだけ」という読みは**過小**なので採らない。
2. **M3 の残余**: 本書は「credential 不在 = 構造」と分類したが、これは **OS user 分離＋LoadCredential が成立する場合のみ**。同一 user 運用に後退すると「token がファイルシステム上に在るが渡さない」＝準構造に格下げ。charter M3 の「物理的にできない」を満たすかは Step 0 (i) の実測前に確定しない。
3. **CC headless の schema 強制出力可否**: routines 案 §4.3 と同一の未確認。不成立でも bounded retry backstop（実装済み keep）で運用可能だが、M4 の保証強度が 1 段落ちる。
4. **課金経路**: ローカル headless の $150.9/66 run 実測は継続する前提だが、**API key か Max サブスク充当かは未照合**（cr-runtime §5 と同一）。自作案は routines 案と違い course 単価が変わらない（同じ CC headless）ため D1 材料としては中立。
5. **timeline `labeled` actor の網羅性**: 承認効力判定の前提・未確認（M12 contract test 第 1 号。routines 案と共通）。
6. **OS user 分離×worktree の権限設計**: agent user が repo worktree を書けて proxy credential を読めない構成は systemd DynamicUser/LoadCredential で可能なはず（設計提案）だが、**existence proof 未取得**（Step 0 (i)）。git worktree の所有権・pnpm store の共有など運用詳細も未検証。
7. **GitHub Actions schedule の遅延**: 公称 best-effort（混雑時に数十分遅延の報告が一般に知られる）＝外部 heartbeat の検知 SLO に直結するが**本 repo での実測なし**。Step 0 (v) で実測し、SLO に満たなければ代替経路（§6-8）へ。
8. **元資料から継承する矛盾**: charter §5 D1 の自作評価「統制◎・書式◎・保守△」に対し、本書は保守△の中身を M8 恒久負担＋外部仕様追随＋Postgres 運用として**定量側に展開**した（△の重さは §6-3 の裁定対象・丸めない）／launchd 退役の完了範囲（#237 OPEN・07-08 併存実測）は M1 cross-machine＋Step 6 に編入（routines 案と同一の扱い）／PdM 申告「CC は向いていない」vs 実測「動かないは不成立」——本案は CC を**headless runtime としてだけ**使い統治を全部系外（DB・proxy・oneshot）に出す構成であり、申告が支持された 3 点（settings 依存 fail-open・Stop hook・ask 意味論）を**いずれも使わない**（両論への本案なりの応答として記す）。
