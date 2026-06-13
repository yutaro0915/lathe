# Phase 2 拡張: finding の深掘り + Accept の行き先（improvement backlog）

2026-06-13 ユーザー方向確定（Option A）。Phase 2 の dogfood で「採否しても何になるのか／finding が
浅い」という違和感が出た。これを「**判断するに足る深さ**」と「**採否の行き先**」で解消する。
スコープは現象レベルのまま（ハーネスの自動適用 = P5 には踏み込まない）。

## 問題（ユーザー指摘 2026-06-13）

1. finding が浅い: 「同じコマンドが繰り返し失敗」のパターン照合止まりで、**agent が何をしようとして・
   なぜ失敗し・状況はどうだったか**の文脈が無い。Accept が「判断」でなく「肩をすくめる」になる。
2. Accept の行き先が無い: 採否してもループが閉じておらず（下流 P3/P4/P5 は未着手）、「何になるのか」が
   見えない。

## 設計

### A. finding の深掘り（analyst 出力 + データ + UI）

**データ境界（要ユーザー承認）**: `findings` に nullable `analysis` JSONB を 1 本追加する。
```
analysis: {
  cause_hypothesis: string,   // なぜ起きたかの仮説（断定でなく仮説と明示）
  agent_intent:     string,   // その turn で agent が何をしようとしていたか
  impact:           string    // なぜ重要か / 放置するとどうなるか
} | null
```
- analyst（rules/llm/hybrid）が finding 生成時に、既にアクセスできる session 文脈（transcript・
  前後 turn・USER ASKED）から 3 項を埋める。埋められない項は null（捏造しない）。
- durable 層（finding に属し、full ingest で消えない）。analysis は finding 作成時の analyst 出力で
  あり、後から再生成しない（再生成は analyst 再実行 = 新 finding）。
- **スコープ境界の維持**: analysis は「現象の説明」まで。ハーネスのどのファイルをどう変えるか
  （harness vocabulary）には踏み込まない（ADR 0005 §3 / ROADMAP P2 境界と整合）。
- UI: finding 詳細パネルに `WHY / INTENT / IMPACT` セクション（observability-dense、uppercase
  micro-label）。null 項は出さない。

### B. Accept の行き先 = improvement backlog（データ + UI）

**データ境界（要ユーザー承認）**: `findings` に nullable `backlog_status` 追加。
```
backlog_status: 'open' | 'addressed' | 'dismissed' | null
```
- finding を **Accept した時点で `open`** にセット（reject では null のまま）。durable 層。
- ユーザーが「ハーネスを直した」ら `addressed`、「やっぱり対応しない」なら `dismissed` に手で遷移
  （ハーネス適用自体は P2 では Lathe の外＝手作業、ROADMAP P2 境界どおり）。
- これが「採否の行き先」: Accept = 改善バックログに積む、という意味になる。
- **P3 への橋渡し**: `open` な accepted finding が、P3 の fixture 化・改善前後比較の入力候補になる
  （P2 完了の定義「finding は archive に追加され P3 で fixture 化」を具体化）。

**UI 形（要ユーザー判断 = 下記の問い）**: backlog をどう見せるか 2 案。
- 案1: Findings 軸内に `Backlog` フィルタを追加（Pending/Decided/All と並ぶ。Backlog = accepted かつ
  backlog_status=open）。nav を増やさず IA 原則を保つ。
- 案2: グローバルバーに `Backlog` を 1 級軸として追加（Sessions/Findings/PR/Overview/**Backlog**）。
  「改善の実行リスト」を独立画面として強調。

### C. 付随: 採否後の Undo バナー残存（軽微バグ）

verdict 送信後、`Accepted … Undo` バナーが同ビューに残り route 遷移まで消えない。フィルタ変更時
または数秒で自動消去、または verdict 反映後にリスト更新と同時にクリアする。本拡張に同梱して直す。

## スコープ外（明示）

- ハーネスの自動適用・自動提案生成（P5）。analysis は説明まで、改善案の文面生成はしない。
- backlog からのワンクリック改修（手作業 + 状態手遷移のみ）。
- 採否ストリームによる analyst precision 自動測定（別途、採否が溜まってから）。

## 実装分解（承認後）

- T-a: migration（`analysis` JSONB + `backlog_status`、冪等 ALTER）+ analyst 深掘り出力（Codex、Tier A）
- T-b: finding 詳細の WHY/INTENT/IMPACT 表示 + backlog UI（案1/2 のどちらか）+ Undo バナー修正（Opus、UI）
- 各 task: 独立レビュー（Opus or Codex xhigh+）必須、UI は実ブラウザ+スクショ検証必須（hook で強制）

## 決定 / 制約（2026-06-13 ユーザー）

- **backlog UI = 案1（Findings 内フィルタ）** に決定（nav を増やさず IA 原則維持）。
- **findings は「仮」**: P2.5 で chat/agent を実装するため、depth/backlog は **chat/agent との接続余地を
  残す**（例: finding を agent と議論 / agent に改修案を起こさせる / backlog item を agent に渡す）。
  finding モデルを今 hard-couple しない。
- **データ境界（analysis / backlog_status カラム追加）の最終承認は prototype を見てから**。ユーザー要求:
  「どう役立つかの具体ストーリ・ペイン解決を実出力で示せ」。
- **進め方 = 動くものを並列で**: 提示方向が複数あるなら複数の prototype を**別ブランチ・別ポート**で
  実装し、画面で比較 → 軽い合意 → 即実装 → 画面で壁打ち。テキスト往復で止めない（手探りプロダクトに
  適したダイナミック手法、2026-06-13 ユーザー方針）。

## Prototype（承認前の価値実証 = 画面で見せる）

実 finding #110-114 に深掘り分析を生成し、**3 つの提示方向**を別ポートで起動して比較する:
- V1 Analysis-forward: 詳細冒頭に WHY/INTENT/IMPACT の合成ブロック、evidence は裏付けとして下。
- V2 Backlog-centric: Findings 軸全体を「改善ワークリスト」として再構成。accepted = 状態付きカード。
- V3 Evidence-interleaved: 各分析主張を、それを支える evidence（失敗 turn）の隣に密着配置。
prototype は schema/UI を「仮」で実装してよい（throwaway branch）。dev サーバのみ（build 禁止 = hook）。
