# durable execution の軽量代替 — 比較調査（2026-07-08）

任務: 「durable execution 級の保証を Temporal より軽い足回りで得る」候補の実在確認と適合評価。
前提: Postgres 55433 が既にある / TypeScript・Node（Next.js）/ launchd 常駐 orchestrator。
規律: disciplined-research（一次情報必須・existence proof 先行・未確認を明記）。

## 結論サマリ

- **全候補とも実在し、2026-07 時点で活発に開発中**（各 existence proof は下記 URL）。
- 前提（既存 Postgres + TypeScript + 常駐物を増やしたくない）に最も適合するのは **DBOS Transact TS**（ライブラリ型・追加常駐物ゼロ・MIT）。
- 保証の強さ（journal ベース・exactly-once 通信）を最優先するなら **Restate**（ただし独自ストレージで Postgres 資産を使わない＋常駐 1 増）。
- **Postgres queue ＋自前薄層** は「キュー部分」は成熟品で買えるが、**durable execution 部分（step checkpoint・replay・determinism）を自作することになり、自作性が戻る**。

## 比較表

| 候補 | 形態 | 保証（exactly-once / timer / heartbeat / 履歴） | 常駐物の増加 | 既存 PG 55433 活用 | TS/Node 親和 | 成熟度・license |
|---|---|---|---|---|---|---|
| **DBOS Transact TS** | app 内ライブラリ | step checkpoint で再開・イベント起点 workflow の exactly-once 起動・durable sleep（週単位可）・履歴は PG 内＋API で照会可。**heartbeat 明記なし**（単一ノードは起動時 PENDING scan で回復。分散回復は Conductor(SaaS) か手動※要注意） | **0**（app + PG のみ） | ◎ system database として同居可（1 物理 PG に複数論理 DB） | ◎ npm `@dbos-inc/dbos-sdk`・TS first | MIT・1.3k★・v4.23 (2026-06-30)・DBOS Inc.（企業バック） |
| **Restate** | 独自 server（Rust 単一バイナリ） | journal ベース durable execution・**通信 exactly-once semantics**・durable timers/promises・K/V state。fsync 済み単一ノードでも耐久 | **+1**（restate-server。DB 追加不要） | ✗ 独自埋め込みストレージ（log+state 同居）。PG 資産は使わない | ○ 公式 sdk-typescript あり。ただし「Restate のサービスモデル」への書き換えが要る | **BSL 1.1**（内部利用・self-host は明示的に許可、4 年後 Apache-2.0）・4.1k★・v1.7.2 (2026-07-06)・元 Flink 創設者ら |
| **Inngest（self-host）** | 独自 server（単一バイナリ、HTTP で app を起動） | step 単位の永続化＋step 単位 retry・sleep（日単位）・イベント待ち。app 側 worker 常駐不要（HTTP 呼び出しモデル） | **+1**（inngest server。SQLite 内蔵 or 外部 PG/Redis） | △ 永続化先に自前 PG を指定可（`postgres-uri`）。ただし本番マルチノードは PG+Redis 両方要 | ◎ TS SDK が主力 | **SSPL + DOSP(遅延 Apache-2.0)**・self-host は公式サポート対象外（DB 自動 cleanup なし等の注記あり）・signing key 必須 (2026-02〜) |
| **pg-boss** | app 内ライブラリ（queue） | 「exactly-once **delivery**」（SKIP LOCKED）＝実行は実質 at-least-once・retry/backoff・cron・遅延 job・DLQ。**workflow の step 再開・履歴 replay は無い**（job dependency orchestration どまり） | 0 | ◎ そのまま乗る（PG 13+） | ◎ TS 96.8% | MIT・3.7k★・12.25.1 (2026-07)・**実質単独メンテ（timgit）＝bus factor 低** |
| **graphile-worker** | app 内ライブラリ（queue） | at-least-once・retry 25 回/約 3 日・crontab・LISTEN/NOTIFY で低遅延 (<3ms)。durable execution（step checkpoint）は無い。crash 時 lock 回復のタイムアウト値は**未確認** | 0 | ◎ そのまま乗る | ◎ TS 主体 | MIT・2.3k★・クラウドファンド型（Benjie 中心）＝bus factor 中 |
| **River** | Go ライブラリ | transactional enqueue・retry・cron・step 型 workflow あり | 0（ただし Go worker プロセス） | ◎ | **✗ worker は Go 専用**（enqueue のみ Python/Ruby 対応。Node 非対応） | MPL-2.0・5.4k★・v0.40.0 (2026-07-02) |
| **Absurd**（調査中に発見） | PG 内（PLpgSQL）＋薄い SDK | Postgres だけで durable execution（step checkpoint・retry・スケジュール・event 待ち・exactly-once semantics を標榜） | 0 | ◎ PG のみで完結 | ○ TS SDK あり（Python/Go も） | Apache-2.0・2.2k★・**0.4.0 (2026-05) = pre-1.0**・「AI 支援で構築」と明記・本番実績主張なし |

補足発見（existence proof のみ・深掘り未了）: pg-workflows（pg-boss 上の durable execution 層、個人 repo）・Microsoft **pg_durable**（PG 拡張として durable execution、2026 発表）・Hatchet・Trigger.dev（TS first の Inngest 近縁）。

## 各候補の評価詳細

### 1. DBOS Transact TS — 本命（適合度最高）

- **existence proof**: https://github.com/dbos-inc/dbos-transact-ts （MIT・v4.23・2026-07-02 更新確認）／https://docs.dbos.dev/architecture ／https://www.dbos.dev/dbos-transact
- ライブラリを install → 既存 PG に接続 → workflow/step を注釈、だけで durable execution。**新しい常駐物ゼロ**。
- 保証: 全 step の出力を PG に checkpoint、crash 後は最後の完了 step から再開。durable sleep（週単位可）、PG 格納スケジュール（2026-03〜）、workflow 履歴の programmatic 照会。step が同一 PG に書くなら「step の書き込みと durability 記録が同一トランザクションで commit」＝**トランザクショナル exactly-once**（DBOS 公式ブログの主張: https://www.dbos.dev/blog/why-postgres-durable-execution ）。
- 正直な弱点: (a) **分散環境の crash 検知は Conductor（同社 SaaS、websocket 切断検知）か手動**。単一ノード（launchd 常駐 orchestrator）なら再起動時 PENDING scan で足りるが、「プロセスが生きたまま hang」の検知は heartbeat として明記なし＝**未確認**。(b) ホットな workflow の大量 fan-out は PG のロック競合・WAL 圧として現れる（第三者比較記事の指摘: https://www.tiarebalbi.com/en/blog/dbos-vs-temporal-postgres-durable-execution ）。(c) 1.3k★ と若い（会社バックはあるが Temporal 比で採用実績は浅い）。
- 導入コスト: 55433 の同一 PG インスタンスに system database を作るだけ。既存 Next.js/Node にそのまま同居。

### 2. Restate — 保証最強・ただし足回りは「軽い別物」

- **existence proof**: https://github.com/restatedev/restate （v1.7.2・2026-07-06）／https://docs.restate.dev/server/overview ／TS SDK: https://github.com/restatedev/sdk-typescript
- Rust 単一バイナリ（brew/npm/Docker）。依存 DB なし・fsync で単一ノードでも耐久。journal ベースの durable execution＋**通信の exactly-once semantics**＋durable timers/promises＋K/V state。Temporal の多コンポーネント構成（frontend/history/matching/worker + DB + ES）に対する軽量化として設計された（公式比較: https://www.restate.dev/vs/temporal ）。
- 弱点: (a) **常駐物が 1 つ増える**（launchd 管理は可能だが監視対象が増える）。(b) **独自ストレージ**＝既存 PG 55433 の資産（バックアップ・観測・SQL での履歴照会）を流用できない。(c) コードを Restate のサービスモデル（service/virtual object/handler）に合わせる書き換えが要る。(d) license は **BSL 1.1**（self-host・内部利用は明示的に許可。LICENSE 原文: https://raw.githubusercontent.com/restatedev/restate/main/LICENSE ）。

### 3. Inngest（self-host） — HTTP 起動モデルが合えば有力、license と自己ホスト位置づけに注意

- **existence proof**: https://github.com/inngest/inngest ／self-host 公式 docs: https://www.inngest.com/docs/self-hosting ／1.0 self-host 発表: https://www.inngest.com/blog/inngest-1-0-announcing-self-hosting-support
- 単一バイナリに全サービス同梱。app 側は worker 常駐不要（Inngest が HTTP で関数を呼ぶ）。step 永続化・step 単位 retry・sleep（日単位）・イベント待ち。
- 弱点: (a) **SSPL**（+ 遅延 Apache-2.0）。(b) 公式が「self-host はサポート保証外」「DB 自動 cleanup なし＝テーブル肥大で性能劣化」と明記。(c) 本番マルチノードは外部 PG **と Redis** が要る（既存 PG だけでは閉じない）。(d) 単一ノードなら SQLite 内蔵で PG 55433 は活きない（PG 指定は可）。

### 4. Postgres native queue ＋自前薄層 — 「キュー」は買えるが「durable execution」は自作に戻る

- **existence proof**: pg-boss https://github.com/timgit/pg-boss （MIT・12.25.1・2026-07）／graphile-worker https://github.com/graphile/worker ＋ https://worker.graphile.org/docs ／River https://github.com/riverqueue/river
- 買える部分: SKIP LOCKED による安全な取り出し・retry/backoff・cron・遅延・DLQ・LISTEN/NOTIFY 低遅延。既存 PG にそのまま乗り、常駐物ゼロ、TS 親和も最高（River は除く＝worker が Go 専用で Node 不適合）。
- **自作に戻る部分（正直に）**: durable execution 級に必要な「step 単位 checkpoint と再開」「途中結果の journal と決定的 replay」「durable timer（週単位 sleep）」「workflow 履歴のモデル」は queue の上に**自分で設計・実装**することになる。想定事故クラス: 非冪等 step の二重実行（at-least-once ＋自前 checkpoint の隙間）・checkpoint スキーマの migration 事故・「job は成功したが workflow 状態の更新に失敗」の分裂・自前 replay の determinism バグ。これは lathe が避けたい「自作 harness の保守」がそのまま戻る構図。
- bus factor: pg-boss は実質単独メンテ（timgit）、graphile-worker はクラウドファンド型。queue としての実績は長い（両者とも 2010 年代後半から）。
- 中間形の existence proof（薄層を自作した人が現に居る証明）: pg-workflows https://github.com/SokratisVidros/pg-workflows （pg-boss 上に durable execution を実装。ただし個人 repo・自らの docs で大規模用途には Temporal/Inngest/DBOS 等を推奨）。

### 5. その他の発見

- **Absurd**: https://github.com/earendil-works/absurd — 「Postgres だけの最小 durable execution」。Apache-2.0・TS SDK あり・0.4.0（pre-1.0、2026-05）。思想は DBOS の更に軽量版だが、本番実績の主張なし・「AI 支援で構築」と自己申告 → 現時点では採用より観察対象。
- **pg_durable（Microsoft）**: PG 拡張として durable execution（retry・並列・スケジュール・回復内蔵）。発表: https://techcommunity.microsoft.com/blog/adforpostgresql/introducing-durable-functions-in-postgresql/4526821 — **拡張の install が要る＝マネージド/ローカル PG のバージョン適合は未確認**。
- Hatchet / Trigger.dev: durable job 系の近縁（existence のみ確認、要件が変わったら深掘り）。

## 確定事実と未確認の峻別

**確定（一次情報で確認済み）**: 各候補の実在・license・最新版と日付・言語/SDK・アーキテクチャ形態（上記各 URL）。
**未確認**: (a) DBOS の「プロセス生存中 hang」検知の有無（heartbeat 明記なし・Conductor なし単一ノード時の挙動詳細）。(b) graphile-worker の crash 時 lock 回復タイムアウト値。(c) pg_durable のローカル PG への導入可否。(d) 各候補の大規模採用実績の定量（★数と会社バック以外は裏取りしていない）。(e) pg-boss の「exactly-once delivery」は README の主張＝実行レベルでは worker crash 時に再配送される（at-least-once 実行）と読むのが安全、公式の厳密な障害時セマンティクス文書は未確認。

## lathe への適合順（評価軸加重: 常駐物最小・既存 PG 活用・TS 親和）

1. **DBOS Transact TS** — 全軸で適合。要検証は「単一ノード運用での hang 検知」と PG 負荷特性。
2. **Restate** — 保証は最強だが PG 資産を捨て常駐 +1。「exactly-once 通信」が要件化したら再浮上。
3. **Inngest self-host** — HTTP 起動モデルが orchestrator 構成に合うなら。SSPL とサポート外運用が減点。
4. **pg-boss / graphile-worker ＋自前薄層** — queue 要件だけなら最軽量。durable execution 要件があるなら自作性が戻るため非推奨。
5. River（Go 専用で除外）／Absurd・pg_durable（若すぎ・未確認多数、観察対象）。
