---
title: Lathe Phase 1 — Refactor Plan
status: in-progress
owner: yutaro0915
assignee: codex
created: 2026-06-07
updated: 2026-06-07
---

# Lathe Phase 1 — Refactor Plan

## Goal

Phase 1 のコードを **Cursor 対応 / Phase 2 着手の前に整地する**。観測機能（[PROTOTYPE.md](./PROTOTYPE.md) 参照）と UI ふるまいは **一切変えない**。リスクの低い純粋移動から段階的に進める。

## Why

`projects/lathe/REFACTOR-PLAN.md` を起こした直接の動機は3点:

1. **共有 utils が 6 ファイルにコピペ散乱**（`fmtInt` × 5 / `fmtCompact` × 4 / `fmtCost` × 4 / `humanizeDuration` と `fmtDuration` 名前不統一で5 / `shortModel` × 3 / `basename` × 2 / `parseStamp` × 1）。
2. **UI mapping が独立コピー**: `RUNNER_LABEL` × 3（SessionViewer / DiffViewer / SessionSidebar）、`EVENT_COLOR` / `EVENT_LABEL` × 2、`TYPE_GLYPH` / `TYPE_LABEL` × 1。Cursor を 4 つ目の Runner として足すと**最低 3 箇所同期**になる。
3. **Provider 抽象がゼロ**: `scripts/ingest.ts`（1134 行）= 共通 utils + Claude 用 `buildSession`（440 行）+ Codex 用 `buildCodexSession`（260 行）+ `main` を **1 ファイルにべた書き**。`interface Built` は `session: any; events: any[]; ...` で**全部 `any`**。`any` × 41。Cursor を同じ流儀で追加すると崩壊する。

合わせて死んでいるコードがある:

- `components/SessionSidebar.tsx`（167 行）: import 元なし。OverviewView は自前で `<aside class="sidebar">` を書いている。
- `db/seed.ts`（1139 行）: 実テスト・e2e から参照ゼロ。`pnpm seed` だけが呼ぶ。実 transcript の `pnpm ingest` で十分。

## Non-goals

- **UI ふるまい / レイアウト / 操作感を変えない**（pixel level の見た目変更も避ける、CSS class 名は維持）。
- **observable な API（URL クエリ / route 構造 / DB スキーマ）を変えない**。
- **観測機能を増やさない / 減らさない**（Cursor 対応も Phase 2 機能も含めない）。
- **`db/schema.sql` を変えない**（Built 型の実型化はスキーマと別物）。

## Constraints

- Node 24（`pnpm dev` / `pnpm build`）、`node:sqlite`、Next.js 15。
- `data/lathe.db` は再生成物（gitignored）。スクリプト変更後は `pnpm ingest` で再生成する。
- 同一ファイルを 2 agent が同時編集しない（single-writer）。Codex 稼働中、Claude はこの repo 内ファイルを編集しない（追加は OK）。
- UI 変更を伴うときは dev サーバ起動（port 3210）状態でユーザーに確認を投げる。

## Success criteria

各タスクの DoD を満たし、最終状態で:

- `pnpm build` — 型チェック含めて PASS。
- `pnpm coverage` — VERDICT GREEN（再 ingest 後）。
- `pnpm e2e` — **49/49 GREEN**（現在の本数）。テスト本文は本リファクタでは原則変更しない（DOM セレクタを壊さないため）。
- 重複 utils が `lib/format.ts` に集約され、各 component の重複定義が消えている。
- UI mapping が `lib/event-display.ts` / `lib/runner-display.ts` に集約されている。
- `scripts/ingest.ts` のべた書きが provider 別ファイルに分解され、`Built` 型の `any` が消えている。
- 死んだコードが削除されている。
- `scripts/ingest.ts` の `any` 数が **41 → ≤ 5**、`components/SessionViewer.tsx` の行数が **1807 → 維持可**（Tier 4 は別 sprint）。

## Task DAG（依存関係）

```
[01] dead code 削除 ──┐
                       ├──→ [02] format utils 抽出 ──┐
[03] UI mapping 抽出 ──┘                              ├──→ [04] provider 抽象 + 型強化
                                                      │
                                                  （Tier 4 SessionViewer 分解は別 sprint。本 plan のスコープ外）
```

- **[01]** と **[03]** は **独立**（並列可）。
- **[02]** は **[01]** と **[03]** 完了後に開始（影響範囲を最小化するため、dead code と mapping が抜けた状態で utils 統合する方が diff が読みやすい）。
- **[04]** は **[01]〜[03]** 完了後に開始（provider 分解中に共通 utils を移動すると衝突する）。

Codex 稼働パターン:

| パターン | 順序 |
|---|---|
| 直列（推奨、安全） | [01] → [03] → [02] → [04] |
| 半並列（高速、衝突注意） | ([01] ∥ [03]) → [02] → [04]。ただし両方が `components/` を触るので別 PR で出すこと |

## タスク一覧

- [tasks/01-remove-dead-code.md](./tasks/01-remove-dead-code.md) — small
- [tasks/02-extract-format-utils.md](./tasks/02-extract-format-utils.md) — medium
- [tasks/03-extract-ui-mappings.md](./tasks/03-extract-ui-mappings.md) — small
- [tasks/04-provider-abstraction.md](./tasks/04-provider-abstraction.md) — large

進捗は [status.md](./status.md)。

## 不変条件（Invariants — どのタスクでも守る）

1. **`pnpm e2e` の本文を変更しない**。テストが落ちたら**実装側**を直す（DOM 構造・CSS class 名を変えない方針）。
2. **公開 export を変えない**: `lib/db.ts` の `getSessionBundle / listSessions / getStats / getSessionEventCounts / getPrimarySession` の関数名・引数・返り値型。
3. **URL ルート不変**: `/`, `/diff`, `/stats`, `/overview` および `?session=`, `?tab=`, `?focusEvent=` 等のクエリ仕様。
4. **DB スキーマ不変**（`db/schema.sql` を触らない）。
5. **`db/pricing.json` のキー不変**（LiteLLM 由来）。
6. **dev サーバを起動した状態でユーザーに確認を投げる**（本 repo の規約、[memory/USER.md](../../memory/USER.md) 参照）。

## 既知の落とし穴

- **`.next` 衝突**: `pnpm dev` 稼働中に `pnpm build` を走らせると `webpack-runtime.js` の cannot find module が出る。build/e2e の前に dev を止める（`preview_stop` または `kill $(lsof -ti tcp:3210)`）。
- **node:sqlite ExperimentalWarning**: ingest/coverage 実行時の warning は無視可。
- **coverage RED の解釈**: MISSING/DROPPED は実装由来ではなく、ingest以降に新規 transcript が出来た DB 鮮度の問題が多い。`pnpm ingest` 後に再確認する。LIVE は書き込み中で正常。
- **e2e のセッション ID ハードコード**: `33a47290-…` / `da2ac032-…` / `144d8b23-…` / `019e9d30-…` などが固定。実機の transcript が前提なので、本 repo の clone 環境では取れない。本 plan の検証は **私（ユーザー）の手元の transcript** が ingest されている前提で進める。

## commit message 規約

- task ベース: `[<NN>] <subject>` 例: `[01] remove dead SessionSidebar and seed script`
- 形式: `[01] <verb in imperative> <object>`（subject 50 文字以内）
- 本リファクタは observable な変更を出さないため、commit 群を 1 PR に束ね、PR タイトルで「refactor(phase1): ...」と切るのが望ましい。

## 出口（このリファクタが終わったら）

1. **PROTOTYPE.md** の「次の一歩」セクションを更新（Cursor 対応の前提条件「provider 抽象」が完了したことを反映）。
2. **status.md** を `current_owner: none` に戻す。
3. 次の sprint で:
   - Tier 4（SessionViewer 分解 1807 行 → hooks + sub-components）
   - その後、Cursor 取り込みの実装（`scripts/ingest/providers/cursor.ts` を1個追加）
