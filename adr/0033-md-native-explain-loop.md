# ADR 0033: 解説 loop の md ネイティブ化 — skill 可搬・正本 = explains/・配信 = Discussions

- status: accepted（2026-07-07 PdM 裁定。Discussion #154 の描画忠実度実験に基づく）
- date: 2026-07-07
- 関連: ADR 0032＋追記 1・2（本 ADR が実装形を置換）／explain-diff skill／#149／Discussion #154

## 背景

ADR 0032 追記時点の実装計画は、教材 repo＋Cloudflare（Pages/Access/Worker/D1）、次いで
gist＋Pages と変遷したが、いずれも配信・認証・テレメトリの基盤を持つ。実験
（Discussion #154 — 合格済み HTML 教材と同一主題の GFM 移植）で GitHub ネイティブ描画を
実測した結果: mermaid 4/4 描画成功（flowchart / sequenceDiagram・classDef 色・ズーム UI 自動付与）、
GitHub Alerts・`<details>` Quiz・```diff・表・脚注・PR 番号の自動リンク、スマホは公式アプリで
閲覧可。届かないのは Quiz のクリック採点・UI モック・独自視覚 CSS の 3 点で、PdM は
「Quiz 採点は非目標でよい。見た目はむしろ GitHub 標準で強制統一される」と裁定した。

## 決定

1. **教材の形式 = GFM**（GitHub ネイティブ描画のみ。外部レンダラ・独自 CSS・JS を使わない）。
   形式・禁則の正本は explain-diff skill が運ぶ——**skill 1 個で解説 loop はどこでも可搬**
   （runner・mention 監視・常駐応答は任意の将来拡張であり、無くても loop は手動で完結する）
2. **正本 = 対象プロジェクト内 `explains/YYYY-MM-DD-<slug>.md`**。ignore するかは repo ごとに
   ユーザー判断（ignore した場合は Discussion 投稿が耐久コピーとなり情報は失われない）
3. **配信とスレッド = GitHub Discussions**（category: Explain。UI で作成するまでは General）。
   **教材は publish 後不変**——正本と Discussion 本文の drift を防ぐ。改訂は新版、追補は comment
4. **註釈 = Discussions のネイティブ入れ子スレッド**（0032 追記 2 の [USER]/[AGENT]
   issue-comment 方式を置換。自動応答 runner を導入する場合のみ agent 返信に目印を残す）
5. **Quiz 採点・理解テレメトリは非目標**（放棄を明示。upvote / answer-mark を粗い代替とする）
6. 入口は `explain` label の issue（対象 repo）と PdM の直接要求（0032 本文どおり。
   追記 1 の「入口も教材 repo」は repo 自体を作らないため消滅）

## 置換・廃止

- ADR 0032 追記 1（教材 repo 自己完結・形式正本の教材 repo 移設）: **教材 repo を作らない**ため全て不要化
- gist 案・Cloudflare 案（Pages/Access/Worker/D1）: 廃案
- #149（教材プラットフォーム 4 層）: **解体 close** — 配信 = Discussions 有効化で完了済み、
  註釈 = ネイティブスレッド、テレメトリ = 放棄、音声入力等は将来 runner 拡張として必要時に再起票
- PdM 向け報告 HTML（#148 の統一規則）は本 ADR の対象外——教材 = md、報告 = 従来の HTML 形式のまま
  （統合するかは別途裁定）

## 却下した代替

- **Quiz 採点の維持**: 採点・計測には独自配信基盤（JS 実行環境＋収集先）が必須で、
  基盤ゼロという本決定の利得を打ち消す。問題そのものの提示で十分（PdM 裁定）
- **教材 repo／gist／Cloudflare 系**: それぞれ ADR 0032 追記・本 ADR 背景の比較のとおり

## 実装（本 PR）

explain-diff skill の md 版全面改訂／loops.md 解説行の更新／`explains/` に初出実物
（Discussion #154 の正本）を収載。**手動 1 手のみ**: Discussion カテゴリ「Explain」の作成
（GitHub UI。カテゴリ作成 API は存在しない）。
