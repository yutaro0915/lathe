---
id: 04
title: Split scripts/ingest.ts into provider modules and tighten Built type
status: todo
assignee: codex
depends_on: [01, 02, 03]
estimated: large
---

## What

`scripts/ingest.ts`（1134 行 / `any` × 41）を **provider 別モジュール + 共通 shared utils + provider interface** に分解する。`interface Built` の `any` を実型に置き換える。**ingest の出力（DB の中身）を変えない**。

## Why

[REFACTOR-PLAN.md](../REFACTOR-PLAN.md) の「主な問題 3」参照。現状の構造:

- 0-300 行: 共通 utils（hhmmss, lineCount, preview, durationBetween, toolType, toolTitle, isCommit, isTest, parseSubagentUsage, extractChildEvents）
- 308 行: `interface Built { session: any; events: any[]; ... }` ←**全部 any**
- 318-758 行: **Claude 実装**（`buildSession`、440 行）
- 760-1020 行: **Codex 実装**（`buildCodexSession`、260 行）
- 1023-1134 行: `main()` — 順に呼ぶ

provider抽象がゼロのため、Cursor 追加が「同じスタイルで 3 個目の `buildCursorSession` を 500 行追記」になる。本タスクで分解しておけば、Cursor 追加が「`providers/cursor.ts` を 1 ファイル新規 + `main` に 1 行追加」になる。

## Input

- `scripts/ingest.ts`
- `lib/types.ts`（`Runner` / `EventType` / `Session` / `TranscriptEvent` 等の型定義）
- `db/schema.sql`（DB スキーマ — **変更しない**）
- `scripts/coverage_check.ts`（network 確認、変更しない）
- 比較対象として現状の DB を `pnpm ingest` で生成し、件数や代表セッションのイベント数を控える。リファクタ後に**同じ件数**が出るか確認するため。

## Output

新規ディレクトリと型:

```
scripts/
  ingest.ts                # 100行以下: parse argv → discover() → build() ループ → DB 書き込み
  ingest/
    shared.ts              # provider 非依存 utils（preview / hhmmss / lineCount / durationBetween / isCommit / isTest / toolType / toolTitle / parseSubagentUsage / extractChildEvents 等）
    built.ts               # Built / BuiltSession / BuiltEvent / BuiltChangedFile / BuiltHunk / BuiltAttribution / BuiltAnnotation の実型
    pricing.ts             # cost 算出（lib/cost.ts を呼ぶラッパー、必要なら）
    providers/
      types.ts             # interface TranscriptProvider { name: Runner; discover(opts): string[]; build(file, ctx): Built | null }
      claude.ts            # buildSession + extractChildEvents の Claude 特化部分（参考行: 318-758）
      codex.ts             # buildCodexSession + codexLangOf / codexReadPath / codexSkillName / codexHeadCwd / loadCodexTitles / listCodexRollouts（参考行: 760-1020）
```

`scripts/ingest.ts` の最終構造（概念）:

```ts
import { ClaudeProvider } from "./ingest/providers/claude";
import { CodexProvider } from "./ingest/providers/codex";
import type { TranscriptProvider } from "./ingest/providers/types";

const providers: TranscriptProvider[] = [
  new ClaudeProvider(/* env opts */),
  ...(process.env.LATHE_NO_CODEX === "1" ? [] : [new CodexProvider(/* env opts */)]),
];

function main() {
  const db = openDb();
  const built: Built[] = [];
  for (const p of providers) {
    for (const f of p.discover()) {
      const b = p.build(f);
      if (b && b.events.length) built.push(b);
    }
  }
  insertAll(db, built);
  console.log(`[ingest] from ${providers.map(p => p.name).join(" + ")}: sessions=${built.length} …`);
}
```

`interface Built` の実型化:

```ts
// scripts/ingest/built.ts
export interface BuiltSession {
  id: string;
  project: string;
  title: string;
  runner: Runner;
  model: string | null;
  status: 'done' | 'running' | 'failed';
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  turnCount: number;
  toolCount: number;
  editCount: number;
  bashCount: number;
  subagentCount: number;
  errorCount: number;
  tokenUsage: number;
  tokenIn: number;
  tokenOut: number;
  gitBranch: string | null;
  commitCount: number;
  costUsd: number | null;
  summary: string | null;
  seq: number;
  // internal-only for sorting (strip before INSERT)
  _startMs?: number;
}
export interface BuiltEvent { /* db/schema.sql の transcript_events と整合 */ }
export interface BuiltChangedFile { /* changed_files */ }
export interface BuiltHunk { /* diff_hunks */ }
export interface BuiltAttribution { /* attributions */ }
export interface BuiltAnnotation { /* annotations */ }
export interface Built {
  session: BuiltSession;
  events: BuiltEvent[];
  eventFiles: { event_id: string; path: string; role: 'read' | 'edit' | 'write' }[];
  changedFiles: BuiltChangedFile[];
  hunks: BuiltHunk[];
  attributions: BuiltAttribution[];
  annotations: BuiltAnnotation[];
}
```

## Done criteria

- [ ] `scripts/ingest.ts` が**100 行以下**で、provider loop と DB 書き込みに限定されている。
- [ ] `scripts/ingest/providers/claude.ts` と `.../codex.ts` が独立し、それぞれ自分の helper を抱える。
- [ ] `interface Built` の各フィールドが**実型**（`any` ではない）。
- [ ] `scripts/ingest.ts` 配下（旧 `scripts/ingest.ts` を分解した範囲）の `any` 数が **≤ 5**（外部ライブラリ境界の最低限のみ）。
- [ ] `pnpm ingest` がリファクタ前と**同じセッション件数 / 同じイベント数**を出力する（DB 件数で比較。代表セッションの events / changed_files / hunks 件数を 3 セッションで突き合わせる。`sqlite3 data/lathe.db "SELECT count(*) FROM ..."` で OK）。
- [ ] `pnpm coverage` VERDICT **GREEN**（MISSING 0、LIVE のみ）。
- [ ] `pnpm build` PASS。
- [ ] `pnpm e2e` **49/49 GREEN**。
- [ ] commit メッセージ: `[04] split ingest into provider modules and tighten Built type`

## Notes

- **DB スキーマを変えない**。実型は schema と整合させるが、CHECK 制約や列追加はしない。
- `lib/cost.ts` と `db/pricing.json` は touch しない。
- **provider interface** の探索系（`discover`）と組み立て系（`build`）は分ける:
  - `discover(): string[]` — 取り込むべきファイルパスを返す（Claude は `LATHE_TRANSCRIPTS_DIR` の `*.jsonl`、Codex は `~/.codex/sessions/**/rollout-*.jsonl` をフィルタ）。
  - `build(file): Built | null` — 1 ファイル → 1 セッション分の Built。
- env 変数の挙動を**保つ**:
  - `LATHE_TRANSCRIPTS_DIR`（Claude）
  - `LATHE_CODEX_PROJECT` / `LATHE_NO_CODEX`（Codex）
  - `LATHE_MAX_SESSIONS` / `LATHE_MAX_EVENTS` / `LATHE_MAX_FILES` / `LATHE_MAX_HUNK_LINES`
- **検証手順**:
  1. リファクタ前に `sqlite3 data/lathe.db "SELECT count(*) AS n FROM sessions; SELECT runner, count(*) FROM sessions GROUP BY runner; SELECT session_id, count(*) AS n FROM transcript_events GROUP BY session_id ORDER BY n DESC LIMIT 5;"` を控える（PR に貼る）。
  2. リファクタ後に同じ SQL を実行し、**完全一致**を確認。
- 本タスクは依存先 [01]〜[03] **すべて完了後**に着手すること。途中で着手すると共通 utils の場所が二転三転する。
- 完了したら `PROTOTYPE.md` の「次の一歩」セクションを更新（Cursor 対応の前提条件「provider 抽象」を済として明記）。
