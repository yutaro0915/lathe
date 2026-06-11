---
id: 14
title: Phase 2 データモデル（harness 版数 + findings 系）+ hook 版数採取
status: todo
assignee: codex (/goal loop)
depends_on: []
estimated: large
workflow: loop
audit: A   # スキーマ migration + ingest + hook（界面契約の本体）
bound: 40 turns / 4h
---

## What

[ADR 0007](../adr/0007-finding-model-and-phase2-gate.md) / [design/phase2-finding-model.md](../design/phase2-finding-model.md) §1-2 の実装。**1 回の migration** で:

1. **harness 版数**（ADR 0005 の具現）: `harness_artifacts`（project_id, path, providers[]）/
   `harness_versions`（id, project_id, provider, content_hash, captured_at, git_commit）/
   `sessions.harness_version_id`。binding 判定は Phase 1 の観測イベント（memory/hook/skill 読み込み実測）優先 + ファイル名規約補助
2. **findings 系**: `findings`（analyst, kind, title, body, confidence, harness_version_id, project_id）/
   `finding_evidence`（subject_kind: session|event|hunk|pr|turn + subject_id）/
   `finding_verdicts`（verdict: accept|reject, reason, decided_at）。kind は 4 種 + CHECK 制約
3. **二層テーブル化（design §6.1）**: findings / finding_evidence / finding_verdicts /
   harness_versions / chat_threads / chat_messages / annotations（既存）を**永続層**とし、
   `pnpm ingest`（reset 型 sweep）の DROP 対象から除外する。evidence は **論理座標**
   （subject_kind + session_id + locator。design §6.2）で持つ — event 行への FK にしない
4. **hook 版数採取**: `lathe-client` の hook が Stop 時に cwd の harness artifact 集合を hash して
   payload に `harness_hash` を追加（数 ms、fail-open 維持）。notify 側で harness_versions を upsert し
   session にスタンプ
5. **遡及 backfill**: ingest 時、session の git_branch / commit から harness 版を git 履歴で再構成
   （再構成不能な session は NULL のまま — 捏造しない）

## 受け入れ条件（すべて機械検証）

| # | 条件 | 検証 |
|---|---|---|
| 1 | migration 後も既存全パイプライン GREEN | `pnpm -F web ingest` PASS / coverage GREEN / e2e 全件 PASS |
| 2 | hook 採取 | 検証スクリプト: hook に stdin JSON を流すと payload に harness_hash が含まれ、計測 overhead < 50ms。token/server 不在でも exit 0（fail-open） |
| 3 | 版数スタンプ | notify 経由 ingest で session に harness_version_id が付与され、同一 artifact 状態の再 notify で**同一版に解決**（冪等） |
| 4 | 共有 artifact の意味論 | fixture: AGENTS.md（両 provider binding）変更で claude/codex 両方の版 hash が変わり、.claude/settings.json 変更で claude のみ変わる（ADR 0005 の核心の検証） |
| 5 | 遡及 backfill | 検証スクリプト: git 履歴のある実 repo の過去 session に版が再構成され、件数 + 再構成不能件数が報告される |
| 6 | findings CRUD | 検証スクリプト: findings + evidence + verdict の insert/query が動き、kind の CHECK 制約が不正値を拒否 |
| 7 | **永続層の生存** | 検証スクリプト: findings + verdicts + chat を入れた状態で `pnpm -F web ingest`（full sweep）→ 永続層の行数・内容が不変、導出層は再構築されている |
| 8 | **evidence の再解決** | 検証スクリプト: notify で session を再 ingest（delete→insert）した後も、論理座標の evidence が同じ step/turn に解決される |
| 9 | ビルド | `pnpm -F web build` / `pnpm -F client build` PASS |

## Out of scope

- analyst 本体（tasks/16）/ MCP server（tasks/15）/ 採否 UI（tasks/17）/ findings の表示面

## Loop 運用

- 作業ブランチ: `loop/14-phase2-data-model`（main から分岐）
- goal 文に「全項目 GREEN + commit まで停止しない」を明記（workflows.md テンプレート準拠）
