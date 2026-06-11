---
title: Phase 2 — finding データモデル設計ドラフト（開始ゲート用）
status: accepted（2026-06-11 ユーザー裁可: kind 4 種 / stdio / analyst 3 系統 / hook 採取 → ADR 0007）
created: 2026-06-11
updated: 2026-06-11
---

# Phase 2 finding データモデル 設計ドラフト

ROADMAP「Phase 2 開始ゲートで確定する界面契約」1〜7 の設計たたき台。
材料: lathe-phase7 archive format v2 の読解（2026-06-11、`spec/archive-format-v2.schema.json` /
`src/core/types.ts` / `adr/0002` / `src/judge/rubric.ts`）+ ADR 0005 + G9/G1 実装の実態。

## 1. ハーネス版数（ADR 0005 の具現。最優先の界面契約）

```sql
harness_artifacts(project_id, path, providers TEXT[],  -- binding（実測由来を優先）
                  PRIMARY KEY (project_id, path))
harness_versions(id, project_id, provider, content_hash,  -- provider が読む subset の hash
                 captured_at, git_commit,                  -- 再構成可能性の根拠
                 PRIMARY KEY (id))
sessions.harness_version_id REFERENCES harness_versions(id)  -- 座標スタンプ
```

- 版の採取タイミング: ingest / notify 時に cwd の artifact 集合を hash（git 履歴から遡及 backfill 可）
- agent はエンティティ化しない（ADR 0005 §2）。runner / model / harness_version_id は
  sessions に既在 or 本追加の**記録列**で、ビューはすべて GROUP BY 導出

## 2. finding モデル

```sql
findings(
  id, created_at,
  analyst TEXT,              -- どの candidate analyst が出したか（選抜プロトコルの単位）
  kind TEXT,                 -- failure_loop / unattributed_diff / excess_cost / risky_action / ...
  title TEXT, body TEXT,     -- 現象レベルの記述（ハーネス語彙に踏み込まない。ROADMAP P2 境界）
  confidence REAL,           -- analyst 自己申告 0-1（v2 の ambiguity prescore を踏襲）
  harness_version_id,        -- 観測時のハーネス座標（G7 の前提）
  project_id
)
finding_evidence(
  finding_id,
  subject_kind TEXT,         -- session / event / hunk / pr / turn（v2 の subject_kind+subject_id 方式を踏襲。pointer 文字列は不採用）
  subject_id TEXT,
  note TEXT
)
finding_verdicts(            -- G3: 採否はフォーマットに埋め込まない（v2 の教訓を踏襲）
  finding_id, verdict TEXT,  -- accept / reject
  reason TEXT,               -- 一言（採否 UX 要件: 1 クリック + 一言）
  decided_at, decided_by DEFAULT 'user'
)
```

### archive v2 からの踏襲 / 棄却（読解結果の反映）

| v2 の知見 | 判断 |
|---|---|
| Decision-as-first-class（question/answer/rationale） | **踏襲（変形）**: finding 自体を一級エンティティ化し、根拠は finding_evidence で明示参照 |
| subject_kind + subject_id の明示参照（pointer 文字列でなく） | **踏襲**: query/filter で扱いやすい実証済み形 |
| ambiguity prescore（judge 0-1 + heuristic fallback） | **踏襲**: findings.confidence。decision の材料であって判定ではない |
| 採否 boolean をフォーマットに埋めない（スコア → 下流判定の 2 段） | **踏襲**: verdicts を別テーブルに分離。閾値変更・再判定に強い |
| metadata への混在記録 | **棄却**: 一級フィールドに昇格させる（v2 自身が改訂で学んだ点） |
| MobSession / drift_history | **見送り**: 単独 dogfood に協働構造は不要。Phase 6 以降に必要なら再評価 |

## 3. G2「有意義な finding」の運用定義（初期値。採否で結晶化）

- 初期 heuristic: 「ユーザーが採否判定で **accept + 行動（ハーネス編集 or task 化）**に至る見込みが
  ある指摘」。選抜プロトコル（ROADMAP P2 ゲート 6）の fitness:
  (a) 既知インシデント replay = smoke gate（最適化対象にしない）
  (b) 運用採否ストリーム = precision の本命
- verdicts の蓄積を分析し、定義の改訂は本文書の追記で行う（複雑系 → 煩雑系への移行記録）

## 4. MCP server transport（論点 #7 のたたき台）

- 候補: stdio（ローカル agent 専用・最小）/ HTTP+SSE（Web UI と同居・将来の外部 agent）
- **推奨ドラフト: stdio で開始**。理由: Phase 2 の唯一の消費者はローカルの analyst loop と
  Claude Code/Codex（どちらも stdio MCP を直接話せる）。HTTP 化は notify と同じ
  「サービス化時に再判断」線引き（issue #4 と同型）に従う
- tool surface 最小案: `list_sessions` / `get_session_bundle` / `query_findings` /
  `submit_finding` / `get_evidence_context`（読み 4 + 書き 1。書き込みは finding 提出のみ）

## 5. 未決（Phase 2 ゲートでユーザー裁可）

1. findings.kind の初期語彙（上記 4 種で始めるか）
2. MCP transport（推奨 = stdio）への裁可
3. analyst candidate の初期数（並列 probe を何系統で始めるか。推奨 3）
4. harness_versions の採取を notify hook に含めるか（hook 軽量性 vs 即時性）

本ドラフトは Phase 1 終了ゲート通過後に選択肢つきで諮り、ADR 0007（finding model）として確定する。
