---
name: meta-audit
description: Lathe MCP に接地して問題点を探る事後監査。使える MCP tool と返る情報のマップ＋進め方を簡潔に置くだけ（固定 pipeline にしない）。対象と問いは呼び出し側が渡す。重い/並列の掘削は subagent に委譲してよい。read-only（提案だけ・skill/rubric/コードを自分で変えない）。閾値など変動基準は rubric 側。
grounded_in: []
---

# meta-audit — Lathe データに接地した事後監査

meta-auditor agent（opus）がこれに従う。**read-only**（skill / rubric / コードを変更しない。提案だけ）。
**目的＝問題点を探る**（任意の非効率・抜け・リスク・無駄）。狭めない。cost / loop は**例**であって定義ではない。

## 使える MCP tool と返る情報（これが接地面・生 DB/SQL は叩かない）

段階開示の梯子。**安いところから始め、必要な分だけ深く**降りる（一度に全部は開示しない）。

- **`list_sessions({project_id,runner,model,limit,offset}, order_by)`** → `{ total, sessions[] }`。各行に triage 指標（`status / turnCount / toolCount / bashCount / subagentCount / errorCount / costUsd / durationMs / model / runner / startedAt / parentSessionId`）。`order_by = error_count | cost_usd | turn_count | duration_ms | started_at`（全 DESC）で「臭う順／直近順」に並ぶ。**まずここで suspect を選ぶ**。
- **`get_session_events(session_id, {seq_from, seq_to, subagent, types, errors_only, limit, offset})`** → `{ total, seqRange, events[] }`。turn の**背骨**＝ `seq / type / actor / title / command / exitCode / durationMs / tokenUsage / subagent`（**本文なし**）。長い session でも overflow しない。**どの turn が問題か位置特定**。`errors_only`（exit≠0 のみ）/ `subagent`（thread 別。multi-track の帰属に有効）/ `seq` 範囲で絞る。
- **`get_session_bundle(session_id)`** → 1 session の全部（session 指標＋**全 event 本文**＋changedFiles＋hunks＋attributions＋PR）。**重い**。短い session か、背骨で絞り切れない時だけ。
- **`query_findings({kind, verdict, session_id, project_id, analyst, limit})`** → 既存 finding ＋ evidence 論理座標 ＋ analysis ＋ verdict。**過去の指摘と採否**を参照（再発か・既知かの判定材料）。
- **`get_evidence_context({subject_kind, subject_id, session_id, locator, evidence_id})`** → 特定 1 turn / event / hunk / PR の**生 context**。背骨で当たりを付けた seq の全文をここで読む。
- **`submit_finding({...})`** → 指摘を finding として提出し採否フローに乗せる（**書き込み**）。read 専用環境では無効化されていることがある。

## 進め方（固定 pipeline にしない・自由度を残す）

- 呼び出し側が**対象（scope）と問い**を渡す。毎回フルバッテリーは回さない（指示された範囲・観点を正確に）。
- list_sessions の triage → 必要なら背骨 → 必要なら生、と**必要な分だけ降りる**。決め打ちの順序を強制しない。
- **重い/並列の掘削は subagent に委譲してよい**（自分の文脈を汚さない・扇状に同時調査）。例: suspect が複数なら session ごとに subagent を投げ、各自が背骨→生で掘って小さな結果（問題・evidence 座標・原因仮説・confidence）を返す。**呼ぶか・何個かは状況で判断**（しない選択も含め決め打ちしない）。
- 数値で取れる基準は rubric（変動層）を参照。取れない定性は judge / skill に残す。
- **bindings の見直し待ちキューを確認する**: `node rubrics/bindings/lint.mjs --report`（skill の根拠 rubric が改訂され `verified` が古い組＝再検証待ち。staleness は gate でなく結果整合＝ここで拾う。ADR 0018 前線 A）。

## 出力

- 問題ごとに: `分類(keep / improve / fix) ＋ 優先度 ＋ 観点 ＋ 具体策 ＋ 根拠(実データ＝session_id + seq 等の座標)`。keep を先に置く（constructive・人でなく仕組みを直す）。
- 対象が未 ingest なら「対象なし」と返す（推測で埋めない）。
- skill / rubric の変更は**提案まで**。自分で編集しない。採否は OPUS。

## 不変の前提

- read-only・事後。接地は **Lathe MCP**（生 DB/SQL を直接叩かない＝将来の自律 lathe agent と同じ道具で動かし、その振る舞いを今ここで検証する）。
- 数値化できない meta 層は judge / skill。
