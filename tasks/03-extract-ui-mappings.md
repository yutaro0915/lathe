---
id: 03
title: Extract UI mappings (RUNNER_LABEL, EVENT_LABEL, EVENT_COLOR, TYPE_GLYPH) into lib/event-display.ts and lib/runner-display.ts
status: todo
assignee: codex
depends_on: []
estimated: small
---

## What

UI に展示する**ラベル / 色 / グリフ**の mapping を 2 ファイルに集約し、各 component から import に置き換える。

- `lib/runner-display.ts` — `RUNNER_LABEL` の唯一の正本（現在 3 箇所コピー）。
- `lib/event-display.ts` — `EVENT_LABEL` / `EVENT_COLOR` / `TYPE_GLYPH` / `TYPE_LABEL` の唯一の正本（現在 2〜1 箇所）。

## Why

[REFACTOR-PLAN.md](../REFACTOR-PLAN.md) の「主な問題 2」参照。**Cursor を Runner として足すと最低 3 箇所同期**になる。本タスクで集約しておけば Cursor 対応のとき 1 箇所更新で済む。

## Input

- `components/SessionViewer.tsx` — `RUNNER_LABEL` / `TYPE_GLYPH` / `TYPE_LABEL` の定義あり。
- `components/DiffViewer.tsx` — `RUNNER_LABEL` あり（型が `Record<string, string>` でゆるい点に注意）。
- `components/StatsView.tsx` — `EVENT_COLOR` / `EVENT_LABEL` あり。
- `components/SessionStatsView.tsx` — `EVENT_COLOR` / `EVENT_LABEL` あり。
- `components/SessionSidebar.tsx` — **[01] で削除済み**の想定。残っていたら無視。
- 既存定義は `git grep -nE "^const (RUNNER_LABEL|EVENT_COLOR|EVENT_LABEL|TYPE_GLYPH|TYPE_LABEL)"` で確認可。

## Output

新規:

- `lib/runner-display.ts`:
  ```ts
  import type { Runner } from "@/lib/types";
  export const RUNNER_LABEL: Record<Runner, string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
  };
  ```
- `lib/event-display.ts`:
  ```ts
  import type { EventType } from "@/lib/types";
  export const EVENT_LABEL: Record<EventType, string> = { /* SessionStatsView 版を正にする */ };
  export const EVENT_COLOR: Record<EventType, string> = { /* SessionStatsView 版を正にする */ };
  export const TYPE_GLYPH: Record<EventType, string> = { /* SessionViewer の既存定義をそのまま */ };
  export const TYPE_LABEL: Record<EventType, string> = { /* SessionViewer の既存定義 */ };
  ```
  - **`EVENT_LABEL`** が SessionViewer の `TYPE_LABEL` と意味的に重複している場合は、**先に diff を確認**。同一なら `TYPE_LABEL` を `EVENT_LABEL` に統合（エイリアス export してもよい）。差異があれば PR 説明欄で明示。

編集:

- 上記 4 component（`SessionViewer / DiffViewer / StatsView / SessionStatsView`）から該当 `const` 定義を削除し、`import { RUNNER_LABEL } from "@/lib/runner-display"` などに置き換える。

## Done criteria

- [ ] `git grep -nE "^const (RUNNER_LABEL|EVENT_COLOR|EVENT_LABEL|TYPE_GLYPH|TYPE_LABEL) =" components/` が **0 件**。
- [ ] `lib/runner-display.ts` と `lib/event-display.ts` がそれぞれ 1 箇所のみ定義を持つ。
- [ ] `Record<Runner, string>` / `Record<EventType, string>` の**型強化**を入れる（`Record<string, string>` で逃げない）。
- [ ] `pnpm build` PASS。
- [ ] `pnpm e2e` **49/49 GREEN**。
- [ ] commit メッセージ: `[03] extract runner and event display mappings into lib/`

## Notes

- DiffViewer は `Record<string, string>` で逃げているので、移行後は `Record<Runner, string>` に**型を強める**。コンパイラが未知の Runner キーを検出できる状態が望ましい。
- `EVENT_COLOR` は **CSS 変数ではなく hex 直書き** で運ばれている（`#64748b` 等）。本タスクではそのまま運ぶ（CSS 変数化は別 sprint）。
- 旧 `TYPE_LABEL` / 新 `EVENT_LABEL` の名前差はユーザーの好みで決まる。**`EVENT_LABEL` に統一を推奨**（型名 `EventType` と整合）。`TYPE_LABEL` を残す場合はエイリアス export しない（参照箇所が増える）。
- このタスクは [01] と**並列実行可能**だが、[02] と同じ files を触るため、[02] の前後どちらかで完結させる。**PR は別**で出すこと。
