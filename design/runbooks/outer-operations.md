# outer-operations.md — outer 運用 runbook（repo 正本）

> セッション外 memory の廃止（ADR 0026 §4）に伴う移設先。outer（監督・監査役）の
> 運用知識はここが正本。旧 memory（escalation runbook / worktree 検証規律 /
> 起票規約 / ingest no-wipe）の内容を現行基盤（Backlog.md task・単一ゲート）に
> 合わせて更新して収載する。loop の定義と終端は [../loops.md](../loops.md)。

## 1. escalation 対応の型（escalation 対応 loop の実務）

escalation は「機械が止まった」ではなく「**outer の判断待ち**」。判断を済ませたら、
run を捨てずに完了済み段を保全して **resume** させるのが基本（代行完走は loop の定義外）。

**回復の基本型**: `.lathe/runs/task-<slug>.json` の stage 配列を手術 →
`node scripts/inner-loop.mjs TASK-N --resume --dry-run` で再開点確認 → tmux で resume。

- 陳腐化した段（unparsable VERIFY・環境起因 RED の VERIFY/TRIAGE・残骸 PLAN:ESCALATE）は
  配列から**削除**して手前から再走させる。
- resume 検証は「最後の stage の head_sha == worktree HEAD」＋ stage 順序の正規性を見る。
  worktree を rebase したら該当 REVIEW entry の head_sha を新 tip に更新する。
- **driver の rebase を代行しない**（resume が sha mismatch で死ぬ。driver は
  resume 検証 → 自分で rebase → 次段、の順で動く）。
- 差し戻し注入: 最後の TRIAGE を `verdict: KNOWN`＋result_text=裁定文にすると次が
  IMPLEMENT（feedback として渡る）。REVIEW:CHANGES の result_text 書き換えでも同様。
- main 側の修正が必要な場合（gate/既存バグ）: **修正自体を task 化して inner に流す**
  （gate 故障で inner が回らない時のみ harness-hotfix loop、loops.md 参照）→
  着地後に worktree rebase → head_sha 追随 → resume。
- 裁定は必ず **task に記録**する（`backlog task edit TASK-N --notes` または PR コメント。
  監査痕跡。判断を消さない）。

典型ケースの割り当て:
- 環境起因（scratch DB 消失等）→ outer が環境を修理して VERIFY から再走。
- 自変更由来で修正方針が一意 → TRIAGE:KNOWN 注入で IMPLEMENT に差し戻し。
- 設計軸が未定義 → outer が裁定（plan 改訂も可）を記録して feedback 注入。
- judge rubric の誤前提が原因 → rubric 管理 loop へ（改訂を起草、ゲート経由で landing）。

## 2. 検証規律 — worktree の GREEN は誤報し得る

worktree 実装者の「GREEN」報告を鵜呑みにしない。実測での誤報原因:
(a) worktree の node_modules 不完全で tsc に env ノイズ、(b) `pnpm test` は tsx が型を
消すため tsc RED でも通る、(c) 古い base から分岐し続けた worktree は結果が main と乖離する。

- 検証の根拠は常に**実 exit code**（pipe で握り潰さない）。「GREEN と書いてある」は根拠でない。
- 独立検証は inner loop の VERIFY 段（verifier）と merge ゲートが担う。**outer が手で
  再検証して merge する運用は廃止**（2026-07-04 事故）。TASK-15/16 착地後は
  **CI がリモートで再実行**するため、この規律は機械化される（本節は縮退予定）。

## 3. 起票規約（PdM authority）

起票（= backlog task create）は PdM の理解のもとで行う。

- **新規機能・アーキテクチャ判断・重要ドメイン判断**: 起票**前**に、意味と効能を平文で
  説明し PdM の承認を得る（何をするか → 計画 → 承認、に必ず人間を挟む）。
- **原因も解決も明確なバグ修正・自明な followup**: 起票してよい。ただし直後に平文で
  1〜3 行の報告を添える。
- 分類に迷ったら承認側に倒す。スコープ・工数・フェーズ判断を PdM 指示なく行わない。

## 4. ingest の no-wipe 規律

- `pnpm ingest`（増分 ingest）は**既存データを wipe しない**。
- 全消し系の操作は scratch DB 専用（`verify:incremental` 等）＋ FORCE ガード付きに限る。
- 背景: 2026-06-30 の data-loss 事故。ingest 履歴 DB は再生成不能な実行記録であり、
  rubric 上も「実行記録ファイル一般」の exemption（judge 誤検出 #31/#60 の裁定）が対応する。

## 5. 本 runbook の変更

統治文書（外部空間）。改訂の起草は監査役、landing はゲート経由（ADR 0026 §3）。
セッション外 memory への書き込み・参照は行わない（同 §4）。
