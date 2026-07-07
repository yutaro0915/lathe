---
name: explain-diff
description: 理解対象（PR/commit・issue 上の plan・ADR/設計文書・概念）の接地された解説教材を GitHub Flavored Markdown で 1 本生成し、explains/ に保存して GitHub Discussion に投稿する。理解が新しいボトルネック（Litt 2026-07-02）への一次対応。要約でなく教材。生成は subagent へ委譲してよい（メイン context 温存）。
grounded_in: []
---

# explain-diff — 解説教材（GFM）を生成し Discussions で配信する

出自: https://www.geoffreylitt.com/2026/07/02/understanding-is-the-new-bottleneck.html の
/explain-diff を lathe 規約へ適応（PdM 承認 2026-07-05。v1〜v3 の失敗＝要約・演出・前提知識の
仮定、を経て確定）。2026-07-07、ADR 0033 で **md ネイティブ版に全面改訂**（描画忠実度実験 =
Discussion #154。旧 HTML 版の視覚言語は PdM 向け報告 HTML 用として
`.lathe/reports/2026-07-05-explain-pr110-receipt-to-ci.html` を実物参照に残置）。
**要約（圧縮）でなく教材（展開）を作る** — 読者がゼロから世界を組み立てられること。

## 起動条件（解説 loop — loops.md / ADR 0032・0033）

- `explain` label の issue 到着、または PdM の直接要求。監査役判断で governance 級の変更にも推奨。
- **対象は理解対象への参照一般**: PR/commit・issue 上の plan・ADR/設計文書・概念/サブシステム。
- 出力規模は要求に応じる（Discussion への註釈 1 comment 〜 フル教材。plan-format の scale と同じ発想）。
- 本 skill 1 個で loop は完結する（runner／mention 監視は任意の将来拡張）。

## 生成指示（subagent へこのまま渡す・対象と接地先だけ差し替える）

対象の解説教材を GFM で 1 本作る。セクションは次の 4 つ・この順。章見出しの先頭は
アンカー安定のため ASCII にする（例: `## 1. Background`）。

1. **Background**: 対象に関係する既存システムの説明（周辺を広く探索してから書く）。
   読者の前提知識を仮定しない。**登場するすべての主体について「何をするのか・
   なんのために存在するのか」を必ず書く。**
2. **Intuition**: 核心の直感。**toy データの具体例**（架空だが実形式の ID・JSON・sha を使った
   before/after）。**図をふんだんに**。
3. **Code**: 接地資料のウォークスルー（対象が diff ならコード、plan/設計なら文書）。
   ファイル順でなく理解できる順にグループ化し、要点を ```diff / 言語指定ブロックで引用。
4. **Quiz**: 中難度の 5 問（実質を理解していないと解けないが、ひっかけでない）。
   選択肢を列挙し、`<details><summary>答えと解説</summary>` に正解と解説を畳む。
   クリック採点は**仕様として持たない**（理解テレメトリは非目標 = ADR 0033 §5）。

### 形式（GFM・GitHub ネイティブ描画のみ）

- **図 = mermaid**（`flowchart` / `sequenceDiagram`）。`%%{init}%%` 禁止。node ラベルの
  ASCII 括弧は避け `["..."]` で包む。sequenceDiagram の participant は ASCII 名＋`as` 表示名。
  classDef はライト/ダーク両テーマで破綻しない控えめな色のみ。
  **描画されない mermaid は不合格**——投稿後に実描画を確認する。
- **callout = GitHub Alerts**（`> [!NOTE]` `[!TIP]` `[!IMPORTANT]` `[!WARNING]` `[!CAUTION]`）。
- UI モック・図中への実データ埋め込みは md では表現不能——表＋コードブロック分離で代替する
  （既知の到達限界。Discussion #154 付録の到達度表を参照）。
- 表・脚注 `[^1]`・目次アンカー可。絵文字なし。日本語・である調。

### 正本と配信（ADR 0033）

- **正本**: 対象プロジェクト内 `explains/YYYY-MM-DD-<slug>.md`。ignore するかは repo ごとに
  ユーザー判断（ignore 時は Discussion が耐久コピー）。
- **配信**: 同内容を GitHub Discussion に投稿（category: Explain、無ければ General）。
  `gh api graphql` の `createDiscussion`（repositoryId / categoryId は query で取得）。
- **publish 後は不変**。改訂は新版として別ファイル・別 Discussion、追補はスレッド comment。
- 質問・註釈は Discussion のネイティブスレッド。自動応答 runner を導入した場合のみ
  agent 返信に目印を付ける。
- 依頼が issue 起点なら、元 issue に Discussion リンクを comment して close（解説 loop の終端）。

### 禁則（v1〜v3 の失敗から。違反は不合格）

- **擬人化・演出・物語調の禁止**（engaging さは具体例と積み上げで出す）。
- **相対時間の禁止**（日付・PR/ADR 番号の絶対参照のみ）。
- **評価ラベルの見出し禁止**（「勘所」「ポイント」等。重要さは構成から立ち上がらせる）。
- **接地必須**: 事実は diff・ADR・コード・API 実測から。推測で書かない。不明は「未確認」と明記。

### 重複の扱い（PdM 2026-07-05）

同じ背景解説が複数の教材で繰り返し出てきたら、**その時に**そのセクションだけ正本
（`design/` 等）へ抽出して参照に切り替える。事前の共通化はしない。

## 検収（監査役が生成物に対して機械照合してから publish）

- 禁則語 grep（昨日/門番/運命/勘所 等）・4 節の存在・`<details>` の開閉対応・
  mermaid 構文の自己点検＋**投稿後の実描画確認**（iframe が render されること）。
- 初出の実物例: `explains/2026-07-07-pr110-receipt-to-ci.md`（= Discussion #154）。
