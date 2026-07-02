# ADR 0013: inner loop driver — 段遷移は agent でなくコード（軽量ワークフロー実行基盤）

- status: accepted（2026-07-02、ユーザー裁可: 「エージェントに頼るのではなくワークフロー実行基盤を作るべき。軽量なもので構わない」「認証の問題があるから claude token を gh に登録するまで実装はローカルのみ。実装 issue の発行をきっかけに lathe/ 以下で走らせる」。機構詳細は headless 仕様調査で確定後に追記）
- date: 2026-07-02
- 関連: `design/agent-workflow.md`（outer/inner 二層の正本）/ ADR 0012（session_class）/ [[workflow-merge-gate]]（merge.mjs receipt ゲート）/ issues #23–#27

## 背景: なぜ driver が要るか、なぜ agent にしないか

outer/inner 二層（2026-07-01 正典化）で、inner loop は「issue ごとに plan→implement→review→verify→merge を自律完走」と定めたが、**新しいセッションで誰が段を順に呼ぶのか（駆動役）が artifact として存在しない**。実際、二層化以前は outer（監督の役割）が段を手で駆動し、履歴が絡んで meta-audit が効かなくなった。

駆動役を agent（モデル）にしない理由:
- **段遷移は判断ではなく状態機械**。分岐は verdict 駆動（review=CHANGES→implement へ、verify=RED→triage、PASS+GREEN→merge）で決定的。判断は各段の agent（planner/reviewer/…、全て model frontmatter 指定済み）と、outer へのエスカレーションに既に隔離されている。
- モデル駆動の配線は drift（怠け・手順飛ばし）・token 浪費・再現不能を生む。**merge をゲート化したのと同じ原理で、フロー自体もコードで強制する**（prompt 遵守に頼らない）。
- 副産物として各段が独立セッションになり、driver が run 単位で紐付けを記録すれば「どの段が悪かったか」を meta-audit がデータで検証できる（lathe の観測対象としても綺麗）。

## 決定

### 1. driver はコード: `scripts/inner-loop.mjs <issue#>`（状態機械）
- 段: PLAN →（必要時 RESEARCH）→ IMPLEMENT → REVIEW → VERIFY →（RED→TRIAGE）→ MERGE（`scripts/merge.mjs`）。
- 各段 = `claude -p`（headless）で named agent（`.claude/agents/*.md`、model frontmatter 済）を起動。prompt はテンプレート（issue 本文・worktree path・前段出力を差し込み）。
- 遷移 = **構造化 verdict**（PASS/CHANGES・GREEN/RED・既知/新規）を機械 parse。
- **有界リトライ**: review⇄implement は 2 周まで。超過・設計判断マーカー・新規 RED・段の異常終了 → **エスカレーション**（停止し、evidence を escalation ファイル＋gh comment に書いて outer loop が拾う）。
- 既存機構をそのまま消費: worktree 隔離・**rebase-before-review を driver が機械化**（#26 の解）・receipt（reviewer/verifier が発行）・merge.mjs・git-guard。新しい強制は増やさない。

### 2. run manifest による issue ⇄ session の紐付け
`claude -p` の各呼び出しは**独立セッション**として `~/.claude/projects/<cwd>/<uuid>.jsonl` に保存され（lathe の ingest が自動で拾う）、段の中の subagent は既存 subagent-link で親に繋がるが、**段と段のあいだは何も繋がらない**。よって:
- driver が `--output-format json` の **session_id を段ごとに捕捉**し、`.lathe/runs/issue-<n>.json` に `{ issue, stages: [{stage, session_id, verdict, ts}] }` を記録（**正準の紐付け**。推測でなく driver が知る事実の記録＝session_class と同じ思想）。
- manifest は backend の起動 envelope 由来 cost を `backend_cost_usd` / `backend_cost_source` として記録する。これは `claude.result.total_cost_usd` や Codex JSONL の明示 cost であり、Lathe の運用上の stage 実費ではない。run cost report は `session_id` で DB を引き、`sessions.cost_usd` を `stage_session_cost_usd` / `stage_session_cost_source=db.sessions.cost_usd` として正にする。legacy manifest の `cost_usd` は `legacy_backend_cost_usd` としてのみ読む。
- child/subagent cost は primary stage cost に混ぜない。report は乖離診断用に `sessions.parent_session_id` で linked child sessions cost、`transcript_events.meta->>'costUsd'` で launcher meta subagent cost を併記する。
- 段 prompt に `issue #<n> / stage: <STAGE>` マーカーを入れる（title に乗る保険）。
- **DB への一級化**（runs テーブル / sessions.issue_ref）は別 issue（manifest は後から ingest 可能な形式にしておく）。

### 3. 運用: ローカル限定・issue 起点・手動起動
- claude token を gh（Actions）に登録するまで **CI 連携しない**。v1 は「issue 発行 → 人間が `lathe/` で `node scripts/inner-loop.mjs <issue#>` を起動」。手動起動自体が安全ゲート（勝手に走らない）。
- Actions/webhook 化は token 登録後の別 issue。

### 4. 無人実行の安全
- 段ごとに権限を絞る（reviewer/verifier=read-only 系、implementer=worktree 内編集）。具体フラグは headless 仕様調査で確定。
- **前提: PreToolUse hooks（git-guard）が headless でも発火すること**（ゲートが headless 実行にも効く）。調査で未確認なら実測してから着工。

## 却下した代替
- **agent driver**（opus/sonnet セッションが段を呼ぶ）: 決定的制御をモデルに委ね、drift・浪費・検証不能。却下（本 ADR の動機）。
- **1 セッションの subagent 木で全段**: transcript は自然に繋がるが、駆動役がモデルになる同じ問題。却下。
- **GitHub Actions 起点**: 認証（claude token 未登録）。ローカル起点で開始し後日移行。
- **title 文字列だけで run を紐付け**: ヒューリスティックで壊れる。manifest（session_id の事実記録）を正準に。

## スコープ
- 本 ADR = driver 骨格・verdict 規約・run manifest・ローカル運用・段別権限方針。
- スコープ外: run の DB 一級化 / Actions 連携 / prompt テンプレートの継続改善（運用で回す）/ Eval 化。

## 実装（bootstrap の但し書き）
driver 自身の実装は inner loop がまだ無いため、merge gate（3f9f4ba）と同じ「**最後のブートストラップ**」として、outer セッションからゲート完全準拠（implementer→reviewer→verifier→merge.mjs）で 1 スライス実装する。**以後の issue（#25 含む）はすべて driver 経由**。

## 機構詳細（2026-07-02 headless 仕様調査で確定。出典: code.claude.com/docs の headless / sub-agents / permission-modes / hooks-guide / sessions ＋ `claude --help` 実出力）

- **段の起動**: `claude -p "<段プロンプト>" --agent <name> --output-format json` を段の cwd（worktree）で spawnSync。`.claude/agents/<name>.md` の frontmatter（model / tools）がそのまま効く。
- **`--bare` は使わない**: `--bare` は CLAUDE.md・settings・**hooks をスキップ**する。我々は逆に「git-guard（PreToolUse hook）と project settings が headless でも効く」ことが必須要件。
- **hooks**: PreToolUse / PostToolUse / Stop は `-p` でも発火（確認済み）。PermissionRequest は non-interactive のため発火しない → block は PreToolUse で行う現行構成が正。
- **permission**: project `.claude/settings.json` の permissions は `-p` でも適用（CLI フラグが override）。段別に `--permission-mode` / `--allowedTools` で絞る（reviewer / verifier / test-triage = read-only 系＋必要な Bash のみ、implementer = 編集可・worktree cwd）。`--dangerously-skip-permissions` は使わない。
- **envelope**: `--output-format json` は単一 JSON（`type:"result"`, `session_id`, `result`（最終テキスト）, `total_cost_usd`, `usage`, `is_error` 系）。`session_id` を manifest に記録。`--resume <session_id>` で同一セッション続行も可能（差し戻し周回で利用可）。
- **transcript**: 対話セッションと同じ `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` に保存（既定で persistence ON）。worktree cwd で走らせた段はその encoded-cwd の dir に落ち、ingest の全 dir sweep が自動で拾う。
- **verdict 規約**: 各段プロンプトは「最終行に `VERDICT: <TOKEN>` を出力せよ」を必須にし、driver は envelope の `result` 末尾からトークン（PLAN_READY / ESCALATE / IMPL_DONE / PASS / CHANGES / GREEN / RED / KNOWN / NOVEL）を parse する。
