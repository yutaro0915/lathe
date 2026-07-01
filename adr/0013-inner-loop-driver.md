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

## 機構詳細（headless 仕様調査で確定後に追記）
- named agent の headless 起動方法（フラグ or system-prompt 注入）
- `--output-format json` envelope の実測形
- 段別 permission フラグの組
- hooks の headless 発火確認
