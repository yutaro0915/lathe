# 実行 runtime 要件の実測導出（cr-runtime-requirements）

- 調査日: 2026-07-08 ／ 対象 repo: /Users/cherie/LLMWiki/projects/lathe（read-only）
- 接地ソース: repo 実コード（scripts/・.claude/・ops/outer-harness/・apps/web/scripts/ingest/）、
  gh issue（読み取りのみ）、既存調査 2 本（scratchpad/research-pi-agent.md・scratchpad/meta-audit-agent-efficiency.md）
- PdM 申告の検証対象: 「Claude Code は 1 対 1 セッション前提で自動タスク・ハーネス構築に向いていない。inner/outer の分離もできていない」

## 0. 先に結論（PdM 申告の実測照合）

- 「向いていない＝動かない」は**不成立**: headless 運用は 66 run manifest・326 stage・claude backend $150.9 を完走している実測がある（meta-audit-agent-efficiency.md §0、`.lathe/runs/issue-*.json` 接地）。
- ただし申告の実質は 3 点で**支持される**:
  - (a) inner/outer 分離が「settings ファイルの読み込み規則」に依存し、破れの実例と貼り忘れが現存する（§3）。
  - (b) 書式強制（Stop hook）が二重課金の実害を出した（issue #302 起票・close 済み、meta-audit #254 実例「1 周回まるごと二重課金」）。
  - (c) permission "ask" の headless 意味論が「自動拒否」（ops/outer-harness/hooks/issue-create-guard.mjs 冒頭コメント明記）＝対話前提の設計の名残。
- 一方、**backend 抽象（ADR 0014）は既に機能しており**、codex 混在稼働・cost 自前換算・ingest の provider 分離まで実装済み。「runtime は差し替え可能な 1 変数」が現アーキテクチャの実態。

## 1. Claude Code 依存機能の棚卸しと判定

依存の全 spawn 地点（`grep spawnSync.*'claude'` で機械列挙）:
1. `scripts/inner-loop-stage-runner.mjs:26`（TASK_PLAN/PLAN_REVIEW/IMPLEMENT/LAND_REWORK）
2. `scripts/review-engine.mjs:362`（PR review 記録）
3. `scripts/meta-loop.mjs:291`（meta-auditor・実走ゼロ＝design/loops.md「未通電」）
4. `scripts/orchestrator.mjs:213-214`（EXPLAIN dispatch）

| 機能 | 現行の使い方（一次証拠） | 判定 | 根拠 |
|---|---|---|---|
| headless `-p` 実行 | `claude -p … --output-format json`（inner-loop-stage-runner.mjs:26、orchestrator.mjs:214） | **本当に必要（機能として）／実現手段は代替容易** | 同一 driver が `codex exec --json` でも稼働中（runStageCodex、同ファイル:40-62）。pi も `--mode json` で対応（research-pi-agent.md §2a）。「headless で JSON envelope を返す」ことが要件で、Claude Code 固有性は無い |
| `--agent`（.claude/agents/*.md role 注入） | buildClaudeArgs（inner-loop-backends.mjs:206-218） | **代替容易** | codex backend は既に agentBody を prompt に inline（buildCodexPrompt、backends.mjs:239-242）＝代替実装が同 repo 内で稼働済み |
| allowedTools / --permission-mode（tool 統制） | stage 別 allowlist（stagePermissions、backends.mjs:28-64。例: PLAN 段は Read/Grep/Glob/Bash(git *) のみ、EXPLAIN は `Write(explains/**)` 等 orchestrator.mjs:188-193） | **要件は本当に必要／機構は代替可（コスト中）** | read-only plan 段・worktree 限定書込みは設計の柱（ADR 0035 §1）。codex は `-s read-only/workspace-write` で代替済み（stageSandbox）。pi は標準 permission 機構なし＝extension 自作（research §2b）。宣言的 allowlist の粒度（`Bash(gh issue view *)`）は CC が最も強い |
| `--settings` 分離（INNER_SETTINGS_PATH pin） | backends.mjs:213・orchestrator.mjs:214。inner=tracked settings.json、outer=untracked settings.local.json（#206 設計） | **不要（この機構自体は要件でない）** | 分離という要件は必須だが、settings 重ね合わせで実現する必然性はなく、現に破れている（§3）。#224 の contract 自体が「--settings 明示は settings.local の暗黙 merge に対する belt&braces」＝**Claude Code の settings merge 仕様への依存**を自認 |
| Stop hook（verdict-guard） | .claude/hooks/verdict-guard.mjs（LATHE_STAGE 環境変数で発火、最終行 `VERDICT:` を強制） | **不要寄り（構造化出力で置換すべき）** | 実害: #302（完了済み review の全文再出力を強制＝二重課金、2026-07-08 close）・meta-audit #254（PLAN_REVIEW×2 が両方「改めて正式フォーマットで出力」）。driver 側に unparsable retry の backstop が既にある（runStageWithUnparsableRetry、inner-loop-core.mjs:96-119）。rubric `structural-guarantee-before-prompts`（commit 81776b7）の精神とも矛盾: 書式は prompt 再生成でなく runtime の構造化出力（JSON schema／agent_end event）で機械保証すべき |
| transcript jsonl（lathe ingest 依存） | `~/.claude/projects/**/*.jsonl` を discover（apps/web/scripts/ingest/usecase/discover-dirs.ts） | **要件は必須（lathe の存在意義）／CC 形式への依存は代替容易** | ingest は **provider 抽象済み**: `providers/claude.ts` と `providers/codex.ts`（`~/.codex/sessions/**/rollout-*.jsonl` を同一 schema へ写像、runner='codex'）が現存。pi も JSONL session（形式文書 session-format.md あり、research §2e）＝adapter 1 枚（research 見積り「低」）。自作 runtime なら transcript を ingest schema で直接書ける（adapter 不要化） |
| session resume（--resume） | buildClaudeArgs は対応（backends.mjs:216） | **不要（実測で未使用）** | 全 call site が resumeSessionId=null: inner-loop.mjs:417・inner-loop-plan-task.mjs:411・inner-loop-land.mjs:297。resume は manifest ベースの stage 再実行（decideResumeState、core.mjs:364-448）で実現済み＝session resume はデッドコード |
| cost 報告 | envelope `total_cost_usd`（stage-runner.mjs:37、source='claude.result.total_cost_usd'） | **要件は必須／代替容易** | G9 cost 異常検知・meta-audit が cost 実測に依存。codex は token usage × `apps/web/db/pricing.json` の自前換算が実装済み（parseCodexCostReport、backends.mjs:292-348）。pi は Usage 型に cost 構造化済み（research §2d） |
| skills（Skill tool） | .claude/skills/{implement,verify,review,test-triage,…}。inner transcript で 118 回実呼び出し（meta-audit §②） | **「手順書注入」は有用／Skill 機構である必要はない＝代替容易** | meta-audit 実測: implement skill は git 規律 ~15 行で「discipline は守らせるが右往左往は減らさない」。verify skill（具体コマンド列）が最実効・$0.08/run。codex backend は同内容を prompt inline で代替する前例あり。呼び出し経路も既に不統一（#224 LAND_REVIEW は SKILL.md 直読） |

補足: subagent（Task tool）は inner loop では未使用（driver が別プロセス spawn）。outer 監査役の worktree 隔離 Agent は対話運用であり自動 loop の要件ではない。

## 2. 既存調査との接地

- **research-pi-agent.md**: pi は headless(JSON mode)・cost 構造化・JSONL session・30+ provider で inner stage の要件を満たす。ただし (i) MCP なし（lathe inner loop は MCP を使っていないので**この点は実害なし** — inner の allowedTools に MCP は無い、backends.mjs:28-64 で機械確認）、(ii) permission 機構なし＝extension 自作、(iii) `--print` 失敗時の exit code 未確認。research の migration 見積り 8–12 週は「MCP 30+ 本の移植」を含む outer 込みの数字であり、**inner stage 4 spawn 地点だけの置換ならこれより大幅に小さい**（stage-runner.mjs の runStageClaude 相当 1 関数＋ingest provider 1 枚＋verdict 構造化）。
- **meta-audit-agent-efficiency.md**: コストの主因は runtime でなく **turn 数（発掘と周回）**。IMPLEMENT の bash 613 回中 37% が shell-explore、cache-read:output ≈ 108:1、LAND CHANGES 率 50%。**runtime を替えても発掘・周回コストは消えない**（改善は plan anchor・diff 注入・書式の構造化＝#301 の情報注入契約）。runtime 選定は「コスト削減」でなく「保証の置き場所（分離・書式・統制）」で決めるべき。

## 3. 分離破れの構造分析 → 分離保証の要件

### 破れの実例（時系列）

1. **#224（2026-07-07 close・PR #226）**: inner spawn の settings が cwd 依存の暗黙 load で、「想定外 cwd（例: repo root）で spawn すると outer 層（統治 hook）を拾いうる」（issue 本文）。→ --settings 明示 pin で対処。
2. **本日（2026-07-08・PdM/親セッション申告）**: 監査役の対話 session に outer 関所 hook（issue-create-guard）が掛かっていなかった。**repo 内に当該 incident の一次記録は見つからず＝未確認**（本日起票の #299-#302 に関連記述なし）。ただし「掛からない経路」が構造として存在することは機械確認できる（下記）。
3. **貼り忘れの現存（本調査で機械確認）**: `reviewerArgs`（review-engine.mjs:301-309）と `runMetaStageClaude`（meta-loop.mjs:289-291）は **--settings pin を含まない**（`grep settings` 該当 0 件）。両者は repo root cwd で claude を spawn するため、outer local 層（settings.local.json）を暗黙 merge する。harness-separation.test.mjs の (d) は buildClaudeArgs と CLASS_EXPLAIN しか検査していない（`grep reviewerArgs|meta-loop` 該当 0 件）＝**#224 と同型の穴が検査網の外に 2 箇所残っている**。

### なぜ settings ファイルでは保証にならないか（機械確認できる構造）

- **配布されない**: outer 関所の配線は untracked `.claude/settings.local.json`（harness-separation.test.mjs (a) が「untracked であること」自体を仕様として assert）。git で伝播しないため、新 clone・case サーバー・別マシンでは `ops/outer-harness/install.sh` の**手動実行**が前提。実行の有無を検証する機構はない（README の検証手順は「gh issue create を試みると確認プロンプトが出る」という**手動確認のみ**）。
- **掛かっていることを検証する機械検査が存在しない**: harness-separation.test.mjs は (b)「worktree に無い」・(c) 純関数・(d) argv pin のみ。「repo root の対話セッションに guard が実際に載っている」ことはどこも検査しない。
- **fail-open**: guard が不在でも全操作が正常に通る（欠落が観測されない）。破れは事後にしか分からない。
- **外部仕様依存**: 分離の意味論が Claude Code の settings merge 規則（project settings + local settings + --settings の重ね合わせ順）と hook のセッション開始時読込仕様に乗っている。#206 設計自身が「belt & braces」と多重化で補っている＝単層では信頼していない。
- **逆方向の混入も設計内在**: TASK_PLAN/PLAN_REVIEW は repo root cwd で走る（stageCwd・REPO_ROOT_STAGES、backends.mjs:66-79）ため、inner の plan 段は outer local 層が存在する場所で実行される。無害なのは「headless では ask=自動拒否」という CC の挙動に依存した結果論。

### 導出される要件（分離を何で保証すべきか）

- **R1（権能分離・最重要）**: inner 実行体は「起票・merge できる credential を最初から持たない」。GitHub token の scope 分割（inner 用 token は issue write 不可）または書き込みを driver/orchestrator の一元 proxy（現に FILE_CHILDREN・escalation 投函は driver の spawnSync 直呼び＝hook 外で成立している。loops.md）に限定する。**hook で「聞く」のではなく、権能が無いから物理的にできない**形。
- **R2（fail-closed）**: 関所は「無いと動かない」側に置く。設定の重ね合わせは fail-open（欠落＝素通し）なので統治機構の置き場として不適。
- **R3（検証は action 時・機械）**: 「分離が効いている」ことを session 起動時 self-check か書き込み口の検証で毎回機械確認する。install 済みかどうかという状態に依存させない。
- **R4（書式は構造化出力）**: verdict・plan 書式は Stop hook（prompt 再生成→二重課金 #302）でなく runtime の構造化出力（JSON envelope / agent_end / API structured output）で保証する。
- **R5（spawn 地点の単一化）**: claude spawn が 4 箇所に分散し、pin の貼り忘れが 2 箇所発生した。runtime 呼び出しは 1 モジュール（現 stage-runner の徹底）に集約し、全 caller をそこ経由に強制する検査を置く。

## 4. runtime 選定の判断材料表

| 選択肢 | 観測(ingest)接続 | tool 統制 | 書式強制 | コスト | 保守 |
|---|---|---|---|---|---|
| **Claude Code 継続** | ◎ 既存 provider（providers/claude.ts）・変更ゼロ | ○ allowedTools/permission-mode は宣言的で最強。ただし hook 層は settings 依存＝fail-open（§3）。R1（credential 分離）は CC でも別途可能 | △ Stop hook は実害あり（#302）。`--output-format json` の envelope はあるが本文内 VERDICT は prompt 頼み | ○ envelope total_cost_usd 実測済（$150.9/165 stage）。Max サブスク充当の可否は未確認 | △ 外部仕様（settings merge・hook 仕様）追随。agent loop 本体の保守はゼロ。「1 対 1 前提」の意味論（ask=自動拒否）が残る |
| **pi** | ○ adapter 1 枚追加（JSONL・session-format.md 文書化済み。codex.ts 前例で工数「低」） | △ 標準 permission なし。extension 自作（tool_call intercept）＝統制コードを自前保守。sandbox は container 前提 | ○ JSON mode の agent_end／SDK・RPC で構造化可。**exit code 規約は未確認**（research §7） | ○ Usage 型に cost 構造化済み。API key／OAuth サブスク両対応 | ✗ 個人プロジェクト（bus factor 1）。inner 4 spawn 地点だけなら置換は小さいが、permission extension・verdict 契約・ingest adapter の新規保守が乗る |
| **API 直叩き自作** | ◎◎ transcript を ingest schema で直接書ける＝adapter 消滅・観測が正本になる（lathe の製品方向とも整合） | ◎ tool dispatch が自作コード＝fail-closed にできる（allowlist は関数表、R1/R2 を設計で直に満たせる） | ◎ API の structured output / tool_choice で機械保証（R4 を根本解決） | ○ API 従量のみ。prompt cache 制御・retry を自前実装（usage フィールドから直接計測） | △ agent loop（tool 実行・context 管理・retry）を全部自前。ただし inner stage の要件は「単発 headless・限定 tool・verdict 1 個」と小さく、loop は数百行規模。CC の新機能（skills 等）には乗れない |
| **併用（ADR 0014 backend 追加＝段階移行）** | ◎ provider 分離が既に前提（claude/codex 稼働中・manifest に backend 列） | ○ backend ごとに最適機構（CC=allowlist、codex=sandbox、自作=関数表）。統制の意味論が backend 毎に異なる点は要規範化 | ○ verdict 契約を envelope 層（runStage の返り値）に一本化すれば backend 非依存にできる | ◎ stage 単位で単価最適化（例: 定型 VERIFY を安い backend へ） | ◎ 最小リスク。selectBackend/--backend-<stage> フラグが実装済みで、実験 loop（#129）で A/B 可能。ただし多 backend の恒久併存は検査対象の増加 |

## 5. 未確認事項

- 本日の「監査役 session に関所 hook 不在」の一次記録（repo issue/comment に見つからず。親セッション申告のみ）。
- claude backend の課金経路（API key か Max サブスク充当か）— envelope の total_cost_usd は取得できているが請求実態は未照合。
- pi `--print`/JSON mode の失敗時 exit code（research-pi-agent.md §7 と同じく未確認）。
- Claude Code の hook 設定が「セッション開始時に固定され途中変更が効かない」仕様の正確な範囲（公式 docs 一次確認を経ていない — R3 の根拠は「install の有無を検証する機構がない」という repo 側の事実のみで自立する）。
