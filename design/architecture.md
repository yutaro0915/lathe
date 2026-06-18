# Lathe Architecture — 理想状態（ガチガチ版）

> **status: draft（レビュー用・未 commit）** ／ date: 2026-06-18
> **決定済み**: 単一 bounded context + モジュール ／ hexagonal（依存ルール）を背骨 ／ DDD は **分析ドメインだけ**戦術適用 ／ **CQRS-light**（書きは厚く、読みは薄く） ／ ingest = pipeline + ACL
> **強制**: 本書の **構造不変条件（§5）** は oxlint + dependency-cruiser が機械強制。**コードの振る舞い規範**は `rubrics/`（N1–N8 を機械検査・agent-judge 化、merge は run.mjs のみ）。
> **関連 ADR**: 0009（agent 駆動 = ACP client）／ 0007・0008（finding モデル）／ 0003（pnpm monorepo）／ 0004（Postgres）／ 0005（harness）

## 0. このドキュメントの位置づけ

- **理想状態の正本**。監査（2026-06-17）で判明した現状の病 —— 神ファイル（2,000 行級 6 本）／旧 globals.css と DS v1 の二重スタイル／境界未強制による越境・重複／DOM 過結合の e2e —— から、ここへ**収束**させる。
- 役割分担を明確にする:
  - **`rubrics/`（N1–N8 を機械検査・agent-judge 化）** = コードの振る舞い規範（反証可能ゲート・provenance 保持・scratch 隔離 等）。
  - **本書** = **構造と境界の定義**（層・依存方向・モジュールの home・file-size 等）。
  - **linter** が本書の構造不変条件を、**verify ゲート** が norms を、それぞれ機械で守る。

## 1. ドメインモデル（単一 bounded context）

ユビキタス言語は lathe 全体で 1 つ（同名は同一概念。文脈ごとの別定義は持たない）。主要概念と集約:

| 概念 | 定義（1 行） | 所属集約 |
|---|---|---|
| project | 正規化 git remote 単位の ID | — |
| session | coding-agent の 1 実行（transcript/diff/stats を持つ） | **Session 集約**（read 投影中心） |
| transcript_event | セッション内の時系列イベント | Session 集約 |
| changed_file / diff_hunk / attribution | 変更ファイル・diff 断片・event への帰属 | Session 集約 |
| finding | 検出された issue（failure_loop / unattributed_diff / excess_cost / risky_action） | **Finding 集約** |
| finding_evidence | finding の根拠（論理座標） | Finding 集約 |
| finding_verdict | 採否（accept / reject） | Finding 集約 |
| analysis | 深掘り（cause / intent / impact、env-vs-product） | Finding 集約 |
| harness_artifact / harness_version | ハーネス構成物と hash 版 | **Harness 集約** |
| pull_request | GitHub PR（read-only import） | PR（補助） |

- **Finding 集約の不変条件**: verdict は二値（accept/reject、本体に埋めず別テーブル）。backlog は `open → addressed | dismissed` のみ遷移。analysis は上位（agent 生成）を下位 backfill で**上書きしない**（rubric: analyst/backfill-missing-only / N3）。
- **DB スキーマは健全**（正規化・冪等 ALTER・JSONB 適切・FK index あり、監査確認）→ **維持**。ドメインモデルはこのスキーマに対応する。

## 2. サブドメイン（どこを厚く設計するか＝全面 DDD にしない根拠）

| 区分 | 領域 | 設計の厚み |
|---|---|---|
| **コア（差別化の源泉）** | 分析 / 検出（rules-v1 + ACP analyst の深掘り cause/intent/impact・env-vs-product） | **DDD 戦術を集中**。純粋・DB 非依存・unit test 可能に |
| 支援 | 観測（read 投影）／ triage（verdict/backlog） | 薄く。read は投影、triage は小さな状態遷移 |
| 汎用 | ingest（transcript 変換）／ PR 同期 | **pipeline + ACL**。rich behavior にしない |

→ コアだけ厚く、他は薄く。これが「hexagonal を背骨にしつつ DDD は分析ドメインに限定」の具体。

## 3. レイヤーと依存ルール（背骨 = hexagonal / 依存は内向きのみ）

```
Interface（app/：RSC・route・components ／ e2e）        生 SQL 禁止・DS v1 単一
        │  ↓ 呼ぶ
Application（use case）   write = command（厚い）  ／  read = query（薄い read model）   ← CQRS-light
        │  ↓ 依存
Domain（純粋・依存ゼロ）  検出ルール ／ Finding・Session・Harness モデル ／ analysis ／ cost-anomaly
        ▲ 内向きに依存
Adapters（ports 実装）   Postgres ／ provider(ACL) ／ ACP ／ MCP server ／ GitHub
```

- 依存は**内向きのみ**。**Domain は db/web/framework/provider を知らない**。
- Adapter は Domain/Application が定義する port を実装する（Domain は Adapter を import しない）。
- 読み取りは**集約を再構築せず**、薄い read model（query）で直に取る（観測 UI の性能を守る＝CQRS-light）。

## 4. モジュール対応表（現状 → 目標の層・home）

| 層 | 役割 | 現状の所在（監査） | 目標 home（**提案**） | 主な是正 |
|---|---|---|---|---|
| Domain | 検出ルール・Finding/Session/Harness モデル・analysis・cost-anomaly・domain types | `analyst-engine.ts`(神) / `lib/types.ts` / `@lathe/shared` 散在 | **`packages/domain`（新設提案）** | 神モジュール分解。**mcp→apps/web 違反(I2)も同時解消** |
| Application(write) | submitFinding・verdict・backfill(missing-only)・ingest orchestration | `lib/mcp.ts` / verdict route 直 SQL / `analyst-engine.ts` / `ingest/notify` | **`lib/write`** | command 集約。route の生 SQL 撤去 |
| Application(read) | session bundle・stats・findings 一覧・turn-context | `lib/db.ts`(神 1,613 行) | **`lib/read`**（薄い query） | 投影に分割。集約再構築しない |
| Adapter(Postgres) | `queryRows`/`queryOne` + ingest 書き込み | `lib/postgres.ts` / `ingest/db.ts` | `lib/db`（低レベル） | **生 SQL が存在してよい唯一の場所(I1)** |
| Adapter(provider / ACL) | Claude/Codex transcript → 正規化モデル | `ingest/providers/{claude,codex}.ts` | 同左 | 変換に限定（ACL）。`langOf` 重複解消 |
| Adapter(ACP) | 既存 agent ランタイム駆動 | `@lathe/acp-client` | 同左 | ADR 0009 のとおり |
| Adapter(MCP server) | agent に tool を公開 | `@lathe/mcp`（apps/web を相対 import） | 同左 | **apps/web 依存を切る**（schema を domain へ） |
| Adapter(GitHub) | PR 同期 | `ingest/github.ts` | 同左 | — |
| Interface | RSC・route・components ／ e2e | `app/` / `components/`(神) / `e2e/app.spec.ts`(2,869 行) | 同左 | 生 SQL 禁止・DS v1 単一・god-component 分割・e2e を role/testid 化 |
| （将来の継ぎ目） | agent 駆動（live session・permission・turn 制御） | `@lathe/acp-client` + context 組み立て | 同左 | **言語が分岐したら BC へ昇格**（ADR 0009、投機的に作らない） |

## 5. 構造不変条件（linter で機械強制）

| # | 不変条件 | 強制ツール | 是正する現状 |
|---|---|---|---|
| I1 | 生 SQL は `lib/db` と `ingest/db` のみ。route/component/**lib/write** は Application 経由（lib/write は **lib/db を呼ぶ＝生 SQL を持たない**） | dependency-cruiser（**`@/lib/postgres` の `queryOne`/`queryRows`/`getPool` import を lib/db・ingest/db 以外で forbidden**。`pg` 直 import は postgres.ts だけなので `pg` ルールだけでは route を捕捉できない）+ 生 SQL リテラルの grep/oxlint backstop | verdict route 直 SQL／analyst の `getPool()` 直叩き |
| I2 | 依存は内向き一方向（interface→application→domain）。`packages/*` は `apps/web` を import しない | dependency-cruiser forbidden | mcp→apps/web 相対 import |
| I3 | スタイルは DS v1（`lds-*`）単一。`:root` は tokens.css のみ | oxlint adherence（生 hex/px 禁止、[ui-design-language.md](ui-design-language.md)） | globals.css と二重・token 値衝突 |
| I4 | **1 ファイル ≤ 500 行 / 1 関数 ≤ 80 行**（提案値）+ god-file は §6 で grandfather（単調減少のみ） | oxlint `max-lines` / `max-lines-per-function` | 2,000 行級 6 本 |
| I5 | e2e は `getByRole` / `getByTestId` のみ（CSS 子孫セレクタ禁止） | 当面レビュー gate + `data-testid` 付与（機械規則は後続） | 412 locator の 99% が CSS 子孫 |
| I6 | 共有ロジックは単一の home。デッドコード禁止 | dependency-cruiser `no-orphans` + oxlint no-unused | stableJson 等の重複・GlobalNav 死蔵 |
| I7 | 外部入力（MCP 引数 / LLM payload / JSON-RPC / transcript）は型ガード。`Record<string,any>` を界面に置かない | tsc strict + レビュー（N7 と接続） | `LooseRecord` が transcript 全体を覆う |

## 6. grandfather リスト（単調減少のみ許可・新規ファイルは即 I4 準拠）

監査時点の行数。**増加禁止・分割で減らす**。収束完了で空にする。

- `apps/web/e2e/app.spec.ts` — 2,869（surface 別に分割 + role/testid 化）
- `apps/web/components/SessionViewer.tsx` — 2,519（tab 別 component + hook/lib へ抽出）
- `apps/web/scripts/analyst-engine.ts` — 1,769（domain / acp / application に分解）
- `apps/web/lib/db.ts` — 1,613（read model に分割）
- `apps/web/components/DiffViewer.tsx` — 1,280（standalone/embedded 分離）
- `apps/web/components/FindingsExplorer.tsx` — 1,030（axis/session 整理）

## 7. 既存ドキュメントとの関係

- `rubrics/`（N1–N8 を機械検査・agent-judge 化）= 振る舞い規範のゲート。本書 = 構造。両者は補完。
- [../adr/0009-agent-as-core-module.md](../adr/0009-agent-as-core-module.md) = agent 駆動 = ACP client。本書の Adapter(ACP) と将来の継ぎ目はこれに従う。
- [ui-design-language.md](ui-design-language.md) / design system v1 = I3 の単一スタイル系の正本。
- `rubrics/meta/pr-split` / `skills/lathe-loop` = PR スタック運用（散文 MD は廃止）。
- DB スキーマ（`apps/web/db/schema.sql`）= 健全につき維持。本書のモデルはこれに対応。

## 8. 確定事項（2026-06-18 ユーザー承認）

- **file-size**: 1 ファイル ≤ 500 行 / 1 関数 ≤ 80 行（god-file は §6 grandfather で単調減少のみ）。
- **Domain の home**: `packages/domain` 新設（`@lathe/mcp` の apps/web 依存 = I2 違反を同時に解消）。
- **最小 CI**: `.github/workflows` で **tsc + oxlint + dependency-cruiser + verify + e2e** を gate 化（現状 CI ゼロ・RC5）。
- **規律 skill**: `orchestration-discipline`（hub `skills/`）+ lathe hooks（PreToolUse/Stop）+ `.claude/agents`（model 配分）。
