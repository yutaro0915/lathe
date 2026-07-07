# loops.md — loop 台帳（全ての会話・実行は規定された loop の一つである）

> 正本（ADR 0026 §5・0035・#201 再編 2026-07-07）。**全てのセッション（人間との対話・agent の
> run・常駐パス）は下表のいずれか 1 つであり、その loop の唯一の終端でだけ終わる。**
> 迷ったら: 実装がしたくなったら task 起票へ、判断が要るなら escalation へ。

## 原則

シンプルに（機構は追加より削除）。main の機械ゲートは **CI ただ一つ**（PR + required check
`gate`・branch protection）。**状態は保存せず gh から導出**（ADR 0031）。人間の入力面は
**GitHub Projects の盤面**（Ready への移動・裁定 comment）に一元化（ADR 0035）。

## loop 一覧と唯一の終端

| loop | 回す者 | 起動条件 | やること | **唯一の終端** |
|---|---|---|---|---|
| **orchestrator（配車）** | launchd（5 分間隔）→ `scripts/orchestrator.mjs` | 常駐 cadence | gh 全状態を導出 → 分類（下記 4 クラス＋待機）→ 並列 dispatch（上限 5・live マーカーで実行中 skip）→ 盤面/label 投影 | **全子 spawn 完了**（子ライフサイクルは `dispatch-runner.mjs` に委譲・cross-pass breaker は `outcomes.jsonl` ledger） |
| **実装（task loop）** | driver `scripts/inner-loop.mjs <n>` | open task-request：無印は即・needs-review は **盤面 Ready** 検出後 | TASK_PLAN（plan-format 注入）→ PLAN_REVIEW（機械・RED は所見注入で再試行 2）→ IMPLEMENT（worktree）→ **LAND**＝PR 作成（arm しない）→ review 周回（PASS で arm／CHANGES 差し戻し 2 周・全周回所見は PR コメント） | **CI GREEN → merge → issue close（Done 導出）**、または **escalation label 投函** |
| **plan-task（分解）** | 同 driver（needs-plan label） | needs-plan 付き issue | PLAN → 出力検証（書式 NG は所見差し戻し 1 周）→ **子 issue 投函**（blocked-by・in-loop 起票は個別承認不要 = hook スコープ裁定）→ 親 close | **子の投函＋親 close**（PdM 判断が要る時のみ ASK_PDM 停止） |
| **教材（explain）** | orchestrator が runner（`claude -p`・最小権限）を dispatch | needs-review × 読み物なし | skill（explain-diff）で教材生成 → Discussion（Explain）投稿 → done-explain 冪等付与 → **explains/ 正本の自動 PR** | **publish**（対象へのリンク comment 込み） |
| **PR review（記録）** | `scripts/review-engine.mjs`（orchestrator dispatch） | 非 driver 産 open PR × 記録なし | reviewer をローカル spawn → marker 付き PR コメント | **記録の投稿**（non-blocking・ADR 0028） |
| **escalation 対応** | PdM（＋監査役の補助） | **escalation label**（機械が投函・レポートは comment） | 盤面 Escalated 列で読む → 裁定を issue に書く | **裁定 comment → label 除去（または Ready／close）** |
| **前進（outer 対話）** | 監査役（このセッション類） | PdM との対話 | 問題の言語化・選択肢の提示。**loop 外の起票は PdM の明示承認が必須**（hook が確認を強制） | **起票 or 記録された不起票判断** |
| **rubric・統治管理** | 監査役が起草 | 基準・文書の欠落/誤り | rubrics/・skills/・design/・adr/ の改訂起草（外部空間は inner に触らせない） | **ゲート経由の landing** |
| **harness-release（版改修）** | 監査役（outer）＋PdM 一括承認 | loop 本体・ゲート・配車の意味論に触る改修（ADR 0036） | 版として scope 全確定 → **bootstrap 編成（worktree 隔離 subagent の波状並列）で一括実装**。各着地は PR＋前置 review＋CI。**走行中の loop 自身に改修を食わせない** | **全スライス着地 → 常駐再読込 → 事前定義の機械検証 GREEN → 完了記録付き close** |
| **harness-hotfix（緊急路）** | 監査役＋PdM 同期承認 | gate/loop 自体の故障 | 最小修正 | **生きているゲートを全て通した着地＋記録** |
| 感知（meta-loop） | `scripts/meta-loop.mjs` | cadence／PdM 指示 | run 監査 → 結果分類 13 行 | finding 記録（**実走実績ゼロ・未通電**） |
| **実験 loop** | `node scripts/experiment-loop.mjs --experiment <path>` | rubric/skill 改訂案（`experiments/<id>/experiment.json`：改訂前後の rubric ファイル＋事前宣言の予想差分） | 同一 rubric を baseline → candidate の順で gate 実行し、予想差分と観測を照合→採否判断 | **採否判断の記録**（`.lathe/experiments/<id>.json`）。採用の場合も main への着地は別途 PR+CI 経由（ADR 0030 §0） |

## 状態の台帳（機械が読む面）

- **label**: `task-request`（task の印）／`needs-review`（人間承認要 — Ready まで実装しない）／
  `needs-plan`（分解型。planner 統合まで暫定維持）／`needs-explain`→`done-explain`（教材）／
  `escalation`（裁定待ち）／`hold`（dispatch を一時停止 — 故障に数えない・ADR 0037）
- **盤面（Projects #2・機械が読むのは Ready のみ、他列は投影）**: Backlog（機械作業中）→
  Approval（needs-review・教材あり・読む番）→ **Ready（承認＝人間だけが動かす）** →
  In progress → In review → Escalated（裁定待ち）→ Done（close 自動）
- **status は導出**: open=To Do／参照 PR open=In Progress／merge close=Done

## セッション開始時の loop 宣言（観測であって規範ではない）

最初の実作業前に「どの loop か・終端は何か」を 1 行宣言する。宣言は防止装置ではない
（防止は git 層と hook が担う）——逸脱検出のための観測点である。

## この台帳の変更

統治文書。起草は監査役・landing はゲート経由・loop の増減と終端変更は PdM 承認を要する。
