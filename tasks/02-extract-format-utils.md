---
id: 02
title: Extract shared format utilities into lib/format.ts
status: todo
assignee: codex
depends_on: [01, 03]
estimated: medium
---

## What

6 つの component / lib に散らばっている fmt 系 / 日時系 / 文字列系の純関数を `lib/format.ts` に**唯一の正本**として集約し、各 component から import に置き換える。**挙動を変えない**（中身は同じ実装を1箇所にまとめるだけ）。

## Why

[REFACTOR-PLAN.md](../REFACTOR-PLAN.md) の「主な問題 1」参照。現状の重複定義:

| 関数 | 重複箇所数 |
|---|---:|
| `fmtInt` | 5（SessionViewer, DiffViewer, StatsView, SessionStatsView, OverviewView） |
| `fmtCompact` | 4（同上から OverviewView 含む 4 箇所） |
| `fmtCost` | 4 |
| `humanizeDuration` / `fmtDuration` / `fmtLatency` | 5（名前が統一されていない） |
| `shortModel` | 3 |
| `basename` | 2 |
| `parseStamp` | 1（SessionViewer のみ。今後の再利用のため一緒に移動） |
| `fmtTok` | 3 |

加えて `TimeRibbon.tsx` の `fmtDur(sec)` は単位が**秒**で別系統。命名から `fmtDurationSec` 等にして混乱しないようにする。

## Input

- `components/SessionViewer.tsx`
- `components/DiffViewer.tsx`
- `components/StatsView.tsx`
- `components/SessionStatsView.tsx`
- `components/OverviewView.tsx`
- `components/TimeRibbon.tsx`
- 比較対象として `git log -p` で各定義の中身が**同一**であることを必ず確認すること。微妙に違う実装が紛れている可能性がある（特に `humanizeDuration` と `fmtDuration` の境界）。差分がある場合は **PR 説明欄で明示** し、より厳密な実装を採用する（例: null 対応、桁丸め）。

## Output

新規:

- `lib/format.ts` に下記を export（実装はいずれか既存版から採用、差異あれば最も安全な実装に統合）:
  - `fmtInt(n: number): string` — `"1,234,567"`
  - `fmtCompact(n: number): string` — `"1.2K" / "1.2M"`
  - `fmtTok(n: number): string` — `"12.4K"`（fmtCompact と挙動同等ならエイリアスにする）
  - `fmtCost(c: number | null): string` — `"$1.23" / "<$0.01" / "—"`
  - `fmtDuration(ms: number | null): string` — `"2h 47m" / "31m" / "—"`
  - `fmtLatency(ms: number | null): string` — `"1.23s" / fmtDuration へ fallback`
  - `humanizeDuration(ms: number | null): string` — sidebar 用 `"1h 5m" / "5m 30s" / "30s" / "—"`
  - `shortModel(m: string | null | undefined): string` — `"claude-" prefix を剥がす`
  - `basename(p: string): string`
  - `parseStamp(s: string): { date: string; time: string }`
  - `fmtDurationSec(sec: number): string` — TimeRibbon 用（秒入力）

編集:

- 上記 6 ファイルから対応する `function fmtXxx(...)` の**ローカル定義を削除**し、`import { fmtXxx, ... } from "@/lib/format"` に置き換える。

## Done criteria

- [ ] `git grep -nE "^function fmtInt|^function fmtCompact|^function fmtCost|^function fmtTok|^function fmtDuration|^function fmtLatency|^function humanizeDuration|^function shortModel|^function basename\\(p:|^function parseStamp"` が **`lib/format.ts` 内のみ**（6 component で 0 件）。
- [ ] `lib/format.ts` の各関数に 1〜2 行 JSDoc（既存コメントを集約）。
- [ ] `pnpm build` PASS。
- [ ] `pnpm e2e` **49/49 GREEN**。
- [ ] commit メッセージ: `[02] extract shared format utils into lib/format.ts`

## Notes

- **挙動を変えない**: `fmtCompact(999)` が `"999"` でも `"999.0"` でも、**既存と同じ**にする。中身を統合するときに丸めや null 動作を変えないこと（テストで暗黙に依存している可能性）。
- 既存実装に**差異がある場合**は、PR 説明欄に「採用した実装と理由」を 1〜3 行書く。具体的には:
  - `humanizeDuration` の **秒以下の挙動**（"30s" vs "0m 30s"）
  - `fmtCost` の **0 と null の区別**（`"—"` vs `"$0.00"`）
  - `fmtCompact` の **桁丸め**（`Math.round` vs `toFixed(1)`）
- import 順序は既存スタイル（`@/...` で alias 経由）。
- **CSS / DOM / e2e セレクタを触らない**。
- このタスクは [01]（dead code 削除）と [03]（UI mapping 抽出）の**後に着手**する。前者は影響範囲を減らし、後者は components の編集衝突を避ける。
