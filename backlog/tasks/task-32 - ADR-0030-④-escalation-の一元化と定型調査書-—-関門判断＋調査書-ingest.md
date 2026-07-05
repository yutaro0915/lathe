---
id: TASK-32
title: 'ADR 0030 ④: escalation の intake 統一 — escalation label 投函（run リンク）＋関門規則の設定集約'
status: To Do
assignee: []
created_date: '2026-07-05 05:02'
updated_date: '2026-07-05 05:51'
labels: []
dependencies: []
priority: medium
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## 問題
escalate 判断が 3 箇所（agent verdict／driver チェック／TRIAGE）に分散。escalation.md は状態ダンプのみで、裁定側の調査コストが高い（ブラックボックス）。

## 方針（ADR 0030 §4）
- escalate するか否かの規則は駆動側の関門（段の verdict 判定点と CI 結果）だけが持つ。agent の自発 ESCALATE verdict は廃止し、成否＋定型調査書（試したこと／失敗したこと／仮説／切り分けの次の一手）の返却に統一
- escalation.md = 状態ダンプ＋調査書とし、lathe に ingest して裁定 loop の一次資料にする
- 依存: ADR 0030 ③（段構成の確定が先）

## 検証
- 意図的に失敗する task で escalation.md に調査書が含まれ ingest されること
- escalate 判断のコードパスが driver 内の関門 1 箇所に集約されていること（grep で確認可能な形）

---
intake: issue #117 <- @yutaro0915
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
ADR 0030 追記 C（2026-07-05 PdM 裁定）: escalation の挟み込み位置は設計未了。前進 loop での討議・裁定が終わるまで実装に流さない（実装保留）。

ADR 0030 追記 E（2026-07-05 PdM 裁定）: 保留解除。scope を再定義——(1) escalation は issue 投函（task-request + escalation label、本文 = run リンク＋PR リンク＋関門＋verdict）に統一、escalation.md 独自伝達路と定型調査書は廃案。(2) 関門 = driver の IMPLEMENT 完了判定＋engine の CI RED / CHANGES 非収束（上限は設定ファイル）。(3) agent 自発 ESCALATE 廃止。(4) 修正 run は毎回新 run。issue #117 本文の方針節はこの裁定で全面読み替え。依存: TASK-33（縮退）と #128 の engine。
<!-- SECTION:NOTES:END -->
