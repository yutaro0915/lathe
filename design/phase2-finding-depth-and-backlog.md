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

## Prototype ラウンド1 の結論（2026-06-13 ユーザー画面レビュー）

3 variant を別ポートで実機比較した結果:
- **価値は実証**: 深掘り分析の中身が実用的（gh `--repo` 欠如 / git diff --check を編集禁止 raw/ に当て続け /
  **rg・git diff の exit code 意味取り違えが複数 finding に通底** / sed cwd 取り違え / AivisSpeech 実行時状態
  依存）。「深掘り + backlog」は作る価値あり、で確定。
- **V3（Evidence-interleaved）却下**: INTENT/WHY/IMPACT を分散配置すると分かりにくい。**「まとめる」が大事**
  = 分析は 1 つのグループブロックに保つ。
- **V2（Backlog-centric）の tab 過剰**: Pending/Decided/Backlog の分割は価値不明（dismiss すると Decided に
  出て Backlog に出ない差が分からない）。**tab を増やさずフィルタで十分**。status バッジが散らばり読みにくい。
- **ベース採用 = V1（Analysis-forward）**: 分析を冒頭にまとめる方向。コントラスト高く読みやすい。

### イテレーション2 で直すこと（V1 ベース）
1. **分析はまとめる**（INTENT/WHY/IMPACT を 1 ブロック維持。V3 のような分散はしない）。
2. **青背景を抑える**（analysis ブロックの青が過剰。observability-dense の配色配給制に寄せる）。
3. **孤立行の解消**: analysis 直下に finding 本文が 1 行だけ浮く分割を整理（本文は分析と統合 or 適切な位置へ）。
4. **重複導線の排除**: session タイトル押下 = VIEW SESSION ボタンと重複 → 片方に。VIEW TURN も同様に整理。
5. **status を 1 箇所に集約**: list 行で ACCEPTED と OPEN 等のバッジが散在 → 1 箇所にまとめ、状態を読みやすく。
6. **sticky verdict 廃止 → 3 枚パネル構成**: 現状の sticky な ACCEPTED バーがスクロール時に背後が透けて
   気持ち悪い + 深いスクロール（上下往復）。**上ヘッダ固定 + 内側を独立スクロールの 3 パネル**
   （例: ① findings list / ② 分析 + verdict + backlog 状態（固定ヘッダ下、それ自体は浅い）/ ③ evidence・
   session 中身（独立スクロール））にして、上下往復スクロールを無くす。
7. **tab 簡素化**: Pending/Decided/Backlog の 3 分割をやめる。案: **Triage(pending) / Backlog(accepted かつ
   open、状態付き) / All**。rejected は All かフィルタで。「Decided」単独タブの混乱を排除。
8. dual-operability は維持（状態遷移は人間ボタンと将来 agent tool が叩く同一 API、discuss/deepen with agent
   プレースホルダ）。

## Prototype（承認前の価値実証 = 画面で見せる）

実 finding #110-114 に深掘り分析を生成し、**3 つの提示方向**を別ポートで起動して比較する:
- V1 Analysis-forward: 詳細冒頭に WHY/INTENT/IMPACT の合成ブロック、evidence は裏付けとして下。
- V2 Backlog-centric: Findings 軸全体を「改善ワークリスト」として再構成。accepted = 状態付きカード。
- V3 Evidence-interleaved: 各分析主張を、それを支える evidence（失敗 turn）の隣に密着配置。
prototype は schema/UI を「仮」で実装してよい（throwaway branch）。dev サーバのみ（build 禁止 = hook）。

### イテレーション3 で直すこと（iter2 への追修正、2026-06-13 画面レビュー）
iter2 は「格段に良くなった」と承認方向。残りの磨き:
1. **All タブに件数**を表示（Triage/Backlog と同様。常時でなくとも目安として要る）。
2. **evidence の command/output ブロックの縦幅を中身に合わせる**: 固定 min-height をやめ、短い出力は短く描画（無駄な余白で場所を取らない）。
3. **上部ヘッダの 3 段重ねを圧縮**: global nav 行 / 「Findings — All findings…」説明行 / 「FINDINGS … Triage Backlog All / SESSION」ツールバー行の 3 段を 2 段程度に集約し、縦スペースを findings 内容に回す（説明をツールバーへインライン化等）。
4. **Dismiss** はソフトな「対応しない」（削除でない）として残してよい — 意図が伝わる表記/tooltip に。session フィルタの位置はやや見つけにくいが今回据え置き可。
