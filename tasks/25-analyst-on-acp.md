---
id: 25
title: analyst を ACP セッションの consumer に載せ替え（loop/21 深掘りを B 上で整合）
status: in-progress   # 2026-06-17 unblock: tasks/24 実スモーク GREEN + xhigh 監査 merge 可 + main 着地（3432ee0）
assignee: codex (/goal loop)
depends_on: [24]
estimated: large
workflow: loop
audit: A
bound: 50 turns
---

## What

[ADR 0009](../adr/0009-agent-as-core-module.md) に従い、analyst の **LLM 駆動部を ACP セッションに置換**する。
analyst は「ACP セッションを 1 回駆動する非対話 consumer」になる。loop/21 の深掘り（cause/intent/impact +
env-vs-product）と backlog を B 上で整合させ、まとめて main へ。

**前提**: tasks/24 の実スモークが「claude-agent-acp + lathe MCP で tool 実呼び成立」を実証していること。
未実証なら本 task は着手しない（status: blocked のまま）。

## 実装方針
1. **rules-v1 検出は残す**（前処理。provider 非依存、LLM 不要）。
2. [analyst-engine.ts](../apps/web/scripts/analyst-engine.ts) の provider 部（`selectLlmProvider`/`callLlmJson`/
   `spawnSync('claude')` 周辺 ~536-724、prompt schema 直書き）を **撤去し**、`@lathe/acp-client` の `runSession` 呼び出しに置換。
3. **finding の出力経路**: ACP では agent に lathe MCP の `submit_finding` を呼ばせる形を第一候補にする
   （`claude -p` の JSON パースを廃し、構造化投入を MCP 経由に。先のコード品質監査「JSON パース脆弱 / incident 知識ハードコード」を同時に解消）。
   - dry-run はその submit を抑止するモードで実現。
4. **深掘り instructions**（cause/intent/impact + env-vs-product）は session に渡す instructions/context として注入
   （将来 SKILL.md 化できる形に。ADR 0009 §skill）。
5. **loop/21 からは「analysis モデル（`analysis` JSONB + `backlog_status` 等）の migration」と「深掘り analysis の中身」だけを取り込む**。
   **loop/21 の findings UI（3-panel）/ backlog UI は取り込まない** → design system 建て替え（論点 #18）へ defer。
   本 task は **backend（analyst の ACP 化 + analysis schema/migration + `submit_finding` 経路）に絞る**。UI は現行のまま（壊さない）か最小。

## 受け入れ条件
- analyst が ACP セッション経由で finding を生成し、lathe MCP `submit_finding` で投入（実 incident で実走）。
- finding に深掘り analysis（cause/intent/impact + env-vs-product）が入る。`analysis` 列の migration 適用（冪等）。
- `verify:finding-depth`（recall + insight、generic 拒否は維持）/ build / E2E_PORT 指定 e2e / coverage 全 GREEN。
- rules-v1 は LLM 不要のまま動く。dry-run は submit しない。
- #110-114 が深掘り（env-vs-product 含む）であることを実 DB 読みで確認。共有 DB を汚さない（scratch）。
- 旧 provider 直叩き（spawnSync('claude')/anthropic API fetch）が analyst から消えている（grep）。

## Out of scope
- chat（P2.5）。dual-operability UI 本体。**loop/21 の findings/backlog UI（3-panel）= design system 建て替え（#18）へ**。

## Loop 運用
- ブランチ `loop/25-analyst-acp`（main から）。loop/21 を取り込む。commit prefix `[25]`。
- 監査 Tier A、**Codex xhigh**。
