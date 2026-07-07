# ADR 0037: hold label — orchestrator の dispatch 一時停止

- status: accepted
- date: 2026-07-08
- 関連: #232（実装）／ADR 0030 追記 E（escalation と同型）／design/loops.md（label 台帳）

## 背景

特定 issue を orchestrator の dispatch キューから除外したい場面がある（例: 依存先が未解決でなく、
単に「今は動かしたくない」という PdM の意思）。現状は `blocked-by #N` 依存解決のみが
dispatch を抑制する仕組みであり、明示的な一時停止手段がなかった。

## 選択肢

- **(A) close して退避**: 導出 status を汚す（Done と混ざる）— 却下。
- **(B) `hold` label → `WAIT_HOLD` として skip（採用）**: `escalation` label → `WAIT_ESCALATION`
  と同型。機械が読む入力が 1 つ増えるだけで最小差分。

## 決定

`hold` label を機械可読入力として採用（label 台帳: design/loops.md）。

- `orchestrator-classify.mjs` の判定順で `escalation` 直後・`running` より前に `hold` 判定を追加。
- `hold` label が付いた issue は `WAIT_HOLD` を返す（dispatch しない・故障 breaker に数えない）。
- 既存の `blocked-by #N` 依存解決ロジックはそのまま（追加のみ、互換を壊さない）。

## 実装

- 追加 export: `WAIT_HOLD`、`HOLD_LABEL`（`orchestrator-classify.mjs`）
- label 名: `hold`（機械可読入力。変更は本 ADR の改訂を要する）
- 判定順: task-request → escalation → **hold** → running → in-progress → blocked-by → …

## 備考

ADR 0036（`0036-harness-release-loop.md`）が既に存在したため、本 ADR は 0037 を採番した。
issue #232 の plan では `adr/0036-hold-label.md` と記載されていたが、番号衝突のため繰り上げた。
