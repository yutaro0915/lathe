# Agent Workflow — lathe の変更を回す開発フロー（正本）

> status: building / 2026-06-25
> 方針: OPUS（main）は **枠組み・scope・plan 承認・merge・meta 監査** と「コード全体像を人間と同期／進捗・詰まり・
> 問題の管理」だけを担う。grunt（調査/実装/レビュー/検証/triage）は専門 agent に**並列委譲**し、OPUS は
> **verdict だけ消費**する（実装・調査・test 実行・grep はしない）。
> ブートストラップ中: この workflow 自体は、検証されるまで **dogfood せず手作りで段階構築**する
> （未検証パイプで組むと問題発覚が遅れるため）。

## フロー（1 変更あたり。rigor は影響クラスでスケール＝小変更は段を飛ばす）

| # | 段 | 担当 / model | 役割 |
|---|---|---|---|
| 0 | SCOPE | OPUS＋人間 | 何を / finish line / 影響クラス |
| 1 | RESEARCH | researcher / Haiku ×並列 | code+docs から事実・制約（read-only） |
| 2 | PLAN | OPUS（planner も opus） | research 統合 → evidence 付き計画 → 人間承認 |
| 3 | IMPLEMENT | implementer / Sonnet | 計画通り実装。**git 操作なし・uncommitted で残す** |
| 4 | REVIEW | reviewer / Sonnet | 設計遵守・抜け・risk |
| 5 | VERIFY | verifier / Sonnet | 影響クラスの gate/test だけ独立実行 → GREEN/RED ＋ evidence |
|   | ↳ RED | test-triage / Sonnet (read-only) | playbook＋git で既知/新規分類。既知=対処、新規のみ evidence＋仮説で OPUS へ |
| 6 | MERGE | OPUS | verdict だけ消費して取り込む |
| 7 | META-AUDIT | meta-auditor / OPUS（事後） | rubric 化すべき点 / 詰まり・過剰ループ / 効率化 |

OPUS の責務 = 0・2・6・7 ＋ 全体像同期・進捗/詰まり/問題管理。

## 知識の置き場（最重要原則）

| 性質 | 置き場 | 例 |
|---|---|---|
| 不変・証明済み・再利用可能な手順 | **Skill** | `pnpm dev`、no-git 規律、ワークフローの形、行動規則 |
| 正しさが変動する・複雑な基準 | **Rubric**（skill から参照・inline 禁止） | どのコマンドで何を満たすか。agent が読んで判定 |
| コードに在る事実 | 書かない（調査で発見） | 実装詳細・現状構造 |
| イベント時の強制 | **Hook** | session 終了の preflight 等 |

理由: skill は**検証が難しい層**だから不変だけ置く。変動は**検証できる層（rubric=gate）**に預ける。
skill は滅多に変えない（手順がより効率的と判明した等の時だけ、meta-audit 経由で OPUS 承認）。
**「どの rubric を参照するか」も skill に書かない** → 後述 impact→rubric policy が与える。

## agent × skill（不変手順）× 参照 rubric（変動）

| agent | model | skill | 参照 rubric |
|---|---|---|---|
| researcher | Haiku | disciplined-research（調査→枠組み / existence proof / 実装網羅の問い） | —（発見） |
| planner | OPUS | 計画手順（research 統合 → evidence 付き → 承認） | 影響クラスの必須 rubric ＋ design docs |
| implementer | Sonnet | 実装手順（計画遵守・周辺コード踏襲・no-git・uncommitted・不変コマンド） | 影響クラスの rubric |
| reviewer | Sonnet | review 観点（設計遵守・抜け・risk） | 同 rubric ＋ plan |
| verifier | Sonnet | verify 手順（`node rubrics/run.mjs --changed …` の回し方・build/test の不変コマンド・GREEN/RED＋evidence） | run.mjs が発火させる rubric |
| test-triage | Sonnet (read-only) | triage 手順（playbook → git → 既知/新規） | `design/test-failure-playbook.md`（成長する知識） |
| meta-auditor | OPUS | audit 観点（rubric 化点 / loop・stall / 効率化） | 全 rubric ＋ やり取り |

現状: **既存** researcher / planner / implementer。**未作成** reviewer / verifier / test-triage / meta-auditor。skill は `lathe-ui` のみ。

## 構築方針 — skill と rubric は一緒に作る

skill と rubric は**結合**している（skill はどの rubric を参照するかで意味が決まり、rubric は skill から呼ばれて回る）。
よって **capability 単位で skill ＋ 参照 rubric（＋必要なら agent 定義）を一緒に**作る ── 「全 skill → 全 rubric」のような
分離フェーズにしない。当面は Eval を rubric で構成せず、**agent が該当 rubric を直接参照して満たすか判定**する
（Eval-from-rubrics は後回し）。

## 構築の順序（このフロー自体を手作りで段階構築）

1. **枠組み（本書）** ★今ここ
2. capability を 1 つずつ（skill ＋ 参照 rubric ＋ 必要なら agent を一緒に）。**verify 系から**
   （OPUS の手作業 gate 監査を最初に肩代わりさせる価値が高い）。
3. impact→rubric policy（最小版・影響クラス → 満たすべき rubric）
4. command 集約 ＋ preflight ＋ Stop hook（build/test を一箇所に、session 終了で走らせる）
5. **（構築後）build/起動確認** を preflight で炙る ← build 確認はここ（最後）

各ステップは OPUS＋人間で 1 つずつ・目の届く範囲で。調査が要る所だけ Haiku に出す。

## 保留 / メモ
- Eval を rubric で構成: 後（今は agent が rubric を直接参照）。
- 呼称: 実装担当エージェントは一般名で記す（具体ツール名は書かない）。← hub memory 化予定。
- handoff: implementer は uncommitted で残し commit/merge は OPUS。verifier は GREEN/RED＋evidence。RED は test-triage 先行。

## Build status & 引き継ぎ（2026-06-25）

### 進捗
- **step 1（枠組み・本書）**: ✓
- **step 2（verify capability）**: ✓ — `.claude/agents/verifier.md`(model:sonnet) ＋ `.claude/skills/verify/SKILL.md` ＋ guard rubric `rubrics/meta/verify-commands-exist`（GREEN）。GREEN-path 実証済（agent が run.mjs を実走し各 check を正確に報告）。**RED catch-test は未**。
- 残り: ① verify の RED catch-test → ② reviewer / test-triage / meta-auditor を同型（skill＋rubric＋agent を一緒）で → ③ impact→rubric policy（最小）→ ④ command 集約＋preflight＋Stop hook → ⑤（最後）build/起動確認。

### invocation（実測で確定）
- `.claude/agents/*.md` は **`lathe/` を root に起動した cc セッションでのみ load される**（hub 起動セッションは built-in しか見えず named agent が not found）。
- → **今後の開発は `lathe/` で cc を起動**。そこでは named agent（verifier 等＋frontmatter の model）を `subagent_type` で直接呼べる。
- hub 起動でやむを得ない時のみ、built-in subagent_type（read-only=Explore / 編集=general-purpose / 計画=Plan）＋ `model` param ＋ 同じ skill をパス参照、でフォールバック。

### 引き継ぎ（lathe-cc へ）
- 開発は `lathe/` 起動の cc で継続。本書 ＋ AGENTS.md ＋ rubrics/ ＋ .claude/ で self-contained（hub 不要＝code/gate は hub なしで動く。確認済 2026-06-25）。
- 旧運用「Claude(hub) ＋ supervised 別 runner(tmux)」は本 roster（implementer=sonnet 等）へ移行。
- dev 規律（詳細は AGENTS.md）: **FF only（force-push 禁止）** / rubric 編集は auditor のみ・実装と別 commit（pr-split）/ worktree single-writer / merge 前に verify。
- 注: 日本語敬語などの**個人グローバル設定は `~/.claude`（user 層）に置く**と lathe-cc にも効く（hub の CLAUDE.md は lathe-cc に読まれない）。
