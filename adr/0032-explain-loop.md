# ADR 0032: 解説 loop — 教材対象の一般化と label 駆動の起動

- status: accepted（2026-07-06 PdM 裁定。「PR 紐付けを決めつけない・シンプルに汎用性高く・loop を一つ追加する方向」）
- date: 2026-07-06
- 関連: explain-diff skill（PR #133/#148）／ADR 0030（loop 再編）／0031（issue=task）／#149（教材プラットフォーム）

## 背景

explain-diff skill は対象を「コード変更（PR/commit）」と仮定していた。しかし理解の需要は
plan の承認前・loop の設計判断時にも（むしろ着地後より多く）発生する。生成をパイプラインの
イベント（PR merge）へ紐付けるのは生成側の都合であり、需要側の事実と合わない。

## 決定

1. **教材の対象 = 理解対象への参照一般**。PR/commit・issue 上の plan・ADR/設計文書・
   概念/サブシステム・既存教材への質問。explain-diff の 4 節構造（Background/Intuition/
   Code/Quiz）は維持し、Code 節は「接地資料のウォークスルー」と読み替える
2. **解説 loop を loops.md に追加**。起動条件 = **`explain` label の issue の到着**
   （投函者は問わない: PdM・監査役・annotation Worker・他 loop）。やること = 参照対象に
   接地した教材の生成／既存教材への註釈追記＋禁則の機械検収。**唯一の終端 = 教材 publish
   （教材 repo へ push＝配信）＋ issue close（教材リンク）**。終端でないもの = 対象への
   裁定・実装・レビュー（理解の生産と判断の生産を混ぜない）
3. **出力規模は要求に応じる**（註釈 1 スレッド〜フル教材。plan-format の scale rules と同じ発想）
4. **運用者非依存**。当面は監査役の委譲 subagent が回し、将来は自宅サーバーの cron 応答
   loop（annotation 経路、#149 v3）が同一定義のまま運用を引き継ぐ

## 却下した代替

- **PR merge への自動紐付け**: 理解需要のタイミングと合わない。生成には禁則検収が要り、
  無条件自動生成は品質と費用の両面で過剰
- **lathe への統合**: lathe のスコープを広げない（PdM 裁定 2026-07-06）。教材系は独立の系
  （#149）とし、必要になった時に URL の ingest だけで紐付ける（事前統合しない＝ADR 0031 と同型）

## 実装

- loops.md へ解説 loop の行を追加（本 PR）／explain-diff skill に対象一般化を追記（本 PR）
- `explain` label の作成（gh）。配信先の教材 repo は #149（v1）で立てる。それまでの publish は
  `.lathe/reports/` への出力＋PdM への提示で代替

## 追記（2026-07-06 PdM 確認・自己完結の確定）

依存監査の結果、以下を確定する。**解説 loop の系は教材 repo に完全自己完結**とし、
外部依存は GitHub（共有基盤）・理解対象 repo への read-only 接地・Cloudflare（配信、
交換可能な薄い層）のみとする。

1. **正本の場所**: 教材本体 = **教材 repo の main**（Pages は deploy＝導出）。註釈スレッド =
   **教材 repo の issue**（質問 = issue・回答 = comment。D1 は表示キャッシュで正本でない）。
   Quiz 回答・閲覧テレメトリ = D1（導出不能な観測データの一次置き場）。`.lathe/reports/` は
   repo が立つまでの暫定出力先で正本ではない
2. **入口の場所**: explain issue の帳簿は **教材 repo**（lathe の盤面に混ぜない・lathe へ
   依存しない）。対象が lathe の PR/plan でも cross-repo 参照で接地する。教材 repo が
   立つまでは lathe repo の `explain` label を仮の入口とする
3. **形式正本の移設**: explain-diff skill（形式・禁則の正本）は教材 repo 作成時（#149 v1）に
   教材 repo へ移し、lathe 側は参照に切り替える（v3 で自宅サーバー応答 loop が lathe clone
   なしで運用できるようにする）
4. **フローの確定**: explain issue → 生成（read-only 接地・禁則検収）→ 教材 repo へ push
   （= 配信）→ **元 issue に教材リンクを comment して close**

## 追記 2（2026-07-06 PdM 裁定・註釈スレッドの器の修正）

追記 1 の「質問 = issue・回答 = comment」を修正する。質問と回答が別の階層になるのは
スレッド構造として誤り（質問ごとに issue が乱立し、節単位の時系列が壊れる）。

- **教材 1 枚につき註釈 issue 1 本**（title: `annotations: <教材 slug>`。解説 loop が
  教材 publish 時に空で作成する）
- **質問も回答も、その issue の comment** として時系列に積む。区別はタグで行う:
  `[USER][§節id] 質問本文`／`[AGENT][§節id] 回答本文`
- 正本 = 註釈 issue の comment 列（変更なし）。D1 は表示キャッシュ（変更なし）
- ページは節 id ごとに comment を束ねてスレッド表示する
