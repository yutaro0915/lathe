# Lathe Convergence Plan — 現状 → architecture.md 理想状態

> **status: draft（レビュー用・未 commit）** ／ date: 2026-06-18
> **正本の理想状態**: [architecture.md](architecture.md)（不変条件 I1–I7）。本書は **そこへ収束させる修正計画**。
> **由来**: 多エージェント計画 workflow `wgjwjunci`（13 スライス並列計画 → 統合 → 敵対的検査）。critique verdict = **要修正（条件付き実行可能）**。本書は critique の must-fix を**取り込み済み**。
> **規範**: `rubrics/`（N1–N8 を機械検査・agent-judge 化、merge は run.mjs のみ）/ `rubrics/meta/pr-split`（1 PR=単一責務・<200 LOC・依存順）。

## 0. 安全順序の核（spine）

```
rails(r0a→r0b, r0c∥) → r1 deadcode → r6 e2e 脱結合 → (r2→r3→r5) → (r7 / r8 / r9) → r4 styling → r10 tests
```

理由（critique が実測で裏付け）:
- **e2e の CSS 子孫セレクタ 412 件（getByRole/testid は 1 件のみ）** → r6 で role/testid 化を**先に land**しないと、god-component 分割（r7）と旧クラス削除（r4）で e2e が連鎖崩壊する。
- **`lib/mcp.ts` を 4 スライスが連続編集**（r2→r3→r5→r8）→ single-writer rule で**直列必須**。順序を崩すと型シグネチャ衝突・re-export 欠落で連鎖 RED。

## 1. 順序付き PR スタック（13 スライス → 実 PR 40+）

| seq | slice | phase | size | depends | gate（要点） | 担当 |
|---|---|---|---|---|---|---|
| 1 | r0a-linter | rails | S | — | lint 設定構文 GREEN・I2 違反 warn 検出・grandfather 免除・build/e2e 不変 | 実装 Sonnet / レビュー Codex high |
| 2 | r0b-ci | rails | S | r0a | Actions で tsc+oxlint+depcruise+verify(scratch4)+e2e を gate 化 | 実装 Sonnet / レビュー Codex xhigh |
| 3 | r0c-enforce | rails | S | — | Pre+PostToolUse file-size guard・Stop retro・`.claude/agents` model 配分 | 実装 Sonnet / レビュー Codex xhigh |
| 4 | r1-deadcode | conv | S | — | GlobalNav 削除・`auto` 除去・loading 値; grep0+tsc+build GREEN | 実装 Codex high |
| 5 | r6-e2e-decouple | conv | L | — | role/testid 化+surface 分割; CSS 子孫 locator grep0 | Codex high / 監査 xhigh |
| 6 | r2-dedupe | conv | M | — | 共有ロジック集約; tsc+verify; N1 反証 | Codex high+Sonnet / xhigh |
| 7 | r3-mcp-boundary | conv | M | r2 | `@lathe/domain` 新設・apps/web 依存切; verify:placement | Codex high+Sonnet / xhigh |
| 8 | r5-data-layer | conv | M | r2,r3 | lib/write(**lib/db 呼**)+lib/read; I1 反証=e2e 行動 | Codex high / xhigh |
| 9 | r7-sessionviewer | conv | L | r6 | tab 分割+hook 抽出; max-lines≤500 反証 | Codex high / xhigh / Opus(UI) |
| 10 | r8-analyst-split | conv | M | r2,r5 | domain/adapter/app/smoke 分解; N1/N2/N3 | Codex high / xhigh |
| 11 | r9-diff-findings | conv | M | r5 | Diff/Findings 分割; verdict は lib/write 経由 | Codex high / xhigh / Opus |
| 12 | r4-styling | conv | L | r6 | :root 一本化(**@media 含む**)+旧 class 撤去; e2e GREEN | Codex high+Sonnet |
| 13 | r10-unit-tests | conv | M | r2,r3,r5,r8 | 純粋ロジック unit; N1 反証 | Codex high / xhigh |

**直列鎖**: ① `lib/mcp.ts`: r2→r3→r5→r8 ② `lib/write`: r5→r9 ③ I5→I4: r6→r7・r6→r4 ④ rails: r0a→r0b ⑤ tests home: r2/r3/r5/r8→r10。
**並行可**: r0a ∥ r0c ∥ r1（依存ゼロ・非競合）。r6 は本体リファクタと別系統で並行着手可（ただし r7/r4 より前に land）。

## 2. critique の must-fix（本計画に取り込み済み）

- **[high] I1 強制の再設計**: depcruise は `pg` でなく **`@/lib/postgres`（queryOne/queryRows/getPool）の lib/db・ingest/db 以外からの import を forbidden**にする（route/component/lib/write を捕捉）。生 SQL リテラルは grep/oxlint backstop。r5/r9 の **I1 反証ゲートは depcruise でなく e2e 行動（verdict が DB に書かれる）を一次根拠**にする。architecture.md §5 I1 を訂正済み。
- **[high] lib/write は生 SQL を持たない**: verdict/finding command は **lib/db（Adapter）の関数を呼ぶ**。「route の SQL を lib/write へ移すだけ」では I1 違反の移送になるため不可。architecture.md I1 に忠実化（生 SQL は lib/db・ingest/db のみ）。
- **[high] r4 の :root 棚卸しを @media まで拡張**: `globals.css:783` の `@media(max-width:1200px)` 内 `:root`（--aside-w:296 / --sidebar-w:248）を見落とさない。responsive token を tokens.css へ移植し、gate を「tokens.css 以外の全 .css で :root マッチ 0（媒体クエリ内含む）」に強化＋≤1200px グリッド幅の screenshot 反証。
- **[med] home 二重確定の解消**: `stableJson`/`parseStoredAnalysis` の最終 home を**最初から `@lathe/domain`** とする。**r2 は finding-locator(UI) と langOf/withScratch(server) の dedup のみ**に縮小、stableJson/parseStoredAnalysis 集約は r3 に一本化（型統一を 1 回で）。
- **[med] スライス ID 正準化**: 全 detail の dependsOn を正準 ID に統一（r10 の `r2-domain-extraction` 等、r0b の委譲先誤記を修正）。
- **[med] analyst getPool の正確化**: lib 経由化は backfill(1368) の 1 件。smoke の getPool 14 件は test harness として grandfather、`scripts/` は I1 機械強制対象外と明記（過大表現しない）。
- **[med] file-size-guard を新規ファイル対応に**: `tool_input` の content 行数を数える＋PostToolUse でも実ファイル行数で判定（501 行新規 Write が exit 2 になる反証を gate 化）。
- **[low] `.claude/agents` の model 名検証**: 着手第一歩で有効値を確認（claude-api / Claude Code agent 仕様）。無効なら有効 alias に置換。
- **[low] r2 withScratch は「正本化（canonicalization）」**: 純粋 dedup でなく挙動が verify-subagents 版に寄る可能性。teardown 後の `DATABASE_URL` 復元を assert する gate を追加。

## 3. 決定事項（architecture.md に忠実化・redline 可）

- **D1: `lib/write` は生 SQL を持たず lib/db を呼ぶ**（I1 をそのまま守る）。← architecture.md の通り。代替（I1 を改訂し lib/write を SQL 許可面に昇格）は採らない。
- **D2: e2e の `*.spec.ts` は max-lines を 800 に緩和**（I4 から完全免除はしない）。新 surface spec（sessions ~724 / findings ~585）が 500 を超えるため。テスト肥大は別途抑制。

## 4. 未カバー＝後続スライス（捏造で「網羅」と言わない）

13 スライスでは I1–I6 を網羅するが、以下は**含まれない欠落**として明示する（critique・統合の missingInvariants 一致）:

- **r11-input-typeguard（I7）**: transcript パース界面の `LooseRecord`（`Record<string,any>`）撤去・型ガード。tsc strict では検出されないため専用スライスが必要。
- **lib/db.ts(1612) の I4 完全分割**: r5 は lib/read を facade として新設するのみ。read model 実体化スライスが別途必要。
- **FindingsExplorer ≤500 完全収束**: r9 は ≤850 まで。残（Evidence カード群）の最終収束スライスが別途必要。
- **e2e surface spec 自体の I4**: D2 で 800 に緩和して扱う（上記）。

## 5. 実行（Claude + Codex 連携）

- **役割**: 計画/レビュー/統合=Opus。実装=Sonnet・Codex 5.5 high。UI=Opus。Tier A 監査=Codex 5.5 xhigh。各 slice の担当列に従う。
- **Codex 実行**: 隔離 worktree + scratch DB で `/goal` loop（`-a never -s danger-full-access`）。goal 文に **該当 rubric の pass_to_task + 当該 slice の gate + N1 反証（壊して RED→戻して GREEN）+ rubrics/ を変えない(N4)** を明記。`skills/lathe-loop` が運用正本。
- **single-writer**: `lib/mcp.ts` の直列鎖（r2→r3→r5→r8）は同時編集しない。各 sub-PR は tsc+oxlint+depcruise+verify(scratch)+e2e を GREEN にしてから次へ。
- **着手順**: §0 spine のとおり。各 slice 着手時に `tasks/<NN>-<slice>.md` を起こす。
