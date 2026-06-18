---
id: 34
title: r9-diff-findings — DiffViewer / FindingsExplorer 分割 (I4)。r5/r6 後
status: done
workflow: loop
audit: A
estimated: medium
bound: 30 turns
depends_on: [r5, r6]
assignee: codex
---
## What
design/convergence-plan.md r9。DiffViewer.tsx(1280) を standalone/embedded 分離、FindingsExplorer.tsx(1030) を整理。**挙動・見た目不変**。

## 前提
- verdict コマンドは r5 の lib/write(recordFindingVerdict/undoFindingVerdict) が home。新たに生 SQL を持たない。
- e2e は testid/aria に脱結合済み。壊さない。

## 受け入れ条件(全 GREEN まで継続)
1. DiffViewer を standalone/embedded に分離(各 ≤500 行目標)。FindingsExplorer を整理(本スライスは ≤850 まで可、≤500 完全収束は後続スライスへ繰り越し明記)。**新規ファイルは ≤500**。
2. verdict 系は lib/write 経由(生 SQL を component/route に持たない=I1)。
3. e2e: scratch DB で playwright **全 GREEN**(Diff/Findings 関連含む)。
4. tsc GREEN / build GREEN。**merge 前ゲート** `node rubrics/run.mjs --changed <変更path...>` exit 0。
## やらないこと
- SessionViewer 分割(r7)・スタイル(r4)・機能変更。
## 後続
- FindingsExplorer は本スライスで 846 行まで縮小。≤500 の完全収束は Evidence カード群 / verdict controls の追加分割スライスへ繰り越す。
## norms
design/engineering-norms.md N1–N8。最初に pnpm install。全 GREEN + git commit([r9]) まで継続。push/merge しない。
