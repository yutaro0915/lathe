# ADR 0016: loop family — plan-loop の新設と impl-loop の PLAN 分離

- status: accepted（2026-07-02、ユーザー提案: 「調査/計画も一つの inner loop として扱う。実装 issue では計画しない。2 つの loop それぞれにエスカレーション定義を決める。いろいろな inner loop を作っていく」）
- date: 2026-07-02
- 関連: ADR 0013（driver）/ ADR 0015（依存つき並列。**依存/Touches の接地主体が本 ADR で outer の勘 → plan-loop の調査へ改善**）

## 背景

現行の impl driver は PLAN を内蔵する。だが (a) 計画と実装が同じ run に居ると、**実装が壊れた前提の上で独自判断で走る**リスクがある（怖いのはここ）、(b) 問題は plan 段階で捕まえるほど安い（#25 の PLAN が false-green を検知して implement 前に止めた実績）、(c) 並列性・依存の宣言（ADR 0015）を根拠づける調査の置き場が無い。また、調査・計画そのものを main セッション（outer）でやるのは token の無駄。

## 決定

### 1. inner loop を「種類のあるファミリー」にする
- **plan-loop**（新設）: label `needs-plan` の issue（意図・目標・調査依頼）を受け、（必要時）RESEARCH → PLAN → **PLAN-REVIEW**（reviewer が計画を審査）→ **実行可能な実装 issue 群を起票**して close。
  - 生成する各実装 issue には: 承認済み plan の本文（または明示リンク）／**`Depends-on:` と `Touches:` を調査に基づいて記述**／label `inner-loop`。
  - 並列可否の判断根拠が「outer の起票時の勘」から「**plan-loop の調査**」に強化される（ADR 0015 追補の改善）。
- **impl-loop**（既存改）: label `inner-loop` の issue は **plan 埋込済みが前提**。driver は body の承認済み plan マーカーを検知したら **PLAN 段をスキップ**し IMPLEMENT から始める（マーカー無しは従来どおり PLAN から＝後方互換）。
- 将来、他種の loop（例: audit-loop・doc-loop）を同じ型（label → 専用段列 → 成果物）で追加できる。outer loop も増やしていく。

### 2. エスカレーション定義を loop 別に持つ（プロンプト契約に明記）
- **plan-loop がエスカレートする条件**: ユーザー裁可が要る設計判断（taxonomy・横断 config・スコープ変更）／調査の結果、目標自体が不成立・前提が矛盾／生成しようとする task の依存が既存 open issue と衝突。
- **impl-loop がエスカレートする条件**: **前提破れ**——plan が現実（コードの現状・依存の状態）と乖離していると気づいたら、**その場で計画し直さず escalate**（plan-loop へ差し戻すため）。＋既存（VERDICT 不能／周回超過／NOVEL RED／merge 失敗／main-dirty〔#39〕）。
- 原則: **実装 loop から思考（計画変更）を減らし、計画 loop に思考を寄せる**。

### 3. 運用
- outer の仕事は変わらず「問題 → issue」だが、粒度で label を使い分ける: 形が見えている小修正 → 直接 `inner-loop`（plan は ADR/issue 本文が代替）／調査・分割が要る意図 → `needs-plan`。
- plan-loop も manifest（`.lathe/runs/plan-<n>.json`）と escalation を持つ（meta-audit の対象）。

## 却下した代替
- **impl driver に「前提チェック段」を足して再計画させる**: 実装 run 内の再計画こそが「変な前提で走る」温床。却下（前提破れは escalate 一択）。
- **調査/計画を outer が直接やる**: main セッションの token 浪費・履歴汚染（二層分離の反省と同根）。却下。

## スコープ
- 本 ADR = loop family の型・plan-loop の段列と成果物・impl-loop の PLAN スキップ・loop 別 escalation 定義。
- スコープ外: audit-loop 等の追加種（必要時に別 ADR 不要・本型に従う）／plan-loop の並列化。

## 実装スライス
1 issue（impl-loop 実行可・ADR が plan 代替）: driver に plan-loop モード（`node scripts/inner-loop.mjs --plan <issue#>` か別スクリプト）＋実装 issue 起票（gh）＋PLAN スキップ検知＋loop 別 escalation のプロンプト反映＋単体テスト。
