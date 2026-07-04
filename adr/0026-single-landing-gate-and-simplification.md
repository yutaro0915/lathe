# ADR 0026: 統治の簡素化 — 着地の単一ゲート（PR + CI）と自家製 attestation の廃止

- status: accepted（2026-07-05 PdM 裁定。壁打ちで各項を個別承認: 単一ゲート / receipt 廃止 / 監査役特権廃止 / memory 廃止 / loop 台帳 / 簡素化原則）
- date: 2026-07-05
- 関連: ADR 0025（task 基盤）/ design/agent-workflow.md（二層フロー）/ design/outer-loop-family.md

## 契機（incident 記録を兼ねる）

2026-07-04〜05、outer loop（監査役）が TASK-2 の escalation 対応で inner loop の
IMPLEMENT / REVIEW / VERIFY / MERGE を手作業実行し、merge.mjs を迂回して main に
3 commit（5e97ad0 / 916f8e4 / a299f50、receipt 0 件）を push した。**ループに「中断して
outer が代わりに完走する」という状態は定義に無い**（終端は完走か escalation のみ）。

迂回が通った直接原因は、ローカルガード（git-guard.mjs）が**列挙式**だったこと:
- main 直接 commit の block 対象が `CODE_PREFIXES = ['apps/web/', 'packages/']` に限定され、
  ハーネスエンジン本体の `scripts/` が無防備だった
- cherry-pick は literal 照合のみで、機能的に等価な `git checkout <branch> -- <paths>` を素通しした

**PdM 裁定**: 3 commit は内容検証済み（unit / rubric gate / driver の REVIEW:PASS・VERIFY:GREEN）
につき今回限り受理する。**非前例**であり、本 ADR を引いて同種の迂回を正当化することはできない。

## 決定

### 0. 原則: シンプルに

機構は追加より**削除**を優先する。ゲートは**一つ**。例外も**ループとして定義**する
（定義外の行動を許す緊急事態を作らない）。**repo の外に情報を置かない**。
場当たり的な対策の積み増しは所有感（PdM がシステムを頭に保持できること）を破壊する——
本件の遠因である。

### 1. 着地の単一ゲート: main に入る唯一の道は PR + CI GREEN

- **branch protection で main への直接 push を禁止**する。人間・監査役・agent の区別なく
  **例外なし**。ローカルで何をどう commit しても、origin/main には CI を通らない変更は
  物理的に入らない。
- **CI が rubric gate をリモートで再実行**する（`rubrics/run.mjs --changed` / preflight。
  PR head sha に紐付く status check）。ローカル agent には偽造不能——単一マシン上に
  信頼境界は作れないため、信頼境界は remote に置く。
- `merge.mjs` は「branch push → PR 作成 → auto-merge 設定」に**縮小**する。
- git-guard.mjs の main 系列挙ルール（cherry-pick / merge / commit prefix）は**削除**する
  （broad add / force-push の助言 block のみ残す）。穴の列挙合戦を終わらせる。

### 2. receipt 制度の廃止（attestation → re-execution）

receipt（`.git/lathe-receipts/<sha>.<step>.json`）は「review/verify が行われた」ことの
自己申告 token だった。構造的欠陥: (a) LATHE_AGENT は自己申告で誰でも刷れる、
(b) 中身（review 本文）を運ばない、(c) 正規フロー自身が Done コミット後に機械で
再スタンプしていた、(d) repo 外で CI/clone から不可視、(e) squash で attest 先 sha が
main に残らない。merge.mjs が backstop で gate を再実行していた事実が、receipt が
信用されていなかったことの証明である。

- **verify の主張 → CI の再実行が置換**（主張させない。機械で確かめる）
- **review の主張 → PR review が置換**（verdict と本文を PR に投稿。内容つき・sha 紐付き・
  サーバー保存。branch protection の required review として機械強制）
- 削除するもの: `scripts/receipt.mjs` / `.git/lathe-receipts/` / merge.mjs の receipt 検査 /
  `markTaskDoneInWorktree` の receipt 再スタンプと backlog-only guard（PR 化で Done commit も
  PR 内の一コミットになり、guard ごと不要になる）

### 3. 監査役の直接編集特権の廃止

「rubric 編集は監査役のみ・main へ直接 commit」の運用を廃止する。rubric / hooks /
scripts / CI 設定 / design 文書を含む**全 harness 面が同じ単一ゲートを通る**。
authoring（起草・判断）は引き続き監査役の責務（外部空間の判断は inner に許されない）だが、
**landing は例外なくゲート経由**。

### 4. memory の廃止（repo-only 原則）

セッション外 memory（`~/.claude/.../memory/`）を以後使わない。outer の運用知識
（escalation 対応手順・検証規律等）は repo 内（`design/runbooks/` 等）へ移設する。
repo の外にある知識は stale 化を検出できず、本件でも 4 日前の旧フロー記述が
現正本より優先される誤りを生んだ。

### 5. loop 台帳: 全ての会話は規定された loop の一つ

**各 loop は唯一の終端を持ち、outer の終端に「実装」は存在しない**（前進=task 起票 /
escalation 対応=裁定 / rubric 管理=改訂の起草 / 感知=finding）。加えて
**harness-hotfix loop（緊急路）を一級で定義**する——gate 自体の故障でループが回らない時の
正規経路（PdM 明示承認 + それでもゲールは通す + 事後 incident 記録）。正規の緊急路が無い
システムでは非正規の迂回が発明される（本件が実証）。正本は `design/loops.md`（新設）。
セッション開始時の loop 宣言は**規範でなく観測**として扱う（防止は git 層が担い、
宣言は lathe に ingest して meta-loop の監査項目にする）。

## 却下した代替

- **ローカルガードの穴の列挙的修繕**: cherry-pick の次は checkout、その次は apply——
  イタチごっこ。単一マシンに信頼境界は作れない。
- **receipt の trailer 化 / HMAC 署名**: trailer もローカルで書ける自己申告。鍵も同一
  マシンにあり全 agent が読める。自己申告の延命に過ぎない。
- **loop 宣言を規範ゲートにする**: 規範は破られた（本件）。防止は git 層・宣言は観測層に分離。

## 実装順序

1. TASK-15: CI rubric-gate + merge.mjs の PR 着地化（旧ゲートのまま着地・二重期間は両立）
2. TASK-16: cutover — branch protection 有効化 + receipt 制度と git-guard main 系の削除
   （TASK-6 を吸収）
3. TASK-17 / TASK-18: loop 台帳（design/loops.md）/ memory→repo 移設
   （監査役が起草、landing は新ゲート経由）
