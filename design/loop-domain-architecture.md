# loop-domain アーキテクチャ設計ドラフト（issue #278）

> **status: draft**（設計文書 review 待ち。機械 plan review＋PdM）／ date: 2026-07-08
> **vision root**: #141（lathe を「観測ツール」から「統治された開発ループのハーネス」へ再定義）／
> 本書は #278（その最初の設計子・2026-07-08 壁打ちの確定方向）の成果物。**コード変更ゼロ**。
> **教材**: `explains/2026-07-08-issue278-loop-domain-design.md`（Discussion #284）— 用語・既存コードとの
> 対応の解説はそちらが厚い。本書は次アクション（schema・依存図・移行計画）に絞る。
> **承認**: PdM 裁定（issue #278 comment、2026-07-08）「DDD については承認するから通していい」。

## 0. 前提の補正

issue #278 本文は driver の規模を「`scripts/*.mjs` 群・15 モジュール 9,168 行」と記す。本書作成時点
（2026-07-08）の実測（テストファイル `*.test.mjs` 除く）は **26 モジュール・6,971 行**であり一致しない
（教材 `explains/2026-07-08-issue278-loop-domain-design.md` §1.2 が既に指摘）。数字のずれは設計判断
（context 境界・package 構成・依存方向）のどれにも影響しないため、本書では実測値を基準に記述し、
issue 本文の数字はそのまま history として残す（修正のための再起票はしない）。

## 1. Context map（4 つ）

issue 本文の確定表をそのまま正本とし、各行に「現状の実体」を足す。

| context | 所有 | 正 | 現状の実体 | 本書が定義する新規実装物 |
|---|---|---|---|---|
| **観測** | sessions・events・findings | lathe DB（実装済み） | `apps/web/db/schema.sql`（`sessions`/`transcript_events`/`findings`等）。Phase 1/2 で稼働中 | なし（既存のまま） |
| **駆動** | LoopDefinition・Run・stage イベント | lathe DB（新規） | **部分実装済み**: `runs`/`run_stages` テーブルは既に存在するが、正は `.lathe/runs/*.json`（manifest ファイル）で DB は `apps/web/scripts/ingest/run-manifests.ts` が読み込む**再構築可能な二次コピー**（schema.sql L24-25 のコメントが明記） | `loop_definitions`（新規テーブル）＋ **RunStore が manifest ファイルの後継になる移行**（§5・§7） |
| **統治** | plan 契約・検査文言・rubric | repo＋DB（契約のデータ化） | 現状は repo 内散文/JSON（`design/plan-format.md`、`rubrics/*/rubric.json`）のみ。DB 化なし | 契約のデータ化の**対象範囲は本書では確定しない**（§8 open question） |
| **task** | issue 状態・plan・裁定 | GitHub（導出のみ） | ADR 0031 で確定済み・稼働中（`orchestrator-derive.mjs` が gh から導出） | なし（既存のまま。loop-domain は TaskSnapshot を受け取るだけで GitHub を知らない、§3） |

**読み方の注意**: 「駆動」文脈における lathe DB の役割変化は「無 → 有」ではなく「観測用の派生コピー
（今） → 正本の一部（loop_definitions）＋ Run/stage の一次ストア（後続、manifest 後継）」という**移行**
である。§7 の移行順序が big-bang を禁止する理由もここにある。

## 2. パッケージ構成 — `packages/loop-domain`

新設パッケージ名は issue 本文の指定どおり `packages/loop-domain`（`@lathe/loop-domain` を想定）。
**既存 `packages/domain`（`@lathe/domain`）とは別物**であり名前衝突はない — `@lathe/domain` は
Phase 1/2 の finding/evidence/verdict 型（観測・分析ドメイン、`design/architecture.md` の「コア」）
を持つパッケージで、driver/loop の状態機械とは無関係。混同を避けるため package 名は `loop-domain`
のまま短縮しない。

### 移設候補（実測ベース）

原資は `scripts/inner-loop-core.mjs`（491 行、issue 本文が名指し）。同ファイルの docstring は既に
「Everything here is pure or fs-read-only; no spawnSync here」と自己申告しており、pure core 候補として
最も近い。ただし **fs-read-only は I/O ゼロではない** ため、`loop-domain` へ移す際は fs 読み込み
（`INNER_SETTINGS_PATH` の `readFileSync` 等）を ports 側（`Clock`/設定アダプタ）に切り出す必要がある
（そのままコピーしない）。

| 現在地 | 内容 | loop-domain 行き | 備考 |
|---|---|---|---|
| `inner-loop-core.mjs` | `parseVerdict` / `VALID_VERDICT_TOKENS` / stage テーブル定数（`TASK_LOOP_STAGES` 等）/ `runStageWithUnparsableRetry` | **domain**（状態機械・型） | fs 読み込み（設定ファイル注入）は port 経由に置換 |
| `inner-loop-backends.mjs` | `stagePermissions()`（段階→agent/permission の写像テーブル） | **domain**（純粋な写像。`readFileSync` 呼び出しはこの関数の外） | 現状 1 ファイルに純粋関数と設定ファイル読み込みが同居。分離が前提 |
| `inner-loop-projects.mjs` | Projects V2 の状態解決ロジック | **既に pure/impure 分離済み**（"Pure helpers are exported separately... side-effect helpers take a deps injection point"） | この分離パターンを ports/adapters 化の雛形として再利用する（§3） |
| `orchestrator-classify.mjs` | 導出 snapshot → dispatch クラスの決定的純関数 | **domain候補**（既に "side effect なし" と自己申告） | GitHub 由来の型（label 等）に直接依存している箇所は TaskSnapshot 型に正規化してから domain に入れる |

**方針**: 「491 行をそのまま `packages/loop-domain/src/` にコピーする」のは変更ではない。移設は
関数単位で「本当に I/O ゼロか」を dependency-cruiser の新ルール（§4）で機械検査しながら行う。

## 3. 三輪の依存図（内→外、依存は外→内のみ）

```
┌─────────────────────────────────────────────┐
│ adapters（外側）                              │
│  gh CLI adapter │ Postgres adapter(RunStore) │
│  claude/codex CLI adapter(AgentBackend)      │
│  Next.js UI（読むだけ・起動しない）             │
└───────────────▲───────────────────────────────┘
                │ 実装する
┌───────────────┴───────────────────────────────┐
│ ports（中間・interface のみ）                   │
│  TaskSource / RunStore / AgentBackend / Clock  │
└───────────────▲───────────────────────────────┘
                │ 依存（型として使うだけ）
┌───────────────┴───────────────────────────────┐
│ packages/loop-domain（最内周・I/O ゼロ）        │
│  型・状態機械・prompt 契約・見積り規則           │
│  何も import しない（node:fs / pg / gh 禁止）   │
└─────────────────────────────────────────────┘
```

- **ports の置き場所**: `packages/loop-domain` 内に interface のみを定義する（実装ゼロなので
  I/O ゼロ制約に抵触しない）。別パッケージに分けない — ports は domain 層が要求する契約であり、
  分割すると「domain が何を必要とするか」が読めなくなる（YAGNI、機構は追加より削除の原則
  ／`AGENTS.md`）。
- **既存コードとの対応**（新規に作るのではなく、今ある pure/impure 分離を昇格させる）:
  - `TaskSource` ≈ `orchestrator-derive.mjs`（gh 導出）＋ `inner-loop-projects.mjs`（Projects V2）
    の副作用部分を実装として backing。
  - `RunStore` ≈ 現行は manifest ファイル（`.lathe/runs/*.json`）読み書き。移行後は Postgres
    adapter が実装（§7 wave ③）。
  - `AgentBackend` ≈ `inner-loop-backends.mjs` の spawn 部分（claude CLI 呼び出し）。
    `stagePermissions()`（写像テーブル）は純粋なので domain 側に残る（表の分離、上記§2）。
  - `Clock` ≈ **現状は port として存在しない**（`new Date()` / `Date.now()` が各所に直書き）。
    決定的な状態機械のテストを書くために本移行で新設が必要（既存コードに対する追加、破壊的変更ではない）。

## 4. dependency-cruiser 追加ルール案（機械強制、issue 本文 §2 の要求）

`.dependency-cruiser.js` は既に `pure-core-no-io` ルール（`packages/shared/src/` と
`packages/domain/src/` を対象に pg/fs/net/child_process/lib-postgres の import を error 化）を持つ。
**1 ルールの追加で足りる**（新設ではなく既存パターンへの条項追加）:

1. `from.path` の正規表現に `^packages/loop-domain/src/` を追加する（`pure-core-no-io` を拡張、
   もしくは同一ロジックの姉妹ルールとして複製）。
2. **GitHub 非依存の追加チェック**（issue 本文 §3「コードは GitHub 非依存」の機械強制）:
   `to.path` に `child_process`（`gh` CLI 起動経路）と、将来 octokit 等を使う場合はそのパッケージ名を
   加えた **新ルール `loop-domain-no-github`** を立てる。既存 `pure-core-no-io` は `child_process` を
   既に禁止対象に含むため、実質は同じルールの対象パス拡張で両方満たせる可能性が高い（要実装時確認）。
3. **前提の欠落**: 現在 `scripts/` ディレクトリ全体が `pure-core-no-io` の `from.path` 対象外
   （dependency-cruiser 設定コメント「scripts/ は architecture §5 の I1 機械強制対象外」）であり、
   かつ `pnpm lint:deps` の実行対象リストにも `scripts/` は含まれない。**loop-domain 移行が scripts/
   側のコードを domain import に置き換えても、置き換え漏れは今の lint:deps では検出できない** —
   これは wave ①（§7）着手前に埋めるべき前提条件としてここに明記する（本書は設計のみで直さない）。

## 5. schema 素案（駆動 context の新規実装）

```sql
-- 新規: LoopDefinition — 版つき（ADR 0036 の版固定に対応）。
-- 「散文 prompt の追放」（#189 型事故の構造的封じ、issue本文§6③）が主眼。
CREATE TABLE IF NOT EXISTS loop_definitions (
  id           TEXT PRIMARY KEY,        -- 例: "task-loop@3" 相当の版付き識別子（採番規則は実装時確定）
  loop_kind    TEXT NOT NULL,           -- 既存 runs.loop_kind と同じ語彙を継承（task / plan-task / meta 等）
  version      INTEGER NOT NULL,
  spec         JSONB NOT NULL,          -- stage 列・permission 写像・prompt 契約（散文でなく構造化）
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | active | retired（executor が読むのは active のみ）
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (loop_kind, version)
);
```

- **task 状態テーブルは作らない**（issue 本文 §3、ADR 0031「保存せず導出」の延長。二重台帳の禁止は
  設計上の固定境界であり、本書のどの schema 素案もこれに違反してはならない）。
- 既存 `runs`/`run_stages` は**廃止しない**。現行の「manifest ファイル→DB 導出」ロールをそのまま
  Phase A として維持し、wave ③（§7）で executor が `RunStore`（Postgres adapter）に直接書くように
  なった後、manifest ファイルは段階的に「後継された旧経路」になる。`schema.sql` 冒頭コメント
  （L24-25 の「正は `.lathe/runs/*.json`」の記述）は移行完了時に更新が要る — **本書では確定しないが
  wave ③ の受け入れ条件の一つとして明記しておく**（§7）。
- `loop_definitions` と `runs` の関連付け（`runs.loop_definition_id` の追加要否）は実装時の詳細と
  し、本書では未確定（§8）。

## 6. データフロー（issue 本文 §5 をそのまま採用、対応ファイルを注記）

```
orchestrator: gh adapter（orchestrator-derive.mjs 相当）
              → TaskSnapshot
              → domain.classify（orchestrator-classify.mjs の純粋部分が昇格）
              → dispatch（dispatch-runner.mjs）

executor:     domain が段を決め（inner-loop-core.mjs のステージ表が昇格）
              → claude adapter（AgentBackend、inner-loop-backends.mjs の spawn 部分）が実行
              → RunStore（DB）に段イベント追記 ＝ manifest ファイルの後継（§5）

UI:           DB を読むだけ（apps/web、既存 lib/read パターンを流用）。
              UI からプロセスを直接起動しない — 意図を DB に書く
              （Ready への移動／hold label と同じ「入力は状態を書くだけ」の思想、ADR 0031/0037 と同型）。
```

## 7. 移行順序（big-bang 禁止。issue 本文 §6 に実装対応を注記）

| wave | 内容 | 対応の現状ファイル／新規物 | 受け入れ条件（例） |
|---|---|---|---|
| ① | `loop_definitions` テーブル＋ run ingest の schema 追加 | `apps/web/db/schema.sql` 追記、`run-manifests.ts` は変更なし（後方互換） | migration 適用 GREEN・既存 ingest 回帰なし |
| ② | 読み取り専用 Loops UI | 新規 `apps/web/app/loops/`（既存 `lib/read` パターン踏襲、生 SQL 禁止 I1 継承） | UI がある `loop_definitions`/`runs` を表示・書き込み経路なし |
| ③ | executor が定義を DB から読む（散文 prompt の追放、#189 型事故の構造的封じ） | `inner-loop.mjs` 系が `loop_definitions.spec` を読みに行く。manifest ファイルは RunStore(DB) 直書きに置換 | 無人一巡 GREEN（ADR 0036 の受け入れ条件形式）・schema.sql コメント更新 |
| ④ | 編集 UI | Loops UI に書き込み経路追加 | 意図が DB 経由でのみ実行に反映される（プロセス直起動なし） |

**この移行順序自体が ADR 0036（harness-release loop）の対象**（§ 8 節「版計画」参照）。

## 8. Open questions（本書では確定しない・実装時 or 後続 ADR 改訂で決める）

1. `design/architecture.md` §1 は「ユビキタス言語は lathe 全体で 1 つ（単一 bounded context）」と
   宣言している。これは同書の scope（`apps/web` の観測・分析ドメイン）に対する宣言であり、driver/loop
   の実行機構（scripts/*.mjs、GitHub から独立した実行ハーネス）は同書の対象外だった。**loop-domain は
   architecture.md の単一 BC を破る追加 BC なのか、それとも同書の scope 外に元々あった別物の追認か**
   — ADR 起草（`adr/0038`）で立場を明示するが、architecture.md 本体の改訂は本 issue の scope 外。
2. `loop_definitions` の版番号方式（単調増分 integer か、semantic version か、content hash か）。
3. 「統治」context の「契約のデータ化」がどこまで DB に載るか（rubric 全体か、prompt 契約だけか）。
4. `stagePermissions()` を domain に置くか ports（policy adapter）に置くか — 純粋関数だが「何を
   agent に許可するか」は運用ポリシーであり、統治 context との境界が曖昧（§1 表の「統治」との重複可能性）。
5. `runs.loop_definition_id` のような既存テーブルへの列追加要否。

## 9. 参照

- issue #278（plan 本文）／ vision #141
- 教材: `explains/2026-07-08-issue278-loop-domain-design.md`（Discussion #284）
- ADR 0031（task 状態導出）／ADR 0036（harness-release loop）／ADR 0009（agent-as-core-module、ports/adapters 先例）
- `design/architecture.md`（既存の単一 BC 宣言・I1-I7 構造不変条件）
- `design/loops.md`（loop 台帳）
- `.dependency-cruiser.js`（`pure-core-no-io` 既存ルール）
- `scripts/inner-loop-core.mjs` / `inner-loop-backends.mjs` / `inner-loop-projects.mjs` / `orchestrator-classify.mjs`
- `apps/web/db/schema.sql`（`runs`/`run_stages`/`harness_versions` 既存テーブル）／`apps/web/scripts/ingest/run-manifests.ts`
- 本書に伴う ADR 起草: `adr/0038-loop-domain-and-context-boundaries.md`
