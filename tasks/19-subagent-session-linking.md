---
id: 19
title: サブエージェント session の親子リンク（spawn_agent → 子 session 突合）
status: in-progress
assignee: codex (/goal loop)
depends_on: [14]
estimated: medium
workflow: loop
audit: A   # ingest 正確性
bound: 20 turns / 2h
---

## What

codex のサブエージェントは独立 rollout として既に ingest 済み（例: 親 `019e67d2…` の
spawn_agent 戻り値 `{"agent_id":"019e69f2-5b60-7c01-9f7b-a3d71fa463e8"}` → 同 id の
session が DB に存在、title "Context: Work in …"）。しかし親子リンクが無いため
Subagents タブが STEPS 0 / COST – と表示される。リンクを張り、表示を実体に合わせる。

1. **ingest（codex）**: 親 transcript の `spawn_agent` function_call と
   `function_call_output`（call_id で対応、output JSON の `agent_id`）を突合し、
   - subagent イベント（type=subagent）の meta に `child_session_id` を記録
   - `sessions.parent_session_id` + `sessions.spawned_by_seq`（新カラム、migration。
     sessions は derived 層なので full ingest で再構築可能なこと）
   - 子 transcript が未 ingest（ファイル無し等）の場合は NULL のまま（捏造しない）
2. **ingest（claude code）**: 同等のサブエージェント（Task tool / agent-*.jsonl）が
   現状どう ingest されているか確認し、同じ親子リンクが可能なら同様に。不可能なら
   理由を docs に記録して codex のみで完了（スコープ拡大しない）
3. **UI: Subagents タブ**: 各サブエージェントについて、リンク済みなら子 session の実数
   （steps / tool calls / model / duration / tokens / cost）を join で表示 + `OPEN SUB-SESSION →`
   導線。リンク不能なら `internal steps not captured` と正直に表示（ダッシュの羅列をやめる）
4. **UI: 左 rail**: `parent_session_id` を持つ session に `SUB` バッジ。既定で非表示にし、
   rail 上部に `show sub-sessions` トグル（既定 off）。親の Subagents タブから辿れることが前提
5. **集計**: overview / stats の合計は session 単位のまま（二重計上しない）。親 session の
   ヘッダ集計も従来どおり（子を合算しない）

## 受け入れ条件（すべて機械検証）

| # | 条件 | 検証 |
|---|---|---|
| 1 | spawn→子 session リンク | full ingest 後、spawn_agent 戻り値に agent_id がある親子で `sessions.parent_session_id` が張られる（実データ: `019e67d2…` の子に `019e69f2…` を含む） |
| 2 | 捏造なし | agent_id が DB に無い場合 parent_session_id を張らない（NULL）。検証スクリプトで件数照合 |
| 3 | Subagents タブ実数 | 新 e2e: リンク済みサブエージェントに steps>0 / cost / model が表示され、OPEN SUB-SESSION で子 session viewer へ |
| 4 | 正直表示 | 新 e2e: リンク不能サブエージェントは `internal steps not captured` 表示 |
| 5 | rail | 新 e2e: SUB session は既定で rail に出ない、トグルで出る |
| 6 | 二重計上なし | overview 合計が本変更前後で不変（cost/tokens/sessions 数。検証スクリプトで前後比較） |
| 7 | 回帰なし | e2e 全件（既知 issue #7 の 1 件を除く）/ build / coverage GREEN |

## Out of scope

- 子 step を親 transcript にインライン展開する表示（リンク遷移で足りる）
- chat（休眠中）

## Loop 運用

- 作業ブランチ: `loop/19-subagent-linking`（main から分岐、worktree /tmp/lathe-subingest）
- migration を伴うため、検証は scratch schema または専用 DB で行い共有 DB を汚さない
  （tasks/14 監査の教訓）。full ingest の最終確認のみ共有 DB（localhost:55432）で可
