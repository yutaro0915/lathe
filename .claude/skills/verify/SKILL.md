---
name: verify
description: 変更を独立検証して GREEN/RED + evidence を返す不変手順。影響クラスに応じて gate(run.mjs)・unit・storybook・e2e を回す。verifier agent が従う。何を満たすべきか（基準）は rubric 側＝ここに inline しない。
---

# verify — 変更の独立検証（不変手順）

verifier agent がこれに従う。**read-only**（コードを編集しない・git を触らない。検証だけ）。
ここに置くのは**変わらないコマンドと手順**だけ。「どの rubric を満たすか」は run.mjs が決める＝列挙しない。

## 入力
- 変更パス一覧（implementer の diff から。例 `apps/web/design-system/...`）。

## 手順（単一入口 `pnpm preflight` ・影響層だけ自動で回る）
1. **preflight（集約入口）**: `pnpm preflight --full`
   - git から変更パスを検出し、**該当する層だけ**回す: gate(`run.mjs --changed`) ＋ tsc ＋ unit(`pnpm test`) ＋ scope 該当の integration(`verify:incremental` 等) ＋ storybook(design-system / `*.stories.tsx` 変更時)。e2e は gate 内の render-layout-integrity が UI 変更時に発火（cold は P1 flake＝warm 再実行。test-failure-playbook）。
   - `--full`＝codex judge も e2e も回す（merge gate）。`--fast`（Stop hook 用）は judge/e2e を外した即応版。
   - **コマンドは preflight に集約**＝層ごとに打ち直さない。各層が何を見るかは下記の意味を参照。
2. preflight が落ちた層の evidence を読む: gate の RED check（数値）／ tsc の本質エラー数行 ／ test fail。
- 追加 spec が要る時だけ `pnpm -C apps/web exec playwright test <spec>` を warm で。
- build/起動確認の重い部分は preflight の `--full` ／ Stop hook（`--fast`）が持つ。

## 出力（必ずこの形・これだけ返す）
- 各 check: `GREEN` / `RED` ＋ evidence（数値・最初の本質エラー数行）。
- 総合: GREEN（全該当 pass）／ RED（RED の check 一覧）。
- **RED は診断しない**。`RED: <check> — <evidence>` をそのまま返し、test-triage に渡す（既知/新規の切り分けは triage の仕事）。

## 不変の前提（変わらない＝skill に置いてよい）
- gate の唯一の集約口は `node rubrics/run.mjs --changed`（どの rubric を回すかは run.mjs が決定）。
- unit=`pnpm test` / storybook=`pnpm -C apps/web test-storybook` / e2e=`playwright test`。
- 検証は read-only。コード編集・git 操作をしない。
（これらのコマンドが実在することは rubric `meta/verify-commands-exist` が機械保証する＝skill のドリフト防止。）
