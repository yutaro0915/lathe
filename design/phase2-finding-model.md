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

## 6. 追補（2026-06-11 ユーザー承認 — P1 接続の前提とチャット view）

### 6.1 二層テーブル（gap A）— ユーザーデータを掃除から守る

テーブルを **導出層**（transcript 等から再構築可能。reset 型 ingest の対象）と
**永続層**（再生成不能。reset 禁止）に区分する。

- 永続層: `findings` / `finding_evidence` / `finding_verdicts` / `harness_versions` /
  `chat_threads` / `chat_messages`（§6.4）/ `annotations`（既存。実は同じ性質 — 本対応で永続層へ）
- `pnpm ingest`（catch-up sweep）は導出層のみ DROP/再構築。**受け入れ条件で「sweep 後も永続層が生存」を機械検証**

### 6.2 evidence は論理座標（gap B）

`finding_evidence` は event 行への FK でなく **論理座標**で参照する:
`(subject_kind, session_id, locator)` — locator は step なら seq、turn なら turn 番号、
hunk なら file path + hunk seq、pr なら pr number。再 ingest 後も同じ座標に同じ内容が
再生成される。解決失敗時は UI で「根拠は更新された」を明示（隠さない）。

### 6.3 実行トリガー・洪水対策・指定スコープ（gap C/D + ユーザー追加）

- rules-v1 のみ notify 連動で自動。llm-v1 / hybrid-v1 は手動 CLI（運用で頻度を学んでから定期化判断）
- 提出上限: 1 実行 × 1 candidate あたり 20 件、confidence 降順。重複 key = (analyst, kind, 主 evidence 座標)
- **指定スコープ検出（2026-06-11 ユーザー要求）**: `--session <id>` / `--turn <session>:<n>` で
  明示対象に絞った検出ができる。UI からも session / turn 単位で「Analyze」を起動できる

### 6.4 agent チャット view（2026-06-11 ユーザー要求）

- **専用画面**（パネルでなく 1 画面 = `/chat` route。左: thread 一覧 / 中央: 会話）
- 用途: 観測データについて agent と対話しながら分析する（「このセッションなぜ高い?」
  「この turn を分析して」→ 指摘は finding として提出され採否フローに乗る）
- **道具制限が境界**: チャット agent に与えるのは lathe MCP 5 tools のみ（ファイル編集・bash なし）。
  コーディング agent 化させない（ROADMAP 設計境界）。ハーネス改善は文章提案まで、適用は人間
- 実行基盤: **CLI provider 抽象**（`claude -p` / `codex exec`、subscription 完結。
  speak-loose-english の実証パターン）。API key は env fallback
- 履歴: `chat_threads` / `chat_messages`（永続層）。session / finding を thread に attach できる
  （文脈の持ち込み）

### 6.5 自己観測の汚染対策

内部実行（llm analyst / チャット agent）の transcript も lathe に取り込まれる。
**隠さずに印を付ける**: 内部実行は識別タグ（project = lathe-internal 等）で記録し、
既定でセッション一覧から非表示 + G9 異常検知の baseline 母数から除外（フィルタで表示可能）。
