# ADR 0034: 教材承認ゲート — needs-explain 系 task の実装開始条件と、agent のリアクション禁止

- status: accepted（2026-07-07 PdM 裁定）
- date: 2026-07-07
- 関連: ADR 0030（task loop）／0031（状態は導出）／0032・0033（解説 loop）／#116（着手判定の実装先）

## 背景

PdM の承認を「読んで理解した上での 1 タップ」にしたい（スマホの GitHub アプリで教材
Discussion に 👍 を押すだけ）。同時に、agent が Discussion へ勝手に upvote を付ける事象が
観測された。agent は PdM の gh 認証で動くため、**agent のリアクションは API 上 PdM の
リアクションと区別できない**——承認シグナルとして使うには、agent 側の付与を禁止しなければ
意味論が壊れる。

## 決定

1. **承認の意味論**: `needs-explain` を経た task issue について、**教材 Discussion の先頭投稿への
   PdM（repo owner）の THUMBS_UP（👍）を「issue 承認＝実装開始条件の充足」とする**
2. **着手判定（driver / queue が導出する。保存しない）**:
   - issue に `needs-explain` が付いている → **着手不可**（教材待ち）
   - issue に `done-explain` が付いている → 終端 comment（最新の教材リンク）から Discussion を
     解決し、**owner の 👍 が無ければ着手不可**
   - どちらの label も無い issue → 本ゲートの対象外（従来どおり）
3. **agent はリアクション（reaction / upvote）を一切付けない**。解説 loop・応答 runner・
   その他すべての agent 経路で禁止（explain-diff skill の禁則と claude-discussions workflow に明記）
4. 既知の限界（受容）: 単一アカウント運用のため、禁止は行動規範＋meta 検出で担保する
   （ADR 0028 の required review 不能と同型）。observed 汚染 1 件（Discussion #172）は除去済み

## 実装

着手判定は #116（issue 結線）に統合。skill／workflow の禁則追記は本 PR。

## 追記（2026-07-07 PdM 裁定・承認シグナルの変更: 👍 → Discussion close）

承認シグナルを **教材 Discussion の close** に変更する（👍 リアクションは導出が煩雑
〔reactionGroups の走査〕で、一覧上の視認性も無い。close は `discussion { closed }` の
boolean 1 発で導出でき、Discussions 一覧で「処理済み」が見た目で区切れる）。

- **承認 = PdM が教材 Discussion を close する**（読了・理解・承認の 1 操作。close 後も
  comment は可能なので註釈スレッドは死なない）
- 着手判定 §2 を読み替え: `done-explain` 付き issue は、最新の教材 Discussion が
  **closed でなければ着手不可**
- 禁則の拡張: **agent は Discussion を close しない**（リアクション禁止と同じ理由——
  承認シグナルの汚染防止。解説 loop の終端は comment＋label 遷移のみで従来どおり close を含まない）
- 👍 は自由なフィードバックに戻る（機械は読まない）
