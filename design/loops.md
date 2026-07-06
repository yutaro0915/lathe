# loops.md — loop 台帳（全ての会話は規定された loop の一つである）

> 正本（ADR 0026 §5）。**全てのセッション（人間との会話・agent の run を問わず）は、
> 下表のいずれか 1 つの loop であり、その loop の唯一の終端でだけ終わる。**
> 定義外の状態（「中断して他者が代わりに完走する」等）は存在しない。
> 迷ったら: **実装がしたくなったら、それは task 起票に変換する。**

## 原則（ADR 0026 §0）

シンプルに。機構は追加より削除。ゲートは一つ（main の唯一の入口 = PR + CI GREEN、例外なし）。
例外もループとして定義する。repo の外に情報を置かない。

## loop 一覧と唯一の終端

| loop | 誰が回すか | 起動条件 | やること | **唯一の終端** | 終端で**ない**もの |
|---|---|---|---|---|---|
| **inner（task）** | driver `scripts/inner-loop.mjs` + named agents | open な task issue（ADR 0031。旧 backlog task） | PLAN→IMPLEMENT→REVIEW→VERIFY→(TRIAGE)→MERGE を自律完走（ADR 0030 で IMPLEMENT→PR へ縮退予定＝#116） | **ゲート経由の merge**、または **escalation（停止して outer の判断待ち）** | outer による代行完走・ゲート迂回 |
| **前進（plan）** | outer（壁打ち・問題提起・plan-loop） | PdM との対話・観察からの問題提起 | 問題を言語化し、必要な判断を PdM に諮る | **task 起票**（起票しない判断も、その旨の記録が終端） | 実装・main への着地 |
| **escalation 対応（ACT）** | outer（監査役） | inner の escalation | 詰まりの原因を特定し裁定する | **裁定**＝unblock + resume 指示／差し戻し注入／plan 改訂／断念して task 再起票。裁定は task に記録 | 残段の手動実行・成果物の手動 merge |
| **rubric 管理（ACT）** | outer（監査役が起草） | 品質基準の欠落・誤り（多くは meta の finding 経由） | rubric / skill / 統治文書の改訂を**起草** | **改訂の起草 + ゲート経由の landing**（直接 main 書き込み特権は無い） | inner への起草委譲（外部空間の判断は inner に許されない） |
| **感知（meta-loop）** | driver `scripts/meta-loop.mjs`（read-only） | cadence／escalation クラスタ／PdM 指示 | SCOPE→GROUND→DIAGNOSE→REPORT。§結果分類 13 行へ写像 | **finding + 判断記録**（`.lathe/meta/`）。起票・改訂は ACT 系へ渡す | 起票・rubric 更新・コード修正 |
| **harness-hotfix（緊急路）** | outer（監査役）+ PdM | **gate 自体の故障**でループが回らない（例: guard の false-RED が全 task を止める） | 最小修正を起草する | **PdM の明示承認 → それでも生きているゲートは全て通す → 事後 incident 記録（ADR）付きの着地** | 承認なしの迂回・記録なしの着地 |
| **intake（登記）** | **廃止（ADR 0031）**——登記は issue 作成そのもの。写し Action・採番 writer は撤去（採番=GitHub・却下なし） | `task-request` label 付き issue の作成 | issue がそのまま task（**TASK-N = issue #N**。status は導出: open=To Do／参照 PR open=In Progress／merge close=Done） | **issue 作成の完了** | 却下・triage（PdM が Projects 盤面で行う）・実装 |
| **解説（explain）** | 監査役の委譲 subagent（将来: 自宅サーバー応答 loop・同一定義、ADR 0032） | `explain` label の issue 到着（投函者は問わない） | 参照対象（PR／plan／ADR／概念）に接地した教材の生成・既存教材への註釈追記＋禁則の機械検収 | **教材 publish（教材 repo へ push＝配信）＋ issue close** | 対象への裁定・実装・レビュー |

補足:
- outer の終端に「実装」は**存在しない**。これが 2026-07-04 事故（ADR 0026 契機）の教訓。
- harness-hotfix は「例外の正規化」である。正規の緊急路が無いシステムでは非正規の迂回が
  発明されるため、緊急路そのものを loop として定義する。
- inner の詳細（段・担当・ゲート）は [agent-workflow.md](./agent-workflow.md)、
  outer の 4 系統の分解と meta の設計は [outer-loop-family.md](./outer-loop-family.md) が正本。

## セッション開始時の loop 宣言（観測であって規範ではない）

- セッションの最初の実作業の前に、**どの loop か・終端は何か**を 1 行宣言する
  （例: 「本セッションは前進 loop。終端は task 起票」）。途中で性質が変われば宣言し直す
  （1 セッション内で loop が切り替わることは正常。無宣言の滑走が異常）。
- 宣言は**防止装置ではない**（規範は破られ得る——防止は git 層＝branch protection + CI が担う）。
  宣言は lathe に ingest され、**「宣言した loop の終端を超えた行動をしたセッション」を
  meta-loop が検出する**ための観測点である（run-health / gate-effectiveness の監査項目）。

## この台帳の変更

本ファイルは統治文書（外部空間）。改訂の起草は監査役、landing はゲート経由、
loop の追加・削除・終端の変更は PdM 承認を要する。
