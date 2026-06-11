# ADR 0007: Phase 2 finding モデルと開始ゲート決定

- Status: accepted
- Date: 2026-06-11
- 決定者: yutaro0915（設計ドラフト: Claude、材料: archive format v2 読解 + Phase 1 実装の実態）

## Decision

[design/phase2-finding-model.md](../design/phase2-finding-model.md) のモデルを採用し、未決 4 点を以下で確定:

1. **findings.kind 初期語彙 = 4 種**: `failure_loop` / `unattributed_diff` / `excess_cost` /
   `risky_action`。語彙追加は採否データが溜まってから（複雑系の学習順序）
2. **MCP transport = stdio**。消費者はローカル analyst loop と Claude Code / Codex のみ。
   HTTP 化はサービス化時に再判断（issue #4 と同じ線引き）。
   tool surface: `list_sessions` / `get_session_bundle` / `query_findings` /
   `get_evidence_context`（読み 4）+ `submit_finding`（書き 1）
3. **analyst candidate = 3 系統並列**: ルール型 / LLM 読解型 / ハイブリッド。
   選抜 fitness は (a) 既知インシデント replay（smoke gate、最適化対象にしない）
   (b) ユーザー採否ストリーム（本命）
4. **ハーネス版数の採取は notify hook に含める**（Stop 毎に artifact 集合を hash、数 ms。
   fail-open 維持）。過去分は git 履歴から ingest 側で backfill

## スキーマ（要旨。詳細は design 文書）

- `harness_artifacts` / `harness_versions`（ADR 0005 の具現）+ `sessions.harness_version_id`
- `findings` / `finding_evidence`（subject_kind + subject_id 明示参照）/ `finding_verdicts`
  （採否はフォーマット非埋め込み・別テーブル — archive v2 の教訓を踏襲）
- 1 回の migration でまとめる（ADR 0006 §2 と同じ方針）

## Consequences

- Phase 2 の表示面: findings 一覧 + 採否 UI（**1 クリック + 理由一言**が要件）
- G7（Phase 6 回帰検知）の前提となる「スコア ⇄ ハーネス版数」座標がここで成立
- analyst の出力は現象レベル（ハーネス語彙に踏み込まない）— ROADMAP P2 境界を維持
