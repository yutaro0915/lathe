---
name: explain-diff
description: 理解対象（PR/commit・issue 上の plan・ADR/設計文書・概念）の接地された解説教材を GitHub Flavored Markdown で 1 本生成し、explains/ に保存して GitHub Discussion に投稿する。理解が新しいボトルネック（Litt 2026-07-02）への一次対応。要約でなく教材。生成は subagent へ委譲してよい（メイン context 温存）。
grounded_in: []
allowed-tools: Read, Grep, Glob, Write(explains/**), Edit(explains/**), Bash(gh:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git ls-files:*)
---

# explain-diff — 解説教材（GFM）を生成し Discussions で配信する

出自: https://www.geoffreylitt.com/2026/07/02/understanding-is-the-new-bottleneck.html の
/explain-diff を lathe 規約へ適応（PdM 承認 2026-07-05。v1〜v3 の失敗＝要約・演出・前提知識の
仮定、を経て確定）。2026-07-07、ADR 0033 で **md ネイティブ版に全面改訂**（描画忠実度実験 =
Discussion #154。旧 HTML 版の視覚言語は PdM 向け報告 HTML 用として
`.lathe/reports/2026-07-05-explain-pr110-receipt-to-ci.html` を実物参照に残置）。
**要約（圧縮）でなく教材（展開）を作る** — 読者がゼロから世界を組み立てられること。

## 起動条件と入力（解説 loop — loops.md / ADR 0032・0033）

入力は 3 形態。**主経路は「対象そのものに label」**——依頼のための独立 issue を乱造しない。

1. **主経路**: 解説してほしい **issue／PR そのものに `needs-explain` label が付く**。その本文・plan・
   diff・スレッドが接地の起点（観点の指定は label 時に comment で添えてよい）。
   「#X を解説せよ」という別 issue は立てない
2. **従経路**: label を貼る対象が存在しない場合のみ（ADR・概念・サブシステム・複数対象の横断）、
   独立の依頼 issue（本文 = 理解対象への参照＋観点）に `needs-explain` label を付ける
3. **直接要求**: PdM がセッション内で依頼（最軽量）

監査役判断で governance 級の変更にも推奨。出力規模は要求に応じる（Discussion への註釈
1 comment 〜 フル教材。plan-format の scale と同じ発想）。本 skill 1 個で loop は完結する
（runner／mention 監視は任意の将来拡張。`needs-explain` = 未処理の依頼キューとして polling 可能）。

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

### 権限（最小権限の原則）

本 skill の実行は**読み取り＋`explains/` への書き込みだけ**で完結する。frontmatter の
`allowed-tools` がこれを宣言する（FS 書き込みは `explains/**` のみ・Bash は `gh` と git 読み系のみ）。
独立 runner として回す場合は SETUP.md の起動例（`--allowedTools`）でハード強制する。
対象 repo のコード・設計文書への書き込みは解説 loop の終端に存在しない（loops.md）。

### 正本と配信（ADR 0033）

- **正本**: 対象プロジェクト内 `explains/YYYY-MM-DD-<slug>.md`。ignore するかは repo ごとに
  ユーザー判断（ignore 時は Discussion が耐久コピー）。
- **配信**: 同内容を GitHub Discussion に投稿（category: **Explain**＝Announcement 形式・
  無ければ General）。`gh api graphql` の `createDiscussion`（repositoryId / categoryId は query で取得）。
  repo 側の 1 回きりの準備（カテゴリ・label 作成）は同梱の [SETUP.md](./SETUP.md)（人間向け）。
- **publish 後は不変**。改訂は新版として別ファイル・別 Discussion、追補はスレッド comment。
- **正本の git 着地は loop の終端に含めない**（最小権限の維持）。explains/ を track する repo では
  運用側（監査役／ユーザー）が後から PR で拾う。ignore する repo では何も要らない。
- 質問・註釈は Discussion のネイティブスレッド。自動応答 runner を導入した場合のみ
  agent 返信に目印を付ける。
- **終端処理（入力形態で異なる——ここを混同しない）**:
  - 主経路（対象に label）: 教材リンクを**その issue/PR に comment し、`needs-explain` を外して
    `done-explain` に付け替える**（PR への label 操作は `gh pr edit` でなく REST
    `gh api -X POST repos/<o>/<r>/issues/<n>/labels` を使う——pr edit は Projects classic 廃止の
    GraphQL エラーで失敗する、2026-07-07 実証）。**close はしない**——対象の task/PR の
    ライフサイクルは解説と無関係（close すると解説依頼が task を殺す事故になる）。
    label 遷移が状態を表す: `needs-explain` = 未処理キュー／`done-explain` = 教材あり
    （`label:done-explain` で解説済みの全量が検索できる）
  - 従経路（独立依頼 issue）: リンク comment ＋ `done-explain` 付与＋ **close**。このとき**解説対象の PR/issue にも
    教材リンクを 1 行 comment する**——Discussion 内で PR/issue に言及しても対象側に
    backlink は生まれない（cross-reference の発生元は issue/PR のみ、2026-07-07 に PR #146 で
    実証）ため、対象から教材へ辿れる唯一の恒久リンクがこの comment である
  - 直接要求: 教材リンクの提示のみ（対象に issue/PR があれば同様に comment を残す）

### 禁則（v1〜v3 の失敗から。違反は不合格）

- **擬人化・演出・物語調の禁止**（engaging さは具体例と積み上げで出す）。
- **相対時間の禁止**（日付・PR/ADR 番号の絶対参照のみ）。
- **評価ラベルの見出し禁止**（「勘所」「ポイント」等。重要さは構成から立ち上がらせる）。
- **接地必須**: 事実は diff・ADR・コード・API 実測から。推測で書かない。不明は「未確認」と明記。

### 重複の扱い（PdM 2026-07-05）

同じ背景解説が複数の教材で繰り返し出てきたら、**その時に**そのセクションだけ正本
（`design/` 等）へ抽出して参照に切り替える。事前の共通化はしない。

## 検収（生成 agent の自己点検＋監査役の事後照合）

- **生成 agent（publish 前・必須）**: 禁則語 grep（昨日/門番/運命/勘所 等）・4 節の存在・
  `<details>` の開閉対応・mermaid 構文の自己点検（skill の構文規律に対する機械照合）。
- **監査役（publish 後・ブラウザ系ツールを持つ環境で）**: 実描画確認（mermaid iframe が
  render されること）。生成 agent の allowed-tools にブラウザは含まれないため、
  この確認は生成側の義務ではない（2026-07-07 の独立実走 #158→#159 で確定した分担）。
- 初出の実物例: `explains/2026-07-07-pr110-receipt-to-ci.md`（= Discussion #154）。
