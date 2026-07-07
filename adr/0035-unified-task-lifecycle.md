# ADR 0035: 統一 task ライフサイクル — plan 必須・needs-review 単一キュー・Projects Ready 承認

- status: accepted（2026-07-07 PdM 裁定。骨子 v1〜v4 = issue #180 comment 列・教材 = Discussion #181・PdM 承認記録済み）
- date: 2026-07-07
- 関連: ADR 0030 追記 A（本 ADR が上書き）／0031 §4（修正）／0034（承認意味論を移設）／#116・#170・#178・#117（吸収・再定義）

## 背景

#116 の実装は「needs-plan 無し = 直接実装可」だったが、これは ADR 0030 追記 A の読み違いに
起因する誤り（PdM 指摘 2026-07-07）。**実装専用 issue は存在しない**——全ての実装は plan に
依存し、plan は検査され、重要なものは PdM に承認されて初めて実装可能になる。また承認の操作面
（label・Discussion close）が分散しており、PdM の作業面を GitHub Projects kanban に一元化する。

## 決定

### 1. 統一ライフサイクル（全 issue 共通）

起票 → **plan loop**（自動。plan-format 準拠の plan を issue 上に作成）→ **機械 plan review**
（独立検査）→ 分岐:

- **needs-review 無し**: そのまま driver が実装 → PR → CI → merge/Done。**計画から PR まで
  人手ゼロ**（Ready 不要）。trivial も例外を作らず trivial scale の数行 plan で同じレールに乗せる
- **needs-review 有り**: plan 完了後に**教材を自動生成**（解説 loop。needs-review ⟹ 読み物付き）
  → PdM が読む（= review という行為）→ **Projects で Backlog → Ready へ移動 = 承認 = 発火条件**

### 2. needs-review = 単一の人間キュー

- 付与は task 起票時（当面は人間が判断）。escalation の triage 後の判断案件にも同じ label を使う
- PdM の認知モデルは 1 文:「**Ready 待ちの列にあるのは、重要で・読み物付きの needs-review だけ**」

### 3. Ready の一般化

Ready = 「人間の読解・判断が完了した。機械は続行せよ」。task では実装解禁、escalation では
裁定の反映続行。規約 1 行: **Ready に動かす前に、言うべきことは issue に書き終えている**。

### 4. escalation 経路（triage 三分岐）

1. コンテキスト不足 → 文脈を補って自動再試行（人間に見せない）
2. 環境要因 → 既知 playbook 対処 or 環境修理 task の自動起票（人間に見せない）
3. **意思決定が必要 → needs-review 付与＋背景教材を自動生成**（状況の接地＋選択肢の中立整理・
   推奨なし・規模は scale 原則）→ PdM が読む → 裁定 comment → Ready

### 5. RED plan の扱い

機械 plan review が RED → planner の修正周回（上限 2）→ なお RED なら
**needs-review ＋ escalation label** を付与して人間キューへ（背景 = review 所見）。

### 6. plan-task の子 issue

既定で needs-review 無し（親 plan の承認が子を覆う）。plan が明示指定した子のみ付与して生まれる。

### 7. 盤面（GitHub Projects・Team backlog テンプレ 5 列）

- **カードは issue のみ**（PR は issue カードの状態遷移に反映。盤面を二重化しない）
- Backlog（起票済み・plan 進行中）→ **Ready（人間のみが動かす承認入力）** → In Progress →
  In Review → Done（issue close で内蔵 workflow が自動）
- **ADR 0031 §4 の修正**: Projects は原則ビューのままだが、**Ready 列だけは機械が読む承認入力**。
  In Progress / In Review は機械が書く投影（正本は導出・書き込み失敗は非致命）
- PdM の操作面は Projects に一元化（issue/PR/Discussion への到達も盤面から）

### 8. 承認意味論の移設と label 整理

- ADR 0034 の「教材 Discussion close = 承認」は **Ready 移動に一本化**（close は任意の既読整理）
- label 整理は後続作業: needs-plan は廃止方向（plan は全 issue の自動段）、gh default と
  Projects 列で表現できる label は廃止（棚卸しは Discussion #181 教材の表が下敷き）

## 置換・吸収

- ADR 0030 追記 A の needs-plan 振り分け → **廃止**
- #170（plan review 欠落）→ 機械 plan review 段として吸収
- #178（ADR 0034 承認ゲート）→ Ready 結線として吸収
- #117（escalation の intake 統一）→ triage 三分岐として再定義

## 実装（移行期の扱いを含む）

スライス: ① Projects 盤面作成（テンプレ・auto-add・close→Done）② driver/queue: plan 段の
全 issue 化・needs-review 分岐・Ready 読み取り・投影書き込み ③ triage 三分岐（#117 再定義）
④ 教材自動生成の結線 ⑤ label 整理・文書追随（loops.md／plan-format.md／#118 統合）。
**移行期特例**: 本 ADR の実装 task 群自体は骨子＝承認済み plan（#180・#181）とみなし、
現行 driver（#116 形）で流してよい。盤面完成後は新レールに従う。
