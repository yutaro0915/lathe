# ADR 0012: session の第2軸 `session_class` — 非開発セッションを分類し既定で隠す

- status: accepted（2026-07-01、ユーザー裁可: 全カテゴリを最初から分類・mark-don't-delete・ADR 化＋型↔判断の rubric 対応・テスト設計を要件に着工承認）
- date: 2026-07-01
- 関連: [0002](./0002-project-identity-model.md)（project identity）/ [0007](./0007-finding-model-and-phase2-gate.md)（G9 cost-anomaly の母数）/ `design/phase2-finding-model.md` §6.5（内部実行は印を付けて隠す）/ `apps/web/scripts/ingest/domain/exit-disposition.ts`（同型の客観分類器）/ [[ingest-no-wipe-sync]]（導出層＝再 ingest で反映）
- 位置づけ: meta-audit の対象（人が指示した開発セッション）を、非開発セッションから**機械で切り分ける**ためのデータモデル決定

## 背景: なぜ今この軸が要るか

Lathe は session を **`project_id` の 1 軸でしか区切っていない**（他は runner/model/cost 等の属性）。だが DB には「人が指示した開発作業でない」セッションが混じる（実測 total 2530 中の非開発）:

- **codex-auto-review**（61）: Codex が実行のたびに自動で回す判定 agent。単価表で cost NULL。
- **`<synthetic>`**（17）: fixture/test 専用の placeholder（本番 provider は emit しない）。
- **sandbox**（数件）: harness 疎通テスト（`/Users/cherie/dev/Lathe/sandbox/…`、`harness-codex-*`）。
- **lathe-internal**: Lathe 自身の実行（analyst `lathe-internal-analyst-hybrid-v1`、chat `You are Lathe Chat…`、MCP デバッグ `…登録セッション数を確認`）。

これらは **`project` と直交する**——特定 project でなく、あらゆる project に跨がる「session の種別（kind）」。ゆえに project の下位区分では切れず、**別軸が要る**。混在すると meta-audit の triage（`list_sessions` を error/cost 順に見て suspect を選ぶ）が濁り、G9 cost-anomaly の baseline が歪む。

**さらに現状コードは前提に反している**: `usecase/discover-dirs.ts` / `shared.ts` が basename に `lathe-internal` を含む dir を **ingest 前に削除**しており（実測 `project_id='lathe-internal'` は 0 件）、「全部取り込んで印を付ける」でなく「一部を黙って捨てる」になっている。これは §6.5 の mark-don't-delete に違反。

## 決定

### 1. `session_class` を第2軸として持つ（project を汚さない）
`sessions.session_class TEXT NOT NULL DEFAULT 'development'` を新設。project は正確なまま。§6.5 が挙げた `project=lathe-internal`（直交2軸を1軸に潰す）は**却下**。

### 2. ingest 時に純関数で客観分類（事実は tool・判断は agent）
`apps/web/scripts/ingest/domain/session-class.ts` に純関数 `classifySession(input) → SessionClass` を置く（`classifyExit` と同型。型のみ import ＝ `domain-stays-pure` rubric が純粋性を機械保証）。両 provider の BuiltSession 構築点で 1 行適用。**判断順は上から最初にマッチ**:

| class | 客観規則（実データで接地） |
|---|---|
| `auto_review` | `model === 'codex-auto-review'` |
| `synthetic` | `model === '<synthetic>'` |
| `sandbox` | cwd に `/Lathe/sandbox/` または `harness-codex` を含む（**`local:` 一般は不可**——Sanpyou・asobiba 等の実 dev が local: に多数あり誤分類する） |
| `internal` | Lathe 内部マーカー: title が `lathe-internal-analyst` / `You are Lathe Chat` / MCP デバッグ（lathe project かつ title に「登録セッション数」「list_sessions」） |
| `development` | 上記いずれにも該当しない（**既定・フォールバック**。triage/baseline の母数はこれのみ） |

### 3. 全カテゴリを最初から分類（先送りしない）
`session_class` は導出列＝再 ingest で付け直せ、誤分類は (a) セッションを消さない (b) 一覧で class が見え気づける (c) 規則を直して再 ingest で修正、と**非破壊・可逆**。ゆえに「明白カテゴリだけ先・境界は後」の先送りは合理性が無い。**分類器は全カテゴリを一度に実装**する。規則の精緻化は運用観測で行う（複雑系→煩雑系の移行）。

### 4. 消さず印を付ける（mark-don't-delete）
`discover-dirs`/`shared.ts` の `lathe-internal` dir 削除を**撤廃**し、取り込んで `internal` 印を付ける。consumer は既定で `development` のみ表示、filter で opt-in:
- MCP `list_sessions`: 既定 `development`、`class`/`include_classes` param で opt-in。summary に `session_class` を含め triage で種別を可視化。
- G9 cost-anomaly: baseline 母数（`lib/db/sessions.ts` の `cost_baseline` CTE）を `session_class='development'` に絞る。
- web UI 一覧: 既定 hide、filter で表示。

### 5. 型とドメイン判断の対応（単一情報源＋機械チェック）
**canonical taxonomy = `session-class.ts` の `SessionClass` union 型と `SESSION_CLASSES` 定数**（単一情報源）。本 ADR の §2 の表はその写像であり、両者が乖離しないことを rubric で機械検査する:

- 新 rubric `apps/web/scripts/ingest/session-class-taxonomy`（`packages/domain/single-source` を前例とする）:
  - **check A（型の閉性）**: `classifySession` の返り値が `SESSION_CLASSES` の要素に限られる（union 型＋tsc、加えて分類器内に未登録の文字列リテラル return が無いことを grep で確認）。
  - **check B（ADR ↔ 型の一致）**: 本 ADR §2 の表に列挙される class 名の集合が `SESSION_CLASSES` と**完全一致**する（ADR と code を grep して集合比較。taxonomy を増減したら ADR と code の両方を直さないと RED）。
  - これが「型（session_class）をドメイン上の判断（この ADR）にどう対応させるか」の機械的担保。
- テスト `session-class.test.ts`（`exit-disposition.test.ts` に倣う）:
  - 各 class の該当ケース＋「該当なし→development」フォールバック。
  - 境界の回帰固定: `codex-auto-review` 完全一致 / `<synthetic>` / sandbox の具体 cwd（実データ4件）/ `local:` の実 dev（Sanpyou 等）が **development に落ちる**こと（過剰分類の回帰防止）/ internal マーカー。
  - **「疑わしきは development」を明文テストで固定**。

### 6. 移行（既存 DB への反映）
no-wipe ingest は `schema.sql` を適用しない（`resetDatabase` は full-rebuild 専用）。ゆえに entrypoint（`ingest.ts`/`ingest-incremental.ts`）で**冪等 ALTER**（`ADD COLUMN IF NOT EXISTS … DEFAULT 'development'`）を 1 回流す。DEFAULT で既存 2530 行は即 `development`、再 ingest で `classifySession` が遡及付与。ワンショット SQL UPDATE は**却下**（分類ロジックの単一情報源を `classifySession` に保つ）。

## 却下した代替

- **`project=lathe-internal`（§6.5 案）**: 直交2軸を1軸に潰し実 project を上書きする。却下（本 ADR の動機そのもの）。
- **ingest 前に削除（現状の discover-dirs 挙動）**: データを失い、mark-don't-delete に反し、再分類も不能。却下（撤廃する）。
- **境界カテゴリを後回し（最小版のみ先行）**: 非破壊・可逆なラベル付けに先送りの合理性が無く、非開発が development に紛れたまま残る。却下（全カテゴリ一度に）。
- **`local:` を sandbox とみなす**: 実 dev（Sanpyou/asobiba 等）を誤分類する。却下（具体 path で判定）。
- **分類を SQL UPDATE で直書き**: `classifySession` と二重定義になり単一情報源に反する（`packages/domain/single-source` の思想）。却下。

## スコープ

- 本 ADR = `session_class` 軸の導入・`classifySession`・全カテゴリ分類・mark-don't-delete（discover-dirs 撤廃含む）・consumer 既定 filter（MCP/G9/UI）・型↔ADR 対応 rubric・テスト。
- スコープ外: session_class の CHECK 制約固定（taxonomy 結晶化後に後付け）/ auto_review の cost 監視 UX の作り込み / finding kind との統合。

## 実装スライス（1 slice=1 commit・merge.mjs squash・強制ゲート経由）

- **S1**: schema 列＋entrypoint ALTER／`session-class.ts`＋test（全カテゴリ）／両 provider 適用／discover-dirs 撤廃／G9 baseline 除外／型波及。受け入れ: tsc・unit・`run.mjs --changed`（domain 純粋性・incremental-no-wipe）・heavy（incremental-integration・e2e）。
- **S1.5（監査役・別 commit）**: rubric `session-class-taxonomy`（型↔ADR 対応）を追加。
- **S2**: MCP `list_sessions` の class filter。
- **S3**: web UI 既定 hide＋種別表示（`skills/lathe-ui` フロー）。

## 一次情報（出典）

- 実データ（2026-07-01、dev DB `docker exec … psql`）: model 別件数（codex-auto-review=61 / `<synthetic>`=17 / gpt-5.x・claude-* が大多数）、`project_id='lathe-internal'`=0、`local:` 配下に実 dev 多数、lathe project 内の内部 title（analyst/chat/MCP デバッグ）。
- `apps/web/scripts/ingest/domain/exit-disposition.ts`（同型分類器）/ `usecase/discover-dirs.ts`・`shared.ts`（lathe-internal 削除）/ `lib/db/sessions.ts`（G9 `cost_baseline`）/ `packages/mcp/src/sessions.ts`（list_sessions）/ `design/phase2-finding-model.md` §6.5。
