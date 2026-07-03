---
id: run-validity-v1
role: development
frontier: 前線2
S: gate の報告は GREEN/RED の 2 値しかなく、判定不能（verifier 故障・judge の VERDICT 抽出失敗・環境未成立）が fail に化けて実装者へ跳ね、severity（blocker/major）は記録のみで判定に接続されていない
C: 5 値の報告語彙と集約優先順位を実装した run.mjs に、正常 check・blocker 違反・major 違反・判定不能（故障 verifier / 不形式 judge 出力の fixture）・未発火 rubric を与える
Y: check 単位で pass / fail / warn / invalid（harness|eval の帰属併記）/ not-run（理由併記）が報告され、集約が「fail か invalid 1 つで停止・warn のみは通過（receipt 必列挙）・not-run は通過を妨げない（receipt 必須）」の優先順位で決まる
checks:
  - meta/run-validity
inline_criteria:
  - blocker 違反の check が fail、major 違反の check が warn と報告されること（severity の判定接続）
  - 判定不能（verifier 解決失敗・チャンネル欠落・extract 失敗・judge VERDICT 抽出失敗・binding 解決失敗）が fail でなく invalid と報告され、帰属（harness）が併記されること
  - warn のみの run が exit 0 で通過し、receipt に warn が全列挙されること
  - invalid を 1 つ含む run が exit 非 0 で停止すること（判定できていないものを通さない＝gate では fail と同格）
  - not-run（未発火 rubric・tier で絞られた check）が理由つきで receipt に全列挙されること
  - 5 値の分類・集約が純関数として負テストで固定されること（既知の欠陥 fixture を検出）
trials: { n: 1, aggregate: all-pass }
---

# eval: run-validity-v1 — run の手続きの正しさを判定の正しさから分離できるか

- 前線2（run validity / severity 判定接続）の Development eval。**前線2 の ADR はこれを受け入れ条件として引用する**。id・骨子は handoff §3 のサンプル（run-validity-v1）を実体化したもの
- 負荷の実体: 故障 verifier・不形式 judge 出力などの fixture を分類器に食わせる負テスト（着地時に gate rubric を checks へ追加して記録する）
- 理論の正本: theory §run validity（invalid の二分岐帰属・報告語彙 5 値 = LEDGER-0034）・§結果分類（invalid → 行 7 harness / 行 6 eval。fail 後の既知/新規切り分けは判定値でなく診断）
- 実利の根拠（2026-07-03 夜間運用の実測）: escalation 8 件中 3 件（scratch DB schema 消失 P5・codex sandbox EPERM P4・headless 切断）が「invalid が fail に化けた」もの。invalid の分離は inner loop の誤帰属周回を構造的に減らす

## 負荷の実行記録（2026-07-03・通過）

- inline_criteria の実測（main 上で監査役が再検証・着地 be467a1）:
  1. severity 判定接続 ✓（blocker→fail・major|minor→warn を verdict.test.mjs で固定。接続前に severity 再監査 2e4c86e＝31 major→blocker・warn 空集合開始・v1 は fail 既定→ **fail 集合は従来 RED と完全一致**）
  2. invalid 5 類の分離 ✓（故障実演: 不在チャンネルを指す rubric → `[INVLD] … 帰属=harness ／ missing-channel: …`・exit 1）
  3. warn のみ通過（receipt 必列挙）✓・4. invalid 1 つで停止（exit 非 0）✓・5. not-run 理由併記（tier SKIP も語彙統一）✓ — いずれも verdict.test.mjs＋実走で確認
  6. 分類・集約は純関数 verdict.mjs＝負テストで固定、gate 化（meta/run-validity）✓
- 消費側接続: verify / test-triage skill に「invalid は IMPLEMENT に戻さず即 escalate（帰属併記を読む）」を追記（監査役）。warn の初の実利用者候補 = layout/integrity の axe soft 検査（hard 化まで warn で一級化可能）
