# ADR 0029: task 運用の唯一 UX と agent への周知経路

- status: accepted（2026-07-05 PdM 指示。「この運用を ADR にし、skill / md でどう agent に知らせるかを設計して実装 task を発行せよ」）
- date: 2026-07-05
- 関連: ADR 0025（task 基盤）／0026（単一ゲート・repo-only）／0027 + 追記（intake＝判断ゼロの登記機械）／0028（無人着地）／[design/loops.md](../design/loops.md)／[design/runbooks/outer-operations.md](../design/runbooks/outer-operations.md)

## 背景

基盤の決定は 0025〜0028 で出揃ったが、**「日々どう使うか」が人と agent に届く構造**が無い。
2026-07-05 に「知らされていない agent」問題が実際に 2 回起きた:

1. 並行 outer セッションが ADR 0027 の存在を知らず `backlog task create` を直接呼び、
   **task ID が衝突**した（TASK-12 / TASK-19）
2. intake の受付条件（`task-request` label）が repo のどこにも書かれておらず、
   起票した issue が**登記機械から不可視**だった

知識を repo に置く（0026 §4）だけでは足りない。**参照経路**——どのファイルが・誰に・
いつ読まれるか——を設計しなければ、次の新セッションにも届かない。

## 決定

### 1. 起票の唯一 UX（人間・agent 共通）

task の発行依頼は **`gh issue create --label task-request`** のみ。本文は自由（却下ゼロ、
ADR 0027 追記）。priority は label（`p0-urgent` / `p1-high` / `p3-low`、無指定 = medium）。
`backlog task create` を直接呼んでよいのは **intake Action だけ**。人間も監査役も agent も
例外なし（ID 採番の単一 writer を守る）。既存 task の**編集**（status / notes / AC）は
従来どおり CLI で可（intake が独占するのは新規発行のみ）。

### 2. 周知の階層（知識の置き場マップ）

| 層 | ファイル | 役割 | 分量規律 |
|---|---|---|---|
| 必読層 | `AGENTS.md` | 起票 1 行ルール + loops.md へのポインタ | 1〜2 行（予算 150 行内） |
| 会話の型 | `design/loops.md` | loop 台帳（intake 行は登録済み） | 1 ページ厳守 |
| 手順の正本 | `design/runbooks/outer-operations.md` §5 | 起票手順の詳細（登録済み） | — |
| 起票の入口 | `.github/ISSUE_TEMPLATE/task-request.md` | **便宜**テンプレ（label 自動付与のみ。必須フィールドは置かない＝却下ゼロ原則） | — |
| agent の手続き | inner/plan/meta 系 skill・driver | 起票動作を「issue 投函」に切替（ADR 0027 §3 の実装） | — |

原則: **決定は ADR・型は loops.md・手順は runbook・強制は機械（Action / CI）**。
同じ内容を複数箇所に書かない（ポインタで繋ぐ）。agent への周知に memory は使わない
（0026 §4 で廃止済み）。

### 3. 受け入れの物差し

新しいセッション（人間指示なし・repo だけ読める agent）が **AGENTS.md から出発して
起票の正しい経路に到達できる**こと。参照チェーン: AGENTS.md → loops.md / runbook。
逆に、`backlog task create` の直接呼び出しは duplicate-ID CI check（TASK-19）が
事後検出する。

## 却下した代替

- **AGENTS.md に手順を全部書く**: 予算 150 行・instruction-lint と衝突。ポインタのみ。
- **issue form で必須フィールドを強制**: 却下ゼロ原則（ADR 0027 追記）に逆行。テンプレは
  label 自動付与の便宜に留める。
- **agent への周知を memory / セッション記憶で行う**: repo 外の知識は stale 検出不能
  （0026 §4）。今回の事故の根因そのもの。

## 実装

実装 task を intake 経由で発行する（本 ADR とセットの issue）。スコープ:
(a) AGENTS.md へ起票ルール 1〜2 行 + ポインタ、(b) ISSUE_TEMPLATE（label 自動付与のみ）、
(c) plan-loop / meta ACT 系の起票先を issue 投函へ切替（TASK-19 旧 AC の「別 task」分）、
(d) 関連 skill の起票記述の更新。担当: (a)(d) は指示空間につき監査役起草、(b)(c) は inner 可。
