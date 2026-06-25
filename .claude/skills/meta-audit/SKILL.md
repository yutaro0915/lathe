---
name: meta-audit
description: 指定された分析対象と分析タイプだけを、Lathe のデータに接地して監査する手順。何を分析するかは呼び出し側が必ず渡す（毎回 cost/loop を全部はやらない）。meta-auditor agent が従う。閾値などの変動基準は rubric 側。
---

# meta-audit — 事後監査の手順

meta-auditor agent がこれに従う。**read-only**（skill / rubric / コードを変更しない。提案だけ）。
ここに置くのは**変わらない手順**。個々の判断・採否・閾値は OPUS / rubric が持つ＝ここに決め打ちしない。

## 大原則（毎回フルバッテリーを回さない）
- **何を・どの観点で分析するかは呼び出し側（OPUS）が必ず渡す**。skill 側で「常に cost も loop も全部見る」はしない。
- **指示された分析タイプだけを正確に返す**。指定外（例: 普段の開発で毎回 cost）は勝手にやらない（不要・非効率）。
- 観点は**メニュー**。分析タイプは後から足す（narrow-now / expandable-later）。各タイプは独立に追加・実行できるよう分離して書く。
- verify skill の「影響クラスに該当する分だけ・全部はやらない」と同じ思想。

## 入力（呼び出し側が必ず指定）
1. **分析対象**: スコープ（session id 群 / project / 期間 / この変更サイクル）。原則 **Lathe に ingest 済みのデータ**に接地する。未 ingest なら対象が無い＝先に ingest。
2. **分析タイプ / 問い**: 下記メニューから 1 つ以上、または具体的な問い。**渡されたものだけ**実行する。

## 分析メニュー（指定されたものだけ実行・接地は Lathe）
- **loop / stall**: turn 数・往復・同種エラー反復。`transcript_events` の `command × exit_code` 集計（必ず `AND command<>''`。空コマンド〔約 1/4、heredoc/hook 由来〕は取りこぼす既知制約）。
- **cost / 効率**: cost 異常。**runner 別 avg 倍率**で正規化（runner 間で turn/cost が数倍違うため混在 avg は歪む）。閾値は rubric（変動層）。
- **rubric 化点**: 繰り返す手作業判断 → rubric 化提案。根拠＝**再発の回数**。
- **reinforce（効いた点）**: 数値で取れない定性観点。**Lathe 接地外＝judge/skill 残置**。
- （追加タイプは後から。）

## 手順
- 一次トリアージは `sessions` の集計列（`turn_count / error_count / cost_usd / subagent_count`）、ドリルダウンは `transcript_events`（二層。重い走査は候補が絞れてから）。
- **数値で取れる基準は rubric（変動層）を参照**。取れない定性は judge/skill に残す（射程の線引き＝numeric は Lathe、non-numeric は judge/skill）。

## 出力
- **指示された分析タイプの結果だけ**。各 finding: `分類(keep / improve / fix)` / `優先度` / `観点` / `具体策` / `根拠(実データ)`。指定タイプ内では keep を先に置く（バランス・constructive framing、人でなく仕組みを直す）。
- 指定外は出さない。データが無い（未 ingest）なら「対象なし」と返す（推測で埋めない）。
- skill 変更の提案は「滅多に変えない」前提で再発の証拠を必須に。**自分では変更しない**。採否は OPUS。

## 不変の前提
- read-only・事後。skill / rubric / コードを編集しない。
- 接地は Lathe（Phase-1: `sessions` / `transcript_events`、Phase-2: `findings` / `attributions`）。数値化できない meta 層は judge / skill。
