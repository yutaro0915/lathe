# Agent Workflow — lathe の変更を回す開発フロー（正本）

> status: revised 2026-07-01（**outer loop / inner loop の二層**に整理。旧「OPUS」表記は**モデル名の役割への誤用**なので役割名へ改めた）
> **二つのループ**（model ⟂ role。**opus はモデル名であって役割名ではない**＝ADR 0005 / 0009「agent をエンティティ化しない・runner/model は記録属性」）:
> - **outer loop（監督の役割）**: Lathe で開発全体を **meta-audit（監視）→ 問題を issue 化 → inner loop へ渡す**。**rubric を管理**し、品質問題を rubric に落とす。inner からの**エスカレーション**（設計判断・詰まり）を rubric との関係で捌く。**実装・調査・review・verify・merge・grep はしない**。詳細分解（family: 感知診断=meta-loop / ACT / 前進 / 検証の 4 系統・meta-loop の to-be・監査プロファイル）は [outer-loop-family.md](./outer-loop-family.md)（2026-07-04）。
> - **inner loop（1 issue の実装ループ）**: named agent が **PLAN → RESEARCH → IMPLEMENT → REVIEW → VERIFY →（RED なら test-triage）→ MERGE（`scripts/merge.mjs` receipt ゲート）** を回し **自律で完走**。設計判断・詰まりだけ outer へエスカレーション。
>
> **なぜ二層を分けるか**: outer と inner を 1 セッションに混ぜると、履歴が絡んで meta-audit が効かず・どの段が悪いか検証できず・フローが安定しない（2026-07-01 の反省: outer が inner の research/plan/review/verify に手を突っ込んで二層を潰した）。**別ループ・別セッション**にすれば、各 inner loop は綺麗な単一セッション（meta-audit 可能）に、outer loop は綺麗な監視ログになる。

## inner loop のフロー（1 issue あたり。rigor は影響クラスでスケール＝小変更は段を飛ばす）

| # | 段 | 担当 / model | 役割 |
|---|---|---|---|
| 0 | PLAN | planner / opus | issue の scope から evidence 付き計画。**設計判断は outer へエスカレーション** |
| 1 | RESEARCH | researcher / haiku ×並列 | code+docs から事実・制約（read-only） |
| 2 | IMPLEMENT | implementer / sonnet | 計画通り実装。**worktree・着手前に main へ rebase（stale base 回避）・uncommitted で残す** |
| 3 | REVIEW | reviewer / sonnet | 設計遵守・抜け・risk → **review receipt** |
| 4 | VERIFY | verifier / sonnet | 影響クラスの gate/test を独立実行 → GREEN/RED＋evidence → **verify receipt** |
|   | ↳ RED | test-triage / sonnet (read-only) | playbook＋git で既知/新規。既知=対処、新規のみ evidence＋仮説で outer へ |
| 5 | MERGE | `scripts/merge.mjs`（ゲート） | branch tip の review=PASS＋verify=GREEN receipt を機械強制＋backstop で gate 再実行してから **squash 取り込み** |

inner loop は merge.mjs のゲートで自律完走する。receipt が無ければ merge できず（`.claude/hooks/git-guard.mjs` が main への raw merge/cherry-pick/コード commit を block）、**誰も（outer loop も）review/verify を飛ばして merge できない**。

**outer loop の責務** = 監視（meta-audit）／ issue 起票 ／ rubric 管理 ／ エスカレーション対応。**inner の各段（research/plan/review/verify/merge）に介入しない**。

## 知識の置き場（最重要原則）

| 性質 | 置き場 | 例 |
|---|---|---|
| 不変・証明済み・再利用可能な手順 | **Skill** | `pnpm dev`、no-git 規律、ワークフローの形、行動規則 |
| 正しさが変動する・複雑な基準 | **Rubric**（skill から参照・inline 禁止） | どのコマンドで何を満たすか。agent が読んで判定 |
| コードに在る事実 | 書かない（調査で発見） | 実装詳細・現状構造 |
| イベント時の強制 | **Hook** | session 終了の preflight 等 |

理由: skill は**検証が難しい層**だから不変だけ置く。変動は**検証できる層（rubric=gate）**に預ける。
skill は滅多に変えない（手順がより効率的と判明した等の時だけ、meta-audit 経由で outer loop 承認）。
**「どの rubric を参照するか」も skill に書かない** → 後述 impact→rubric policy が与える。

## agent × skill（不変手順）× 参照 rubric（変動）

| agent | model | skill | 参照 rubric |
|---|---|---|---|
| researcher | Haiku | disciplined-research（調査→枠組み / existence proof / 実装網羅の問い） | —（発見） |
| planner | opus | 計画手順（research 統合 → evidence 付き → 承認） | 影響クラスの必須 rubric ＋ design docs |
| implementer | Sonnet | 実装手順（計画遵守・周辺コード踏襲・no-git・uncommitted・不変コマンド） | 影響クラスの rubric |
| reviewer | Sonnet | review 観点（設計遵守・抜け・risk） | 同 rubric ＋ plan |
| verifier | Sonnet | verify 手順（`node rubrics/run.mjs --changed …` の回し方・build/test の不変コマンド・GREEN/RED＋evidence） | run.mjs が発火させる rubric |
| test-triage | Sonnet (read-only) | triage 手順（playbook → git → 既知/新規） | `design/test-failure-playbook.md`（成長する知識） |
| meta-auditor | opus | audit 観点（rubric 化点 / loop・stall / 効率化） | 全 rubric ＋ やり取り |

現状（2026-06-25 更新）: **作成済** researcher / planner / implementer / verifier ＋ reviewer / test-triage / meta-auditor（後 3 者は authoring 済・次セッションから invocable）。skill は `lathe-ui` / `verify` / `review` / `test-triage` / `meta-audit`。

## 構築方針 — skill と rubric は一緒に作る

skill と rubric は**結合**している（skill はどの rubric を参照するかで意味が決まり、rubric は skill から呼ばれて回る）。
よって **capability 単位で skill ＋ 参照 rubric（＋必要なら agent 定義）を一緒に**作る ── 「全 skill → 全 rubric」のような
分離フェーズにしない。当面は Eval を rubric で構成せず、**agent が該当 rubric を直接参照して満たすか判定**する
（Eval-from-rubrics は後回し）。

## 構築の順序（このフロー自体を手作りで段階構築）

1. **枠組み（本書）** ★今ここ
2. capability を 1 つずつ（skill ＋ 参照 rubric ＋ 必要なら agent を一緒に）。**verify 系から**
   （outer loop の手作業 gate 監査を最初に肩代わりさせる価値が高い）。
3. impact→rubric policy（最小版・影響クラス → 満たすべき rubric）
4. command 集約 ＋ preflight ＋ Stop hook（build/test を一箇所に、session 終了で走らせる）
5. **（構築後）build/起動確認** を preflight で炙る ← build 確認はここ（最後）

各ステップは outer loop＋人間で 1 つずつ・目の届く範囲で。調査が要る所だけ haiku に出す。

## 保留 / メモ
- Eval を rubric で構成: 後（今は agent が rubric を直接参照）。
- 呼称: 実装担当エージェントは一般名で記す（具体ツール名は書かない）。← hub memory 化予定。
- handoff: implementer は uncommitted で残し commit/merge は inner loop の `merge.mjs` ゲート。verifier は GREEN/RED＋evidence。RED は test-triage 先行。

## Build status & 引き継ぎ（2026-06-25, 更新 2026-06-26）

### 進捗
- **step 1（枠組み・本書）**: ✓
- **step 2（verify capability）**: ✓ — `.claude/agents/verifier.md`(model:sonnet) ＋ `.claude/skills/verify/SKILL.md` ＋ guard rubric `rubrics/meta/verify-commands-exist`（GREEN）。GREEN-path・**RED catch-test とも実証済**（2026-06-25: `file-size` を 500 行超 fixture で決定的に RED 化 → verifier が誘導なしで単一 RED `oversized-source-files`＋evidence を返し、他 16 check を GREEN と正確に報告。捨て worktree で完結・破棄）。
- **step 2.5（reviewer / test-triage / meta-auditor）**: authoring ✓（2026-06-25、同型で skill＋agent。test-triage は加えて成長台帳 `design/test-failure-playbook.md`〔P1 cold-e2e-flake / P2 env 起因 build-RED〕＋ guard rubric `rubrics/meta/triage-playbook-exists`〔GREEN〕）。reviewer / meta-auditor は参照 rubric が既存物のため新 rubric なし（doc の「同 rubric / 全 rubric」規定どおり）。**新 rubric は schema 自己適用 GREEN**。**runtime 実証済**（2026-06-26: reviewer / verifier / test-triage / meta-auditor を本セッションで多数実起動。meta-auditor は『分析対象＋分析タイプを呼び出し側が渡す』形に改訂し、観測を Lathe DB に接地して実走）。
- **step 4（command 集約＋preflight＋Stop hook）**: ✓（2026-06-26、`pnpm preflight`〔--quick/--fast/--full〕＝単一入口で影響層だけ回す ＋ verify skill 参照 ＋ guard rubric `meta/preflight-commands-exist` ＋ run.mjs の opt-in `RUBRIC_SKIP_JUDGE` ＋ advisory Stop hook `preflight-stop.mjs`〔dirty 時 `--quick` で警告・必ず exit0〕）。
- 残り: ③ impact→rubric policy（最小）／ ⑤（最後）build/起動確認（preflight `--full` が一部肩代わり済）。

### invocation（実測で確定）
- `.claude/agents/*.md` は **`lathe/` を root に起動した cc セッションでのみ load される**（hub 起動セッションは built-in しか見えず named agent が not found）。
- → **今後の開発は `lathe/` で cc を起動**。そこでは named agent（verifier 等＋frontmatter の model）を `subagent_type` で直接呼べる。
- hub 起動でやむを得ない時のみ、built-in subagent_type（read-only=Explore / 編集=general-purpose / 計画=Plan）＋ `model` param ＋ 同じ skill をパス参照、でフォールバック。
- **mid-session の反映タイミング（2026-06-25 実測）**: 新規 `.claude/skills/*` は **即 hot-reload**。新規 `.claude/agents/*.md` は **遅延ありで hot-reload**（作成直後は `subagent_type not found`、数ターン後に同セッションで available になった）。→ 新 agent の実起動テストは**作成直後ではなく少し置いてから**（or 念のため次セッションで）。authoring 直後に not found でも「load されない」と即断しない。

### 引き継ぎ（lathe-cc へ）
- 開発は `lathe/` 起動の cc で継続。本書 ＋ AGENTS.md ＋ rubrics/ ＋ .claude/ で self-contained（hub 不要＝code/gate は hub なしで動く。確認済 2026-06-25）。
- 旧運用「Claude(hub) ＋ supervised 別 runner(tmux)」は本 roster（implementer=sonnet 等）へ移行。
- dev 規律（詳細は AGENTS.md）: **FF only（force-push 禁止）** / rubric 編集は auditor のみ・実装と別 commit（pr-split）/ worktree single-writer / merge 前に verify。
- 注: 日本語敬語などの**個人グローバル設定は `~/.claude`（user 層）に置く**と lathe-cc にも効く（hub の CLAUDE.md は lathe-cc に読まれない）。

## 保留（意図的な deferral・2026-07-02）: provider 非依存の単一 agent/harness ディレクトリ

**将来形**: agent 定義・hooks 等を単一ディレクトリで管理し、実行時引数に応じて provider ごとに agent を構築して実行する（現状は役割の正本 `.claude/agents/*.md` までは単一化済みで、cc=参照注入／codex=inline と「構築」だけ実行時。未統一なのは hooks・permission 系の管理）。

**今はやらない（ユーザー判断）**。根拠: lathe-phase7 で経験した問題——**inner loop と outer loop の harness が混じると面倒**。現状で回っているので、問題が出るまで現行のまま。

**再考のトリガー**: (a) hooks 周りの管理が面倒になった時（hooks にすべき事柄は複数あるが、それは inner loop の設計ドメイン）、(b) 役割 .md に provider 別の分岐が必要になった時、(c) 第 3 の provider を足す時。統一する場合も **inner/outer の harness 分離を壊さない**ことを制約にする。
