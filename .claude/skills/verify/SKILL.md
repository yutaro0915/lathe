---
name: verify
description: 変更を独立検証して GREEN/RED + evidence を返す不変手順。影響クラスに応じて gate(run.mjs)・unit・storybook・e2e を回す。verifier agent が従う。何を満たすべきか（基準）は rubric 側＝ここに inline しない。
---

# verify — 変更の独立検証（不変手順）

verifier agent がこれに従う。**read-only**（コードを編集しない・git を触らない。検証だけ）。
ここに置くのは**変わらないコマンドと手順**だけ。「どの rubric を満たすか」は run.mjs が決める＝列挙しない。

## 入力
- 変更パス一覧（implementer の diff から。例 `apps/web/design-system/...`）。

## 手順（影響クラスに応じて該当だけ・全部はやらない）
1. **gate**: `node rubrics/run.mjs --changed <変更パス...>`
   - run.mjs が scope で該当 rubric を自動選別。各 check の GREEN/RED と数値を読む。
2. **unit test**（packages / apps/web の lib・components・scripts のロジックが変わった時）: `pnpm test`
3. **storybook test**（design-system / `*.stories.tsx` が変わった時）: `pnpm -C apps/web test-storybook`
4. **e2e**（app/components の UI 挙動が変わった時）: 通常は run.mjs の render-layout-integrity が `layout-integrity.spec` を回す。
   追加 spec が要る時だけ `pnpm -C apps/web exec playwright test <spec>`。**warm で測る**（初回 cold は P1 flake＝再実行。詳細は test-failure-playbook）。
- build/起動確認は preflight（Stop hook）が持つ。ここでは扱わない。

## 出力（必ずこの形・これだけ返す）
- 各 check: `GREEN` / `RED` ＋ evidence（数値・最初の本質エラー数行）。
- 総合: GREEN（全該当 pass）／ RED（RED の check 一覧）。
- **RED は診断しない**。`RED: <check> — <evidence>` をそのまま返し、test-triage に渡す（既知/新規の切り分けは triage の仕事）。

## 不変の前提（変わらない＝skill に置いてよい）
- gate の唯一の集約口は `node rubrics/run.mjs --changed`（どの rubric を回すかは run.mjs が決定）。
- unit=`pnpm test` / storybook=`pnpm -C apps/web test-storybook` / e2e=`playwright test`。
- 検証は read-only。コード編集・git 操作をしない。
（これらのコマンドが実在することは rubric `meta/verify-commands-exist` が機械保証する＝skill のドリフト防止。）
