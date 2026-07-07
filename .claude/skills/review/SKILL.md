---
name: review
description: 変更を plan ＋ 該当 rubric に照らしてレビューする観点と手順。設計遵守・抜け・risk を見て指摘＋verdict を返す。reviewer agent が従う。何が違反かの基準は plan と rubric 側＝ここに inline しない。
grounded_in: []
---

# review — 変更のレビュー観点（手順）

reviewer agent がこれに従う。**read-only**（コード編集・git をしない。レビューだけ）。
ここに置くのは**変わらない観点と手順**。「何が正しいか」の基準は plan と該当 rubric が持つ＝ここに列挙しない。

## 入力
- 変更パス一覧＋`git diff main...HEAD` の branch diff（rebase 済み branch tip の main からの差分）。
- plan（acceptance criteria / finish line）。
- 該当 rubric（`node rubrics/run.mjs --changed <paths>` が選ぶのと同じ scope の rubric 群を読む）。

## worktree freshness 前提
- reviewer は、driver / implementer が **rebase 済み**にした **branch tip** を **merged-main 実体**としてレビューする。
- stale branch を救済しない。reviewer は rebase や reset を実行せず、現在の HEAD が最新 main 基準である前提のまま plan / rubric と照合する。
- レビュー対象の diff は `git diff main...HEAD` で取得する。working tree の一時差分を入力前提にしない。

## 観点（gate で測れない設計判断に集中。機械検査は verifier の領分＝重複しない）
1. **plan / 設計 遵守**: plan の acceptance を満たすか。設計意図・周辺コードの慣習（命名・構造・DS=lathe-ui）に沿うか。
2. **抜け**: 未処理の分岐・エラー処理・境界条件、plan にあるのに実装されていない点、テスト不足（挙動変更にテストが伴うか）。
3. **risk**: 影響範囲（blast radius）・可逆性・境界（レイヤ越境）・将来機能（特にハーネス L3）への含み。

## 出力（必ずこの形・これだけ返す）
- 指摘ごと: `severity（blocker / major / minor）` / `位置（file:line）` / `何が問題か` / `なぜ（どの plan 項目・rubric・設計原則に反するか）`。
- 総合 verdict: `approve`（指摘なし／minor のみ）または `changes-needed`（blocker / major あり）。
- **修正・merge はしない**。指摘を呼び出し側（outer loop / driver）に返すだけ。
- 迷う指摘は false positive を避けて通す（plan か rubric か明文の設計原則に違反すると言えるものだけ major 以上）。

## 不変の前提
- reviewer は read-only。コード編集・git 操作・merge をしない。
- 機械で測れる規範は rubric＝verifier が見る。reviewer はそれを再実行せず、**設計判断**に集中する（責務分離）。

