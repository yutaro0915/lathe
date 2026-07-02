---
name: test-triage
description: verifier の RED を既知/新規に分類する手順。playbook → git の順で切り分け、既知は対処、新規は evidence＋仮説で OPUS へ。test-triage agent が従う。既知パターンの台帳は design/test-failure-playbook.md＝ここに inline しない。
---

# test-triage — RED の既知 / 新規 切り分け（手順）

test-triage agent がこれに従う。**read-only**（コード・テストを編集しない・git を変更しない。読み取りと分類だけ）。
ここに置くのは**変わらない手順**。既知失敗の中身（成長する知識）は `design/test-failure-playbook.md`＝ここに列挙しない。

## 入力
- verifier の RED 一覧（`RED: <check> — <evidence>`）。

## 手順
1. **playbook を引く**: `design/test-failure-playbook.md` を読み、各 RED が既知パターンに当たるか照合する。
2. **既知なら対処**: playbook の指示に従う（例 P1=cold e2e flake → warm 再実行で切り分け、P2=env 起因 build/gate RED → 依存を入れ直して再実行）。対処後も RED が残れば「既知だが未解決」として扱う。
3. **git で出所確認**（read-only）: `git log` / `git blame` / `git diff` で、回帰がこの変更由来か既存かを切り分ける。
4. **新規なら呼び出し側（outer loop / driver）へ**: playbook に無い RED は、**自分で直さず** `新規 RED: <check> — <evidence> — <仮説>` の形で返す。再発しそうなら playbook 追記候補も添える（追記は監査役）。
5. **Bash が denied（dontAsk）になったら、subagent で回避を試みず即 escalate**（ネストは同じ permission を継承する。2026-07-02 meta-audit R2 X1）。環境・権限起因の RED（playbook P4 等）は KNOWN で IMPLEMENT に戻さない＝コード修正で直らない。

## 出力（必ずこの形）
- RED ごと: `既知（playbook <ID>）: <対処と結果>` または `新規: <check> — <evidence> — <仮説>`。
- 総合: 既知で解決した数 / 既知だが未解決 / 新規（OPUS 判断要）の内訳。
- **修正はしない**。分類と evidence・仮説まで。

## 不変の前提
- test-triage は read-only。コード・テストを編集しない・git を変更しない。
- 既知失敗の台帳は `design/test-failure-playbook.md`（成長する。追記は監査役）。この skill は手順だけを持ち、パターン本体を抱えない。
（playbook が実在することは rubric `meta/triage-playbook-exists` が機械保証する＝skill のドリフト防止。）
