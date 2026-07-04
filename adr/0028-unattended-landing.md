# ADR 0028: 着地の無人化 — auto-merge 標準・required review 不採用・governance tripwire

- status: accepted（2026-07-05 PdM 指示「この程度の作業に人力マージはおかしい」を受けた裁定の記録。本 PR の merge をもって確定）
- date: 2026-07-05
- 関連: ADR 0026（単一着地ゲート。**本 ADR は §2 の「branch protection の required review として機械強制」を修正する**）／ADR 0027（intake）／TASK-16（branch protection cutover＝実装先）／#69（intake 基盤＝実装先）

## 契機

ADR 0026/0027 で「main の唯一の入口 = PR + CI GREEN」に一本化した結果、intake の task 登記のような定型 PR まで PdM の merge クリックを要する形になった。機械で確かめた（CI GREEN）ものに人間の儀式を重ねるのは 0026 §0（簡素化）に反する。

## 決定

### 1. auto-merge 標準
PR 作成者（inner driver / intake routine / 監査役）は作成直後に `gh pr merge --auto --squash` を設定する。CI GREEN で無人着地。repo 設定 `allow_auto_merge` / `delete_branch_on_merge` は有効化済み（2026-07-05）。

### 2. required review は設けない（0026 §2 の修正）
0026 §2 は review の置換先を「branch protection の **required review** として機械強制」としたが、**単一アカウント運用では PR author の self-approval が GitHub 仕様で不可能**なため、required review は全 PR を deadlock させる（PR #67 で実証: author = 同一アカウント）。よって:

- review の担保 = **reviewer の verdict＋本文を PR に投稿（non-blocking）** ＋ **CI による gate 再実行**（0026 の「主張させない・機械で確かめる」は維持）
- branch protection の required は **status checks のみ**（TASK-16 の設定制約）

### 3. governance tripwire（CI required check）
`adr/` `rubrics/` `design/loops.md` `.github/` に触れる PR は、label **`pdm-approved`** が無ければ CI RED。統治文書の変更だけは「CI GREEN なら無人」にしない——PdM の承認コストを「rare な PR への label 1 タップ」に縮めつつ、rogue な governance 変更の無人着地を防ぐ。暗号学的保証ではなく「宣言は観測」（0026 §5）と同型の tripwire（単一アカウントの限界。強化は TASK-10 = GitHub App 分離で可能になった時に再訪）。

### 4. `needs-approval` の例外
`needs-approval` label 付き task 由来の PR は auto-merge を設定しない。**PdM の merge クリック自体が承認行為**として意図的に残る（plan 承認と同じ、少数の意思決定点）。

## 人間の手が残る点（これだけ）

| PR | 人間 |
|---|---|
| intake 登記・inner loop 実装 | なし（無人） |
| governance path | `pdm-approved` label 1 タップ |
| needs-approval 由来 | PdM が merge（＝承認） |

## 却下した代替

- **required review ＋ bot/GitHub App 分離**: review を blocking にするには第2の identity が必須。App 化（TASK-10）は正当だが、いま無人化のためだけに導入するのは過剰。App 化が別理由で入った時に §2 を再訪。
- **全 PR 人力 merge の継続**: 儀式コスト。機械検証済みへの人間クリックは検査でなく摩擦。
- **governance も完全無人**: rogue な統治変更（本 repo で懸念が実在）が CI だけで通る。tripwire 1 タップは残す価値がある。

## 実装

- TASK-16: branch protection = required status checks のみ（required review なし）
- #69: governance-path label check を CI required に追加・intake routine の `--auto` 規約
- 本 PR: 0026 §2 に修正註記を付す
