---
name: verify
description: 変更を独立検証して GREEN/RED + evidence を返す不変手順。影響クラスに応じて gate(run.mjs)・unit・storybook・e2e を回す。verifier agent が従う。何を満たすべきか（基準）は rubric 側＝ここに inline しない。
---

# verify — 変更の独立検証（不変手順）

verifier agent がこれに従う。**read-only**（コードを編集しない・git を触らない。検証だけ）。
ここに置くのは**変わらないコマンドと手順**だけ。「どの rubric を満たすか」は run.mjs が決める＝列挙しない。

## 入力
- 変更パス一覧（implementer の diff から。例 `apps/web/design-system/...`）。

## 手順（単一入口 `pnpm preflight`・全検証は scoped+tiered rubric / run.mjs が唯一のエンジン）
1. **検証は run.mjs 一本**: 変更を覆う scope の rubric が発火し、**tier**（cmd < test < heavy）で深さを絞る。gate の cmd・tsc・unit・e2e・storybook・ingest integration・codex judge は**すべて rubric**（run.mjs が回す。scope＝どれを / tier＝どこまで）。
2. **preflight は tier を選ぶ薄いラッパ**: `pnpm preflight --full`（tier=heavy＝e2e/storybook/integration/judge 込み・**merge gate**）／`--fast`（tier=test＝＋tsc＋unit）／`--quick`（tier=cmd＝即時・Stop hook が使用）。コマンドはこの一本＝層ごとに打ち直さない。
3. RED の層の evidence を読む: gate の RED check（数値）／ tsc の本質エラー／ test fail。cold e2e は warm 再実行で切り分け（playbook P1）。
- 追加 spec が要る時だけ `pnpm -C apps/web exec playwright test <spec>` を warm で。
- build/起動の重い検証は `--full`（heavy）が持つ。

## 出力（必ずこの形・これだけ返す）
- 各 check: `GREEN` / `RED` ＋ evidence（数値・最初の本質エラー数行）。
- 総合: GREEN（全該当 pass）／ RED（RED の check 一覧）。
- **RED は診断しない**。`RED: <check> — <evidence>` をそのまま返し、test-triage に渡す（既知/新規の切り分けは triage の仕事）。

## 不変の前提（変わらない＝skill に置いてよい）
- gate の唯一の集約口は `node rubrics/run.mjs --changed`（どの rubric を回すかは run.mjs が決定）。
- unit=`pnpm test` / storybook=`pnpm -C apps/web test-storybook` / e2e=`playwright test`。
- 検証は read-only。コード編集・git 操作をしない。
（これらのコマンドが実在することは rubric `meta/verify-commands-exist` が機械保証する＝skill のドリフト防止。）
