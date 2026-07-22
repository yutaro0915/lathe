# Temporal ベース基盤 設計 v0

- 作成: 2026-07-08／read-only（repo・issue・PR への書き込みなし）
- 入力: `foundation-decision-material.md`（M1〜M13・R1〜R8・両 critique）・`self-built-foundation-design-v0.md`・`routines-foundation-design-v0.md`（同 scratchpad）・ADR 0036・外部一次情報（各所に URL）
- 記法: **事実**（一次情報 URL 付き）／**設計提案**（PdM 裁定前）／**未確認** を峻別。disciplined-research 準拠（existence proof → 枠組みの順で調査済み）。
- 位置づけ: 既存 2 案（routines cloud／自作カーネル）に対する**第三案**。「保証を自前コードで書く（自作）か、platform 仕様に預ける（routines）か」の二分に対し、**保証を self-host 可能な OSS 実行エンジンに預け、実行・観測はローカルに残す**中間解。

---

## 0. TL;DR（10 行）

1. **構成 = workflow per task**: issue #N を workflow ID `task-N` の 1 Temporal workflow にし、plan→plan 投稿→承認待ち→implement→verify→land を activity 列として駆動する。
2. **M1 が platform の hard guarantee になる**: 同一 workflow ID の open execution は同時に 1 つだけ（原子的チェック・公式明記）。claims テーブル自前実装が丸ごと消える。
3. **M2 の大半が内蔵**: activity heartbeat＋start-to-close timeout＋retry policy が「worker 死」「run 死」を platform 側で検知・再試行。ただし**同一マシン相関故障（Temporal server ごと死ぬ）には無力**＝系外 heartbeat（Actions cron）は両案同様に残る。
4. **承認は signal/update 注入**: gov ラベル（正本は GitHub のまま）を edge activity が読み、workflow へ signal。update なら受理前 validate（拒否）も可能。actor 検証は自前のまま。
5. **agent 呼び出しは activity に隔離**（Temporal の定石そのもの）: `claude -p` headless を**ローカル worker が spawn**＝local JSONL 100% 残存・lathe ingest 変更ゼロ・**観測無劣化（自作案と同格）**。Temporal Cloud を選んでも worker はローカルで動く（Cloud はコードを実行しない）＝**transcript 主権は Cloud でも保たれる**。
6. **ADR 0036 の版固定が機械化される**: Worker Versioning（GA）の pinned で「走行中 workflow は開始時の版で完走・新版は新 deployment version として一括投入・旧版は drain 後退役」＝「loop を loop で改修しない」を platform が強制。
7. **existence proof は強い**: OpenAI Codex・Replit Agent（workflow per session＋update で HITL 承認＝本設計と同型）・Dust（10M activities/日）が production 稼働。公式 AI cookbook に agentic loop パターンが正典化済み。
8. **自作カーネル 5 部品のうち ①dispatcher ②claims ③watchdog の大半が platform 化**され、自前は spawn module・GitHub edge activities（proxy 相当）・workflow 定義の**推定 1.2〜1.8k 行**に縮む（自作案 2.5〜3.5k 行比）。
9. **正直な代償**: Temporal service という**新しい常駐系**（self-host なら podman 4 コンテナ＋専用 Postgres の運用・版上げ schema migration）、決定性・replay・versioning という**新しい学習領域と新しいバグクラス**、そして**規模のミスマッチ**（数 workflow/日の系に対し百万/日級の道具）。
10. 未確認の筆頭: case podman での実測（compose は podman 動作報告あり・本 repo 実測なし）／OS user 分離（M3、自作案 Step 0-i と共通）／CC headless schema 強制出力（両案共通）。

---

## 1. 全体構成図（設計提案）

```
            ┌────────── GitHub（task/承認/着地の正本 — 両案と共通）──────────┐
            │ issue = task（ADR 0031）／PR + CI = 単一着地ゲート（ADR 0026）        │
            │ ＋ Actions cron = 系外 heartbeat 監視（相関故障の最終段・自作案と同一） │
            └───▲──────────────▲──────────────────▲──┘
     read（導出）│      書込は edge activities のみ│              PR / auto-merge│
┌─ case サーバー ──────────────────────────────────────────┐
│ ┌ Temporal Service（podman compose: server + postgres + ui）─────────────┐   │
│ │  event history / timer / retry / signal / schedule ＝ 状態と発火の正本      │   │
│ │  （Temporal Cloud 選択時はこの箱だけが外に出る。worker は下のまま）         │   │
│ └──────────▲───────────────────────────────┘   │
│       poll（outbound のみ）│                                                       │
│ ┌ worker A: orchestration（systemd・repo コード・Worker Versioning pinned）──┐  │
│ │  taskWorkflow(issue#): plan → post → await approval(signal) → implement     │  │
│ │                        → verify → land → await CI(signal) — 決定性 sandbox   │  │
│ │  intakeSchedule: Temporal Schedule 毎 N 分 → gh 導出 activity → startWorkflow │  │
│ │  activities: spawn 単一モジュール（claude -p / codex exec・env strip・        │  │
│ │              worktree 隔離・heartbeat 送信）＝ gh credential なし             │  │
│ └───────┬────────────────────────────────────┘  │
│ ┌ worker B: posting（別 OS user・別 task queue・唯一の gh 書込 credential）──┐  │
│ │  edge activities: render → intent 台帳 → REST 投稿 → post-check → confirmed │  │
│ └───────┼────────────────────────────────────┘  │
│             │ local JSONL transcript（~/.claude/projects/**）＝ 100% 残る          │
└───────┼──────────────────────────────────────┘
   ┌─────▼──────────────────────────┐
   │ lathe ingest（providers 変更ゼロ）＝ 観測無劣化（自作案と同格）│
   └────────────────────────────────┘
```

要点:
- **task queue で権能を物理分離**: agent spawn 系 activity は worker A（credential なし）、gh 書込 activity は worker B（別 OS user・唯一の credential）に routing。Temporal の task queue routing は標準機能。M3 の骨格が「proxy プロセス自作」でなく「worker 2 枚＋queue 割当」で表現できる（OS user 分離の existence proof が要る点は自作案と同一・§6）。
- **worker はすべて outbound poll**（gRPC 7233）。inbound 口なし＝Cloud 選択時もローカルに穴を開けない。
- 多段ライフサイクルの「案C」（stage 境界の冪等記録・graceful 再開）は **workflow の event history そのもの**が代替する: 完了した activity は replay で再実行されない＝stage_ledger 自前実装が不要。

---

## 2. 【問①】self-host 構成 vs Temporal Cloud

### 2.1 self-host（事実）

- **公式 compose 構成が存在**: 正本は temporalio/docker-compose（現在は samples-server/compose へ移管）。最小形 = server（auto-setup）＋ PostgreSQL ＋ admin-tools ＋ UI の 4 コンテナ。既定は PostgreSQL＋Elasticsearch だが **Postgres のみ構成のファイルが用意されている**。https://github.com/temporalio/docker-compose ／ https://docs.temporal.io/self-hosted-guide
- **podman 動作の existence proof**: 公式 issue #550 に「docker 不可の企業環境で podman play kube で立てた」実例（YAML 共有あり）。https://github.com/temporalio/temporal/issues/550 ／ podman 前提のセットアップ記事も複数（例: https://alexmachekhin.medium.com/getting-started-with-temporal-io-docker-podman-setup-and-your-first-java-workflow-3d098a4b85fb ）。**ただし case マシンの podman での本 repo 実測は未確認**（Step 0）。
- **単一バイナリ dev server**: `temporal server start-dev`（SQLite・`--db-filename` で永続化可）。公式には dev/test 用途と明記。https://docs.temporal.io/cli ／ https://github.com/temporalio/cli
- **運用最小形（設計提案）**: case 上に podman compose で server＋専用 Postgres＋UI の 3 常駐（admin-tools は随時）。単一サーバー構成は「~100 workflow 実行/秒までの負荷に適する」旨の公式ガイダンスがあり、lathe の負荷（数 run/日）は 4〜5 桁下＝容量は論点にならない。**新たに増える運用**: ①Temporal server の版上げ（schema migration 手順が伴う）②Temporal 用 Postgres の面倒（lathe Postgres と別インスタンス or 同居は §8 裁定）③UI は無認証が既定＝ローカル bind 限定の運用。https://docs.temporal.io/self-hosted-guide/deployment
- **セキュリティ**: 公式が「DB と同等に扱え・公網に出すな」と明記＝ローカル完結の本構成と整合。

### 2.2 Temporal Cloud（事実）

- 課金は Action 単位。従量部は $50/1M actions から逓減。ストレージ active $0.042/GB-h。**Essentials プラン最低 $100/月**・新規 $1,000 クレジット・恒久無料枠なし。https://temporal.io/pricing
- lathe の規模感（1 task ≒ 数十 actions、数 task/日）なら**従量は月に 1 ドル未満のオーダー＝実質ミニマム $100/月が価格**。
- **重要な構図**: Cloud はオーケストレーション状態（history/timer）だけを預かり、**コードは常に自前 worker で実行**される。worker が case に居る限り transcript は local JSONL に 100% 残る＝**routines-cloud 案の「観測劣化（判定 B）」はこの案の Cloud 選択では発生しない**。代償は依存が三枚（GitHub＋Anthropic＋Temporal Cloud）になること・$100/月・状態の正本が外に出ること。
- 判断（設計提案）: 基線は **self-host**（依存二枚のまま・$0・状態もローカル）。self-host 運用が想定超に重い場合の縮退先として Cloud を保持（worker コードは 1 行も変わらず接続先とmTLS 設定だけ）＝可逆。

---

## 3. 【問②】決定性制約と「agent 呼び出しを activity に隔離する」定石

すべて公式一次情報で確認済み（事実）。

- **制約の本体**: workflow コードは replay 可能でなければならない。再実行時に生成される command 列が event history と一致しないと non-determinism error（公式 rule TMPRL1100）。禁止: 乱数・時計直読み・I/O・外部 API・**LLM 呼び出し**を workflow 内に書くこと。https://docs.temporal.io/workflow-definition ／ https://github.com/temporalio/rules/blob/main/rules/TMPRL1100.md
- **定石**: 非決定な仕事（LLM 呼び出し・tool 実行・API・DB）はすべて activity へ。activity は非決定でよく、結果が history に記録され、replay 時は記録値が返る。retry は Temporal が担う（LLM クライアント側の retry は切る、が公式 cookbook の推奨）。https://docs.temporal.io/ai-cookbook/agentic-loop-tool-call-openai-python
- **TypeScript SDK は決定性を機械で強制**: workflow コードは Webpack でバンドルされ sandbox 実行。`Math.random`/`Date.now` は決定的実装に差し替え・`setTimeout` は timer 化・`WeakRef` 等は除去・activity は型のみ import の proxy 経由。**「決定性はレビューで守る」でなく構造で守られる**＝lathe の rubric `structural-guarantee-before-prompts`（2026-07-08 新設）と同思想。https://docs.temporal.io/develop/typescript/workflows/basics
- **本設計への写像（設計提案)**: workflow = stage 順序・承認待ち・差し戻し回数・timer だけ（LLM なし・gh 直読みなし）。gh 導出も activity。CC headless spawn は「長時間 activity」: start-to-close ≒ 90 分・wrapper が 30 秒毎 heartbeat（heartbeat payload に進捗を載せられる）・worker 死は timeout→retry policy で再試行。https://docs.temporal.io/encyclopedia/detecting-activity-failures
- **正直な注記 2 点**:
  1. **activity 内部は checkpoint されない**。worker が CC run の途中で死ねば retry は **stage 頭からやり直し**（worktree リセット等の stage 冪等性は自前責務のまま）。Temporal が消すのは「stage 間」の再開処理であって「stage 内」ではない。
  2. history 上限 51,200 events / 50MB（超過は強制終了・10,240 で警告）。1 task workflow は数十 events で桁が 3 つ余る＝実害なし。常駐型（intake schedule 等）は continue-as-new を規律化。https://docs.temporal.io/workflow-execution/limits

### 承認/裁定の signal 注入（問の指定点）

- signal = 非同期 write（fire-and-forget・history 記録）、update = 同期 write（**受理前 validate で拒否可能**・完了を送信側が追跡）、query = read。https://docs.temporal.io/encyclopedia/workflow-message-passing
- 設計提案: 承認の正本は GitHub ラベル（ADR 0035 系の裁定に従属）のまま、intake schedule の gh 導出 activity が `gov:approve` 検出→ actor 検証（timeline `labeled` actor ∈ 人間 allowlist・**未確認は両案と共通**）→ 合格時のみ `taskWorkflow` へ update 送信。workflow 側は `await approval` の 1 行。**Replit が同型を production 実装済み**（update で consent を注入し agent を再開・§5）。

---

## 4. 【問③】versioning — ADR 0036「版固定」の実現

すべて公式一次情報（事実）＋写像（設計提案）。

- **Worker Versioning（GA）**: worker 群を Deployment Version として版付けし、**pinned workflow は開始した版の worker 上でのみ完走する**（「Pinned Workflows don't need patching — 走行中 pinned workflow への破壊的変更を心配しなくてよい」と公式明記）。新版はテスト→ramp→切替、破綻時は即 rollback。旧版は drain 完了を platform が通知→退役（rainbow deployment）。https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning ／ https://temporal.io/blog/ga-worker-versioning-public-preview-upgrade-on-continue-as-new
- **Patched API（フォールバック）**: versioned deployment を組めない間の逐次パッチ手段（feature-flag 型 marker）。公式は「可能なら Worker Versioning を既定にせよ」。https://docs.temporal.io/patching ／ https://docs.temporal.io/develop/safe-deployments
- **期限情報**: 2025 年以前の実験版 Worker Versioning API は 2026-03 に server から削除済み系譜＝**現行 Deployment ベース API で組むこと**（古いサンプルを写さない）。
- **ADR 0036 への写像**:
  | ADR 0036 の要求 | Temporal での実現 |
  |---|---|
  | loop 本体の改修を走行中 loop に食わせない | pinned: 走行中 instance は旧版 worker で完走・新 task だけ新版へ（**platform 強制**） |
  | 版として計画し一回で切替 | 新 Deployment Version の一括デプロイ＝版。ramp/即 rollback 付き |
  | 切替と受け入れ（機械検証） | **replay test**: 旧版の実 event history を新版コードに食わせ互換性を機械検証（SDK 標準機能）＝「無人一巡 GREEN」の前段に置ける新しい検証資産 |
  | 走行系との分離 | 旧版 worker と新版 worker の並走（case 上では systemd unit 2 本の過渡並走） |
- **正直な注記**: 版固定の恩恵の裏で、「worker プロセスを再起動しなければ旧コードで走り続ける」という **stale 常駐問題（S2-1 の同型）が worker に戻ってくる**。自作案は oneshot で構造排除したが、Temporal worker は常駐が前提。緩和は deployment 規律（CI からの版付きデプロイ）＋watchdog の version 突合＝運用残余。

---

## 5. 【問⑤】LLM agent ループでの採用の先行事例（existence proof）

**存在する**。一次情報のみ列挙（すべて事実）:

1. **OpenAI Codex**: 「AI coding agent が Temporal 上で production 稼働し数百万リクエストを処理」と Temporal 公式 blog が明記。**coding agent という点で lathe に最も近い**が、内部構成の詳細は非公開＝**設計参照はできない（未確認）**。https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal
2. **Replit Agent**: 公式 case study。**agent session ごとに 1 workflow・workflow ID 一意性で「同時に 1 agent」を保証・update で HITL 同意を注入して再開**——本設計の workflow per task／signal 承認と同型が production 実証済み。2024-11 から数週間で移行、「Temporal がボトルネックになったことはない」。https://temporal.io/resources/case-studies/replit-uses-temporal-to-power-replit-agent-reliably-at-scale
3. **Dust**: agent platform が Temporal（Cloud）で **10M+ activities/日**。connector 群と agent 起動の orchestration。https://temporal.io/blog/how-dust-builds-agentic-ai-temporal
4. **公式統合の正典化**: OpenAI Agents SDK 統合（Python contrib・public preview、model 呼び出しを自動で activity 化）https://temporal.io/blog/announcing-openai-agents-sdk-integration ／ Vercel AI SDK 統合（TS）https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel ／ AI cookbook「Basic Agentic Loop with Tool Calling」https://docs.temporal.io/ai-cookbook/agentic-loop-tool-call-openai-python
5. **参照実装（コードが読める）**: temporal-community/temporal-ai-agent（多ターン会話 agent を workflow 内で駆動・tool 承認 HITL 込み）https://github.com/temporal-community/temporal-ai-agent ／ ai-agents-workshop-python（手書き agentic loop・MCP・child workflow の multi-agent）https://github.com/temporal-community/ai-agents-workshop-python

**接地の限界（正直に）**: 上記はいずれも「LLM API を activity から呼ぶ」型が中心。lathe のように **headless CLI (`claude -p`) を subprocess として spawn し transcript 主権を守る**構成の公開実例は今回の調査では**見つけられなかった**（＝「無い」ではなく「未発見」。activity は任意の subprocess を実行できるため技術的障壁は特定されていないが、先行実装による裏取りは無い→ Step 0 spike で自前 existence proof を取る）。

---

## 6. 【問④】M1〜M13・R1〜R8 対応表

タグ: **[platform]**=Temporal の機構保証／**[worker]**=自前 activity/workflow コード依存／**[未解決]**。比較列は foundation-decision-material.md §2 の記法（◎○△✗）。

| # | 要件 | 種別 | Temporal 案での充足 | vs routines / 自作 |
|---|---|---|---|---|
| M1 | 二重実行の物理不可能化 | **[platform]** | workflow ID `task-N` の open execution は同時 1 つ（原子的・hard guarantee・公式明記 https://docs.temporal.io/workflow-execution/workflowid-runid ）。claims テーブル自前実装が消滅。cross-machine も同一 Temporal service 配下なら自動で成立 | **両案より強い**（自作=自前 DDL・routines=DB 到達未確認） |
| M2 | silent death 検知常設 | **[platform]＋[構造(外部)]** | heartbeat timeout／start-to-close／retry policy が run・worker 死を検知し自動再試行（https://docs.temporal.io/encyclopedia/detecting-activity-failures ）。**マシンごと死・Temporal service ごと死は検知不能**＝系外 heartbeat（Actions cron）は自作案と同一に必要 | 自作の watchdog 3 点突合の大半が platform 化。系外段は同格 |
| M3 | 権能分離 fail-closed | **[worker]＋[未解決]** | task queue 分離で「credential を持つ worker」と「agent を spawn する worker」を別 OS user の別プロセスに routing（構造）。**OS user 分離＋LoadCredential の existence proof 未取得は自作案 Step 0-i と完全に共通** | 自作案と同格（platform は queue routing を提供するだけ・分離の実体は OS 設計） |
| M4 | I/O 構造化（envelope） | **[worker]＋[platform(記録)]** | activity 戻り値 = envelope JSON がそのまま **event history に永続記録**（回収経路が構造化・routines critique A-1 の問題が発生しない）。schema validate・unparsable retry は自前 keep。CC の schema 強制出力可否は**未確認（両案共通）** | 自作と同格＋history 記録の分だけ強い |
| M5 | 終端契約＋書込補償 | **[platform(retry)]＋[worker(post-check)]** | 書込 activity の失敗は retry policy＋schedule-to-close で platform が再試行・最終失敗は workflow に返り compensate 分岐（「非致命 continue」が書きにくい構造）。post-check 5 項目は自前 | 補償の骨組みが platform 化 |
| M6 | spawn 単一モジュール | **[worker]** | spawn activity 1 実装＋CI grep 検査（自作案と同一） | 同格 |
| M7 | 版固定＋self-update | **[platform]** | Worker Versioning pinned（§4）。外部 id の毎パス名前解決は自前のまま。**worker 常駐の stale 化リスクが新たに戻る**（§4 注記） | 保証は最強・stale リスクは自作(oneshot)に劣る |
| M8 | 環境 repo 正本化＋検収 4 点 | **[自前:恒久負担]＋増分** | E クラス（systemd/認証/pnpm）は自作案と同じく全部残り、**さらに Temporal service 自体（podman 3〜4 コンテナ＋専用 Postgres＋版上げ schema migration）が運用対象に加算** | **三案中で最も重い**（正直に明記） |
| M9 | 投稿物 post-check | **[worker]** | 三案同一の自前設計（intent_sha256 冪等含む） | 同格 |
| M10 | 状態は導出・二重台帳禁止 | **[worker]＋規律** | task 状態は gh 導出を維持。event history は「実行 telemetry の単独正本」（claims/ledger の後継）。**注意**: workflow 内部変数に task 状態を溜め込むと gh との二重台帳になる→「workflow は毎判断 gh を activity で読み直す」を規律化 | 同格（新しい逸脱経路に注意） |
| M11 | loop を loop で改修しない | **[platform]＋[worker]** | workflow/activity は全部 repo コード＝PR+CI 内。加えて pinned versioning が「走行中に改修が混ざる」こと自体を機械で禁止（§4） | **三案中で最も強い** |
| M12 | 外部契約 contract test | **[worker]** | gh 癖台帳・timeline actor（未確認）は共通。**Temporal 自体との契約は SDK の型と replay test が肩代わり** | 同格＋α |
| M13 | CI 検証資産全量 | **[worker]** | 共通＋**replay test という新資産**（旧 history×新コードの互換を機械検証） | 同格＋α |

| R# | 要件 | Temporal 案 |
|---|---|---|
| R1 | 注入契約 | [worker] 自前（三案同一）。fail-closed は「注入 activity 失敗→workflow が spawn に進まない」で表現しやすい |
| R2 | 非同期 dispatch | **[platform]** Temporal Schedules＋startWorkflow は非 blocking。timer/schedule は platform 保証＝自作(timer 設計値)と同格以上・routines(cadence 未確認)より強い |
| R3/R4 | 教材 2 段化・決定的配置 | [worker] 三案共通の contracts データ＋post-check |
| R5 | backend 抽象 | **維持**。spawn activity の実装差し替え（backends.mjs 転用）。TS SDK なら現行 Node 資産と地続き |
| R6/R7/R8 | triage・plan 契約・優先度 | [worker] keep 転用（三案同一）。R8 は task queue 優先度 or workflow 引数で表現 |

**規模見積り（設計提案・過小に見せない）**: 消えるもの = dispatcher 常駐/claims DDL/stage_ledger/resume/watchdog の突合大半。残るもの = spawn module（300–450）・edge activities＋post-check＋台帳（400–600）・workflow 定義＋schedule（300–500）・注入/契約（keep）。**新規＋改造 1.2〜1.8k 行**＋テスト（replay test 込み）。ただし §7 の学習コストは行数に現れない。

---

## 7. 【問⑥】正直なコスト

1. **学習コスト（最大項）**: 決定性モデル・replay 意味論・versioning 規律・TS sandbox（Webpack バンドル）の debug 作法は**新しい専門領域**。non-determinism error という**現行系に存在しないバグクラス**が増える。既存 2 案は「知っている道具（systemd/Postgres/Node）」の組み合わせであるのに対し、本案は概念習得が前置される。目安: 公式 tutorial→PoC 一巡で数日、versioning・replay test まで身につけて運用に乗せるのに**1〜2 週間台**（推測・実測なし）。
2. **運用コスト**: self-host なら常駐が**純増**する（Temporal server 群＋専用 Postgres。自作案は常駐ゼロ方針だった）。server 版上げは schema migration 手順つき。UI 無認証既定。バックアップ対象 DB が 2 系統になる。Cloud なら $100/月＋依存三枚目。
3. **やりすぎリスク（規模ミスマッチ）**: 実測 66 run/期・数 task/日の系に対し、existence proof の稼働レンジは 10M activities/日（Dust）〜数百万 req（Codex）。**容量が要らないのに保証だけ欲しい**という採用理由は成立しうるが、「platform の保証を使いこなすための固定費（学習＋常駐）」が系の規模に対して割高になる構図は否めない。charter の「プロジェクト外のハーネスは必要ない」（PdM 裁定 2026-07-08）との整合は §8-1 の裁定事項。
4. **lock-in の質**: workflow コードは Temporal の形に書かれる（移植時は書き直し）。ただし activity（spawn・edge・post-check）は素の関数＝可搬。撤退時は「workflow 定義→自作 driver」への逆変換で、共通部品（envelope・contracts・post-check・台帳）は無傷＝foundation-decision-material §2 末尾の「共通部品」戦略と両立。
5. **bus factor**: 保証の実装（uniqueness・retry・timer・replay）を**自分で書かない**分、自作案の critique C-1（自己参照的保証）は緩和される。一方で「Temporal の挙動を深く知る人間が 1 人」という新しい bus factor 1 が生まれる（OSS・docs・forum が厚い分、自作カーネルの暗黙知よりは移譲可能）。
6. **観測の副産物（コストの逆側）**: Temporal UI が task ごとの stage timeline・retry・signal 履歴を無料で可視化＝lathe の観測ミッションと同方向。ただし lathe 本体の transcript 観測とは別物（重複投資にしない規律が要る）。

---

## 8. PdM 裁定が要る点（優先順）

1. **【採用可否】第三案として比較土俵に載せるか**: foundation-decision-material §5 の決定木 D-0 は「駆動を所有 vs 外部化」の二分だが、本案は「**駆動の保証だけ OSS engine から借り、実行と観測は所有する**」中間＝決定木の改訂が要る。「プロジェクト外のハーネス不要」裁定との整合判断を含む。
2. **self-host か Cloud か**（§2。基線 = self-host・観測主権はどちらでも保たれる・差は運用 vs $100/月と依存三枚目）。
3. **M3 実現手段**: OS user 分離＋task queue 分離の existence proof（自作案 Step 0-i と共通 spike に同梱可能）。
4. **SDK 言語**: TypeScript（現行 Node 資産・backends.mjs と地続き・sandbox 強制）か Python（AI 統合 contrib が最も厚い）か。基線 = TS。
5. **Temporal 用 Postgres の置き場**: lathe Postgres(55433) と同一インスタンス別 DB か専用か。
6. **Step 0 spike の承認**（§9。両既存案の spike と並走可能・1〜2 日）。

---

## 9. 段階導入（設計提案・自作案 §5 と同粒度）

| Step | 内容 | 先へ進む条件 |
|---|---|---|
| 0. spike（1〜2 日） | (i) case podman で compose（Postgres 構成）が立つか実測 (ii) TS SDK で「`claude -p` を spawn する長時間 activity＋heartbeat＋worker kill→retry」の existence proof (iii) local JSONL が通常どおり残り ingest されるか (iv) OS user 分離×task queue 分離（自作案 Step 0-i と同梱） | (i)(ii)(iii) すべて成立。(ii) は transcript 主権の自前 existence proof（§5 の接地限界を閉じる） |
| 1. PoC | taskWorkflow 最小形（plan→投稿→手動 signal 承認→implement→PR）で trivial 実 issue 1 件を一巡 | 切替検収 4 点の機械照合 GREEN（両案と同一基準） |
| 2. 承認・watchdog 接続 | intake schedule＋gov ラベル→update 注入＋actor 検証・系外 heartbeat（Actions cron） | 並列 2 issue で二重 workflow 不発（platform 保証の実測）・模擬 worker kill が retry で回収 |
| 3. 権能分離本設 | worker B（別 OS user・posting queue）＋post-check＋台帳 | 「worker A から gh 書込が物理的に失敗する」実測 |
| 4. versioning 運用 | Worker Versioning pinned＋replay test を CI へ・harness-release 手順を版デプロイに置換 | 走行中 task を残したまま新版投入→旧 task が旧版で完走することの実測 |
| 5. 全 loop 展開→旧系退役 | 9 loop 展開・M13 全量・launchd/旧 orchestrator 退役 | 検収 4 点 GREEN 後のみ（両案と同一） |

---

## 10. 未確認事項（統合・spike 対応）

| # | 未確認 | 効く先 |
|---|---|---|
| 1 | case podman での compose 実測（動作報告はあるが本環境未検証） | 採用可否 |
| 2 | 「headless CLI subprocess を activity で spawn」の公開先行実例（未発見＝自前 spike で existence proof を取る） | 設計成立 |
| 3 | OS user 分離＋LoadCredential＋task queue 分離（自作案と共通） | M3 |
| 4 | CC headless の schema 強制出力可否（三案共通） | M4 強度 |
| 5 | timeline `labeled` actor 網羅性（三案共通） | 承認検証 |
| 6 | Temporal server 版上げの実務負荷（schema migration 頻度・破壊的変更の歴史）——今回未調査 | M8 恒久負担の見積り |
| 7 | 学習コスト見積り（§7-1 の「1〜2 週間台」は推測・実測なし） | D-1b 相当の裁定材料 |

## 11. 一次情報 URL 索引

- self-host: https://docs.temporal.io/self-hosted-guide ／ https://docs.temporal.io/self-hosted-guide/deployment ／ https://github.com/temporalio/docker-compose ／ podman: https://github.com/temporalio/temporal/issues/550
- 決定性: https://docs.temporal.io/workflow-definition ／ https://github.com/temporalio/rules/blob/main/rules/TMPRL1100.md ／ TS sandbox: https://docs.temporal.io/develop/typescript/workflows/basics
- versioning: https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning ／ https://docs.temporal.io/patching ／ https://docs.temporal.io/develop/safe-deployments ／ https://temporal.io/blog/ga-worker-versioning-public-preview-upgrade-on-continue-as-new
- message passing / timeout / limits / ID: https://docs.temporal.io/encyclopedia/workflow-message-passing ／ https://docs.temporal.io/encyclopedia/detecting-activity-failures ／ https://docs.temporal.io/workflow-execution/limits ／ https://docs.temporal.io/workflow-execution/workflowid-runid
- 事例: https://temporal.io/resources/case-studies/replit-uses-temporal-to-power-replit-agent-reliably-at-scale ／ https://temporal.io/blog/how-dust-builds-agentic-ai-temporal ／ https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal ／ https://temporal.io/blog/announcing-openai-agents-sdk-integration ／ https://docs.temporal.io/ai-cookbook/agentic-loop-tool-call-openai-python ／ https://github.com/temporal-community/temporal-ai-agent
- 価格: https://temporal.io/pricing
