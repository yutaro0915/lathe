# ADR 0022: EDD 前線2 — run validity（5 値報告語彙・severity 判定接続・invalid の分離）

- status: accepted（2026-07-03 ユーザー承認。check の位置づけ（rubric 内の拒絶理由最小単位・5 値は check 単位）を確認の上で裁可。severity 再監査は 2e4c86e で先行実施＝31 major→blocker・warn 空集合開始。実装は worktree 委譲・監査役着地）
- date: 2026-07-03
- 入口文書: `/Users/cherie/LLMWiki/projects/edd-theory/handoff/lathe-rubric-system-decomposition.md`（§4 注記: 前線2 は独立に走らせられる・報告語彙は 5 値＋集約優先順位で確定＝LEDGER-0034、両 ADR がこれに従う）
- **受け入れ条件 = [`evals/run-validity-v1.md`](../evals/run-validity-v1.md)**
- 理論の正本: edd-theory `theory.md` §run validity（報告語彙・invalid 二分岐帰属・judge 但し書き）・§結果分類（行 6/7）
- 関連: [ADR 0011](./0011-rubric-schema-v2.md)（severity を記録のみで導入＝本 ADR がその判定接続）/ [ADR 0021](./0021-front-d-selection-layer.md)（not-run を先行導入＝本 ADR で語彙を完成）
- 実装規律: 監査役単独 writer（実装は worktree 委譲・監査役が diff レビュー着地）。**本 ADR は run.mjs の報告・集約挙動の変更を授権する**

## 対象（前線2、1 前線 1 関心）

「正しさ（rubric の pass/fail）」と「手続きの正しさ（run が宣言どおり実行されたか）」を報告語彙で分離する。**確定済み（再議論しない）**: 5 値 = pass / fail / warn / invalid / not-run、集約 = fail・invalid のいずれか 1 つで停止／warn のみ通過（receipt 必列挙）／not-run は通過を妨げない（receipt 必須）／minor は warn に畳む。

## 決定

### 1. 分類・集約の純関数 `rubrics/verdict.mjs`（新規）

check の実行結果（evalExpect の真偽・severity・手続き故障の有無）→ 5 値への分類と、5 値列 → run 全体の集約（exit code・summary）を**純関数**として切り出し、run.mjs が import する（負テスト対象＝eval の criterion 6。既存の `_schema` / `select` と同型の様式）。

### 2. invalid の機械検知範囲 v1（エンジンが自力で「判定不能」を知れるものに限定）

以下は **fail でなく invalid（帰属: harness）**として報告する——現在はすべて RED に化けている:

1. verifier 定義の解決失敗（verifiers/<id>/verifier.json 不在・JSON 不正）
2. チャンネル欠落（verify.channel が produces に無い——現在 throw→RED）
3. extract の実行失敗
4. judge の VERDICT 抽出失敗（最終行に VERDICT:<int> が無い）・timeout
5. judge の binding 解決失敗（未知 class・未対応 provider）

**帰属の既定は harness**（機械はそこまでしか知れない。eval 帰属＝宣言自体の欠陥への付け替えは、人間の診断＝§結果分類 行 6 の操作であり receipt を書き換えない——診断記録は escalation / issue 側）。環境前提の未成立（scratch DB 落ち等）は v1 では機械検知しない——テスト失敗として現れ TRIAGE が playbook（P4/P5）で invalid 相当と診断する現行運用を維持し、**precondition 宣言の機構は実需の再発時に導入**（YAGNI）。

### 3. severity の判定接続と再監査（挙動変更を意図的な集合に限定する）

対応は確定どおり **blocker→fail / major→warn / minor→warn**。ただし現在の severity（blocker 6 / major 20）は「記録のみ」時代の割当で、major の多くは**事実上の hard gate として運用されてきた**。接続をそのまま入れると 20 check が突然非停止化する＝意図しない gate 緩和。よって:

- **接続前に監査役が全 check の severity を再監査**する。原則「現行の停止挙動を維持すべきもの＝blocker へ昇格」とし、**warn 残留は『violation が既に許容・情報性・漸進 ratchet 系』の check に限定**（見込み数件）。対照表（check / 旧 severity / 新 severity / warn 化の理由）を切替 commit に添付する。
- 結果として**切替時点の停止挙動の変化は warn 化を明示的に選んだ check だけ**になり、invalid の分離（厳格化）以外に gate は緩まない。

### 4. 表示・receipt・集約の変更（run.mjs）

- check 行の表示: `[GREEN]/[RED  ]` → `[PASS ]/[FAIL ]/[WARN ]/[INVALID]/[NOT-RUN]`（invalid は `帰属=harness ＋ 故障内容`、not-run は理由を併記）。tier で絞られた check の `[SKIP ]` は `not-run（reason: tier）` に統合（D の選定 not-run と語彙を統一）
- summary: 5 値のカウント（例 `PASS 40 / WARN 2 / INVALID 1 / NOT-RUN 12 → 停止`）
- exit code: fail または invalid が 1 つでもあれば 1、それ以外 0
- `--receipt` JSON に check 単位の 5 値・帰属・理由を追加（将来 #43 の runs ingest がこれを飲む）

### 5. 消費側の最小接続（inner loop）

verify / test-triage skill に各 1 行: **invalid は IMPLEMENT に差し戻さず、harness/環境の問題として即 escalate**（playbook P4/P5 の教訓の機械語彙化。夜間に人間の切り分けでやっていたことが receipt から直接読めるようになる）。skill 編集は監査役。

### 6. 検証系の検証（theory の負テスト要請）

verdict.mjs の負テスト: 故障 verifier fixture・不形式 judge 出力・severity 別分類・集約優先順位（fail/invalid 停止・warn 通過・not-run 非妨害）。gate 化は `meta/run-validity`（0018〜0021 と同型の自己適用）。

## 受け入れ条件

`evals/run-validity-v1.md`（inline_criteria 6 つ）。着地時に checks へ gate rubric を追記して記録する。

## 却下した代替

- **major→warn を即時一括適用**: 記録のみ時代の割当に判定意味を遡及付与＝意図しない gate 緩和。再監査で意図的な集合に限定する。
- **環境 precondition の宣言機構を v1 で導入**: 機械検知できる故障（§2 の 5 類）に比べ設計が重く、現行は TRIAGE＋playbook が機能している。再発の実需で導入。
- **invalid の eval 帰属を機械で判定**: 「宣言自体が実現不能か」は人間の診断（理論も二分岐の判定を人間に置く）。機械は harness 帰属を既定とし、診断で付け替える。
- **warn の専用 minor 値**: 理論確定どおり畳む（使用実績が生じたら分離）。

## スコープ外

- 試行・集約規則の機械実行（trials n>1 の runner——非再現の扱いは §結果分類 行 8。実需時）
- judge の校正周期の自動化・RED サンプリング人間監査の機械化（運用規律のまま）
- receipt の DB ingest（#43）

## 一次情報

- handoff: `/Users/cherie/LLMWiki/projects/edd-theory/handoff/lathe-rubric-system-decomposition.md` §4
- theory: `/Users/cherie/LLMWiki/projects/edd-theory/theory.md` §run validity・§結果分類
- 実測: 2026-07-03 夜間 escalation 8 件中 3 件が invalid→fail の誤帰属（P4/P5/headless 切断）／severity 実測 blocker 6・major 20
