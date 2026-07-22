# meta-audit: inner loop agent（imple/plan/review）の実行実態

**対象**: TASK_PLAN / PLAN_REVIEW / IMPLEMENT / LAND_REVIEW / LAND_REWORK の実 run
**接地**: `.lathe/runs/issue-*.json`（66 manifest・326 stage）＋ `~/.claude/.../inner-*/*.jsonl`（185 session を manifest の session_id で照合）
**分析タイプ**: ①ライフサイクル実態 ②skill 使用実態 ③不効率の定量化
read-only・提案のみ。数値は claude backend の stage のみ（codex backend は cost/token 未計測のため除外）。

---

## 0. 全体像（まず金額の分布 — PdM の直感の補正）

claude backend の総額 ≈ **$150.9**（326 stage 中 claude=165）。stage 別平均コストと実態:

| stage | n | 総額 | 平均$/run | 平均turn | 平均 cache-read | verdict 分布 | agent(model) |
|---|--:|--:|--:|--:|--:|---|---|
| TASK_PLAN | 32 | $45.1 | **1.41** | 22 | 1.0M | READY25 / ESCALATE7 | planner(**opus**) |
| IMPLEMENT | 74※ | $40.3 | 0.54 | **108** | **7.8M** | DONE72 / ESC2 | implementer(sonnet) |
| LAND_REVIEW | 36 | $27.8 | 0.77 | 32 | 1.6M | **CHANGES18** / PASS17 | reviewer(sonnet) |
| LAND_REWORK | 17 | $18.4 | 1.08 | 71 | 4.2M | DONE17 | implementer(sonnet) |
| PLAN_REVIEW | 24 | $16.3 | 0.68 | 23 | 1.0M | PASS19 / RED5 | reviewer(sonnet) |
| VERIFY | 39 | $3.1 | 0.08 | 18 | 0.6M | GREEN34 | verifier(sonnet) |

※IMPLEMENT n=74 は codex 混在の全 stage 数。claude 実測は 21 session。

**要点**: 「実装が最大コスト」ではない。**計画系（TASK_PLAN+PLAN_REVIEW+PLAN）≈ $61 ≈ 実装系（IMPLEMENT+REWORK）$58 ≈ レビュー系 $31**。planner が opus のため TASK_PLAN の単価が全 stage 最高（$1.41）。かつ **plan-review RED / LAND CHANGES による周回**がそのまま費用倍化になる（下記 #254・#256）。

---

## ① 各段の実ライフサイクル（実 tool-call 列から）

### IMPLEMENT（例: #229、44 tool call・$1.50。代表的で健全な部類）
```
0  Skill:implement                     ← skill は「呼ばれている」
1-3  git log/status → reset --hard main  ← 起点合わせ
4-25 grep/Read×22（inner-loop.mjs を 7回・inner-loop-core.mjs を 4回 再読）  ← 探索
26-29 Edit×4                           ← 生産（全体の 9%）
30-43 pnpm test / preflight --quick/--fast / rebase / commit / 再test×14 ← 検証churn
```
ライフサイクル: **skill 呼ぶ→git 起点→コード発掘（過半）→少量編集→検証を繰り返す→commit→再rebase→再検証**。編集は 44 call 中 4（9%）。残りは「どこを直すか探す」と「直ったか確かめる」。

### LAND_REVIEW（例: #224、23 call・CHANGES）
```
0  Read:SKILL.md（Skill tool でなくファイル直読）
1-8  ls rubrics/ → cat rubric.json ×4 → grep '"scripts"'   ← rubric 発掘
9-19 Read inner-loop-core → grep import×2, INNER_SETTINGS_PATH×2(重複), buildCodexArgs …  ← ソース再ナビ
20 ToolSearch: submit_finding（read環境で無効・空振り）
21-22 cat rubrics/meta/*.json
```
review skill は「入力＝changed paths＋`git diff main...HEAD`」と規定するが、**reviewer は diff を渡されておらず、rubric とソースをゼロから再発掘**している。23 call 中ほぼ全部が探索、diff の直視が見えない。

### TASK_PLAN / PLAN_REVIEW
planner/​reviewer とも毎回「接地確認」と称してコードを grep/Read で再走査（TASK_PLAN 平均 explore 2.3・reads 3.3、PLAN_REVIEW explore 3.5・reads 4.5）。plan 本文が示す対象を、レビュー側が独立に再確認する構造。

### VERIFY（健全）
18 turn・$0.08。bash の 29%=run.mjs（実検証）、30%=git-inspect、23%=shell-explore。最軽量で、責務も明快。

---

## ② skill の実使用

- **Skill tool は実際に呼ばれている**: 全 inner transcript で **118 回**（implement 44 / verify 51 / review 23）。「定義だけで未使用」ではない。
- ただし呼び方は不統一: #224 LAND_REVIEW は Skill tool でなく `Read SKILL.md`（ファイル直読）。同じ skill が「tool 経由」と「ファイル読み」で混在。
- **定義上 available だが inner loop で未使用の skill**: `lathe-ui`（UI 実装用・今回の直近サンプルが infra 系のため出番なし＝サンプル偏り、UI issue では要る）、`result-classification`（DIAGNOSE 用・outer）、`explain-diff`（教材・別経路）、`test-triage`（TRIAGE は codex で 3 回、Skill tool としては未計上）、`meta-audit`（本監査＝outer）。
- **PdM の問い「実装/レビューに skill が要るか」への直接回答**:
  - `implement` skill の中身は **git rebase 規律＋read-only 境界のみ**（~15 行）。実装の最大コストである「コード発掘」を一切助けない。つまり **skill は discipline を守らせるが、右往左往は減らさない**。実装の無駄は skill でなく **plan の質**と **diff/anchor の注入**でしか下がらない。
  - `review` skill は観点チェックリスト（設計遵守/抜け/risk）で有用だが、reviewer が diff を渡されない構造欠陥を skill では埋められない（skill は正しく「基準は rubric/plan 側」と書いている）。
  - `verify` skill は具体コマンド列で最も実効的（VERIFY が最安・最短なのはこの薄い手順が効いている裏付け）。

---

## ③ 不効率の定量化（右往左往・token 消費）

### (a) 実装の過半は「発掘」— 検証churn ではない
IMPLEMENT の bash 613 回の内訳: **shell-explore（ls/cat/grep/find/rg）37%** ＋ git-inspect 11% = **約半分がナビゲーション**。実検証は test/tsc 8%＋preflight 7%＋run.mjs 3% = 18% のみ。Read tool 8.4/session・**同一ファイル再読 3.0/session（最悪 19）**。
→ plan が「Touches: <path>」を与えても、**ファイル内のどの関数・どの行かは毎回再発見**している。#229 は `rebaseWorktree`/`stageRequiresFreshMainRebase`/`resolveResumeState` の位置特定に 22 call を費やし inner-loop.mjs を 7 回・core.mjs を 4 回再読。

### (b) context 準備 vs 生産の比
IMPLEMENT: 平均 **cache-read 7.8M tokens / output 72k**（≈108:1、turn 108 で膨張。turn 数がそのまま cache-read を積む）。tool 面では **収集系（Read8.4＋explore-bash≈14）: 生産系（Edit8.4）≈ 2.7:1**。turn が費用の主動因＝turn を増やす発掘と再検証が効いている。

### (c) 実例 3 件（何 token / $ が溶けたか）
1. **#254 — plan だけで $9.97、実装ゼロ**。TASK_PLAN×3＋PLAN_REVIEW×2。plan-review が 2 度 RED→毎回 planner(opus) がコード全体を再接地確認して plan を作り直し、IMPLEMENT に一度も到達せず。さらに PLAN_REVIEW の result_text が2度とも「Stop hook の指摘を受け、改めて…出力します」「前のターンで完了済みのレビューを、改めて正式フォーマットで…」＝**Stop hook が verdict 書式を弾き、完成済みレビューを再出力**（1 周回まるごと二重課金）。
2. **#117 IMPLEMENT+REWORK — 単一 issue $12.74**。IMPLEMENT($3.13,136turn,cacheR13.9M)＋LAND_REVIEW×2＋REWORK($2.53,138turn,再読14)。LAND CHANGES→追い commit で再度 100k+ output。
3. **#None(large) IMPLEMENT — $7.70 / 306 turn / cache-read 32.3M / 再読16**。単発 implement が 300 turn 暴走。turn 数が cache-read を積み上げ、探索bash 86。

### (d) 系全体の周回率（右往左往の構造化）
直近 claude loop の全 issue（#117,118,129,189,224,225,229,231,234,236,239,254,255,256,258,263）で **LAND_REVIEW ≥2 かつ REWORK ≥1 がほぼ既定**（LAND CHANGES 率 18/36=50%）。plan-review RED も 5/24。**「一発で通らない」が常態**で、周回 1 回 ≈ $2–5 追加。

---

## ④ 提案（keep 先・constructive・効果見積り付き）

### keep
- **K1. verify 段の設計は保つ**（薄い手順 skill＝最安最短。$0.08/run）。他段の手本。
- **K2. Skill 呼び出し自体は機能している**（implement/verify/review が実呼び出しされ discipline は効いている）。skill を消す話ではない。

### improve / fix（優先度順）

- **fix・高: plan の「変更対象」に symbol anchor を必須化**（plan-format.md 改訂案）。「Touches: path」だけでなく `<path>::<関数/シンボル>`（可能なら現行 file:line）を要求。IMPLEMENT の発掘 22 call（#229）→ ~5 に、同一ファイル再読 3.0→~1 に。**効果: IMPLEMENT の turn ~108 の 3–4 割減 ≈ $40 バケットの ~30%（月 ~$12 規模）。planner が既にコードを接地確認しているので追加コストほぼゼロ（出力に足すだけ）**。根拠: #229(seq0-25)・再読集計。

- **fix・高: reviewer prompt に diff＋changedFiles＋発火 rubric リストを事前注入**。driver は changedFiles を、run.mjs は該当 rubric を既に知っている。LAND_REVIEW/PLAN_REVIEW の探索（#224 の 23call 中 ~20、平均 explore 3.9＋reads 9.6）を潰す。**効果: LAND_REVIEW $27.8＋PLAN_REVIEW $16.3 バケットの ~30–40%。**根拠: #224 LAND_REVIEW seq。

- **fix・中: Stop hook の verdict 書式強制が「完成レビューの再出力」を誘発している**（#254 の PLAN_REVIEW×2 が両方「改めて正式フォーマットで出力」）。hook が弾いた際に本文を保持して verdict 行だけ補う（再生成させない）よう見直し。**効果: RED/レビュー周回のたびに 1 turn 分（$0.5–1.5）を回収。**根拠: issue-254.json result_text。

- **improve・中: plan-review RED 時の再 plan を「全再接地」でなく差分修正に寄せる**。buildReviewFeedbackSection は所見注入するが planner(opus) が毎回コード全体を再 grounding。RED 所見に対する差分のみ修正を明示指示（＋再接地は所見該当箇所に限定）。**効果: #254 型（plan で $9.97・実装ゼロ）の再発防止。opus 単価が効くバケットなので削減額大。**

- **improve・低: skill の「実装ナビゲーション」への無力を明文化 or 補強**。implement skill は git 規律のみで発掘を助けない。選択肢:(a) skill は現状維持し発掘対策は plan anchor（K/fix-高）に寄せる=推奨、(b) skill に「plan の anchor を起点に読む・全文再 grep を避ける・同一ファイル再読前に既読分を使う」の探索規律を1–2行追加。**効果: (b) は低コストで再読 3.0→低下の後押し。ただし本丸は plan anchor。**

- **improve・低: Skill 呼び出し経路の統一**（tool 経由か SKILL.md 直読か。#224 は直読）。効果は小さいが計測とドリフト管理のため一貫させる。
