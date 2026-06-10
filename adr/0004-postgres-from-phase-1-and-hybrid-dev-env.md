---
id: 0004
title: DB = Postgres（Phase 1 から）+ hybrid dev env（依存だけ Docker・アプリは host）+ dev/prod compose 分離
status: accepted
date: 2026-06-09
deciders: [yutaro0915, claude]
supersedes: null
---

## Context

[ADR 0003](./0003-monorepo-with-pnpm-workspaces.md) で monorepo 化を決めた流れで、DB と実行環境の方針を議論した。

これまでの [ROADMAP.md](../ROADMAP.md) の前提:

- Phase 1-6 は SQLite + `node:sqlite`、Phase 7+ で「SQLite の限界に当たったら Postgres へ切替」
- Deploy は Cloudflare Workers + D1（軽量 SaaS）と Docker Compose（セルフホスト）の 2 経路を両論併記

この前提は「Postgres 化は将来の may」という不確実性に基づいていた。議論でユーザーが次を確定させたことで前提が変わった:

- **将来ちゃんとセルフホストする。Docker でやるのは確定**
- **DB は Postgres（系）に置き換える予定**
- **開発も Docker でやりたい**（= 行き先のスタックで開発する）
- **依存が増えたらコンテナにしていく**

end state が確定したため、Postgres を後回しにしていた YAGNI の根拠が消えた。加えて「dev でアプリ本体も Docker に入れるべきか（= Docker は全部 Docker でないといけないのか）」という論点を、ドメインが近い 5 実装で一次情報調査した。

### 確認した事実

DB 可搬性（現コードの実測）:

- 現状は `node:sqlite`（`better-sqlite3` が Node 24 prebuilt 不在のため採用したもの）
- node:sqlite API は **3 ファイルに集中**（`lib/db.ts` 読み / `scripts/ingest/db.ts` 書き / `scripts/coverage_check.ts` 検証）
- SQLite 固有は少数: `INTEGER PRIMARY KEY AUTOINCREMENT`（2 table）/ `json_extract`（1 query）/ `PRAGMA foreign_keys` / WAL ファイル削除。FTS5・window・recursive CTE・R-tree は不使用 → **約 95% 可搬**
- `pg`（node-postgres）は pure JS → node:sqlite を選んだ native build の痛みが消える
- Postgres `jsonb` は SQLite json1 より強く、JSON 重い Phase 2 finding/meta に向く
- Cloudflare D1 は SQLite 系。**Postgres を選ぶ = SQLite 方言ファミリーから出る**選択（小さい方言差が実在化するが、schema が小さい今のうちに一度で渡る）

dev 環境の Docker 粒度（一次情報調査、2026-06-09）:

- **Langfuse / Sentry / PostHog / Trigger.dev はすべて dev = 依存だけ Docker・アプリは host**、prod = アプリ込みの別 compose、という非対称
- **Supabase だけ全部 Docker** だが、これは BaaS で「ホットリロードしながら書くアプリ本体が（ユーザー視点で）存在しない」境界条件のため。Lathe には当てはまらない

## Options

DB エンジン:

- (a) SQLite を Phase 6 まで維持し Phase 7 で移植（旧 ROADMAP 案）
- (b) **Postgres を Phase 1 から**

dev 環境の Docker 粒度:

- (c) 全部 Docker（Supabase 型）
- (d) **依存だけ Docker・アプリは host**（cohort 標準）
- (e) 何も Docker にしない（SQLite の間のみ成立）

## Decision

1. **DB = Postgres を Phase 1 から採用**（ROADMAP の「SQLite を Phase 6 まで / Postgres は Phase 7」を撤回）。根拠: end state 確定で YAGNI 不成立 / schema が 7 table・全 GREEN の clean checkpoint の今が最安（[ADR 0003](./0003-monorepo-with-pnpm-workspaces.md) の "cheapest now" と同型）/ pg は pure JS で native build 痛が消える / jsonb が Phase 2 に向く。
2. **dev 環境 = hybrid**: docker compose は状態付き依存（Postgres、将来 Redis 等）だけを動かし、**アプリ（Next.js）+ worker は host で `pnpm dev` / `tsx watch`**。ドメイン一致の 4 先例で裏取り済み。アプリの Docker 化は不採用（Supabase の理由は非該当）。
3. **SQLite の間は dev に Docker 不要。Docker が dev に入るのは Postgres 移行の瞬間**。アプリは published port 経由で DB を `localhost:<port>` として見る（コンテナと知らない）。dev は `localhost`、prod は service 名、で **接続文字列（env）だけが変わる**。
4. **dev/prod の compose を分ける**: dev = 依存のみ。prod/self-host = アプリ + worker + Postgres を束ねた別の最小 compose（2〜3 サービス。PostHog/Sentry の 20+ は過剰）。cohort 共通の非対称。
5. **"背後のエンジン"（Phase 2-4 の分析/採点/sandbox worker）= dev では host / オンデマンド**（既定でコンテナ化しない）。sandbox の隔離は prod/self-host の関心事。先例: Trigger.dev は実行エンジンを dev の既定 compose に入れていない。dev では実 sandbox 常時起動でなくモック/オンデマンドを優先。
6. **依存の増やし方 = 出てきたらコンテナに足す**（cohort の "deps in Docker" を漸進適用）。アプリは host のまま。
7. **deploy 主経路 = Docker Compose + Postgres**。Cloudflare Workers + D1 路線は降格（後で Workers deploy が要れば再検討）。これに伴い Phase 3 sandbox は Docker ベースが第一候補（Cloudflare Sandbox SDK の Workers 同居メリットが薄れる）。
8. **DB 接続先は env/config の seam にする**（`process.cwd()/data/lathe.db` 直書きをやめる）。dev/prod/cloud を接続文字列だけで切替。

## Consequences

- **実装時の作業**（着手タイミングは別途決定）: 3 DB モジュールを `pg` へ書換 / schema 方言パス（AUTOINCREMENT→IDENTITY、json_extract→`jsonb`/`->>`、PRAGMA 削除、WAL 処理削除）/ `docker-compose.dev.yml`（postgres）追加 / CI に postgres service / e2e を SQLite ファイルから test Postgres へ。範囲は限定的（既見積りの 3 ファイル + schema）で、Phase 2 が table/query を増やす前の今が最安。
- **未決定（ユーザーと決める。本 ADR では決めない）**:
  - monorepo 移行（[ADR 0003](./0003-monorepo-with-pnpm-workspaces.md) の "A"）との順序。Claude の推奨は **A（構造・低リスク・GREEN 維持）→ Postgres 化（挙動変更）**。未確定。
  - prod compose の正確な中身（self-host 需要が実在化してから）。
- **クラウド実行**（agent がクラウドで完結）: [ADR 0001](./0001-ingest-via-hook-and-server-side-jsonl.md) の「server が jsonl を path で読む」前提は filesystem 非共有で崩れる。将来 lathe-client の「中身/artifact を push する変種」+ 公開エンドポイント（VPS）か outbound トンネル（Cloudflare Tunnel / Tailscale）で対応。MVP 外として明示保留。
- [AGENTS.md](../AGENTS.md) の "Stack: Next.js + SQLite（better-sqlite3）" は二重に stale。**Postgres 実装が入った時点で更新**（動くコードに合わせるため、それまでは変えない）。
- [ROADMAP.md](../ROADMAP.md) の architecture 節 + 決定索引を本 ADR に合わせて改訂（同時に実施）。

## Sources（dev 環境調査・一次情報、2026-06-09）

- **Langfuse**: `docker-compose.dev.yml`（依存のみ: postgres/clickhouse/redis/minio）+ `package.json` の `dx`/`dev`（host で `turbo run dev`）— github.com/langfuse/langfuse
- **Sentry**: develop.sentry.dev/development-infrastructure/environment（"application code on host; stateful infra in containers"）+ getsentry/devservices + getsentry/self-hosted（prod は全コンテナ）
- **PostHog**: `docker-compose.dev.yml`（依存のみ）+ handbook「Developing locally」（全部 Docker はコード同期が遅く非推奨）+ `docker-compose.hobby.yml`（self-host は全コンテナ）— github.com/PostHog/posthog
- **Trigger.dev**: `docker/docker-compose.yml`（依存のみ・実行エンジンは dev 既定に無し）+ self-host docs（webapp/worker 分割、supervisor）— github.com/triggerdotdev/trigger.dev
- **Supabase**（反例）: `supabase start` が全スタックをコンテナ起動（BaaS のため）— supabase.com/docs/guides/local-development
