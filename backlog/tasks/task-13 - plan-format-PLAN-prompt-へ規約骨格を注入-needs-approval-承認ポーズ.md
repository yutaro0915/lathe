---
id: TASK-13
title: 'plan-format: PLAN prompt へ規約骨格を注入 + needs-approval 承認ポーズ'
status: To Do
assignee: []
created_date: '2026-07-04 15:56'
updated_date: '2026-07-04 17:02'
labels:
  - loop
  - plan-format
milestone: m-18
dependencies: []
references:
  - design/plan-format.md
priority: high
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
design/plan-format.md（正本）を loop 機構に落とす。(1) PLAN prompt に5セクション骨格＋スケール規則＋設計原則の短い skeleton を注入（全文 inline せず正本参照）。(2) label 'needs-approval' を持つ task は PLAN_READY 後に driver が停止し PdM 承認を待つ。既存 resume 機構で IMPLEMENT から再開。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 PLAN prompt が plan-format の骨格（問題/選択肢/方針/契約/検証＋スケール規則＋設計原則）を注入する
- [ ] #2 needs-approval 付き task は PLAN_READY で停止し、resume で IMPLEMENT から再開できる
- [ ] #3 trivial クラス（軽量形）の既存挙動は変えない・既存テスト退行なし
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
実装形の PdM 裁定（2026-07-05）: prompt に骨格を複製しない。driver が PLAN prompt 組み立て時に design/plan-format.md を実行時読み込みで注入する（単一ソース・md⇄prompt の写し drift を作らない）。md 不在/読取失敗時は fail closed（黙って旧 prompt に落ちない）。

配置根拠（PdM 指示 2026-07-05: skill / custom agent prompt では不可の理由の列挙）:
(1) 到達性が provider 依存 — .claude/skills も .claude/agents も cc harness の機構。driver の PLAN 段は codex exec / claude -p を prompt 文字列で駆動し skills を読まない。内容の到達が backend 選択に依存する設計は model⟂role（ADR 0005/0009）に反する。
(2) skill は裁量読み込み — description トリガーで『参照され得る』仕組みであり、全 PLAN 出力が必ず従う規約の enforcement にならない。読んだか否かの観測も難しい。
(3) 写し drift — skill/agent に骨格を複製すると正本 md との写し間 drift を作る（manifest drift と同型の病）。『正本を参照せよ』とだけ書く形は (2) に戻る。
(4) agent .md は役割契約の正本 — 権限・役割境界（変更稀）と成果物様式（PdM の読みやすさ調整で変更頻度高）を同居させると、様式調整のたびに役割定義を触る羽目になる。
(5) codex への実効経路は結局 driver 注入 — buildCodexPrompt が agent 本文を inline する＝agent .md 経由でも届く理由は『driver が注入するから』。なら注入対象を正本 md にする方が写しが一段少ない。
(6) 反映タイミング — agents/*.md は hot-reload 遅延の実測あり（agent-workflow.md invocation 節）。runtime 注入は次 run から確定で効く。
(7) 監査可能性 — 注入なら PLAN prompt に何が入ったかが session/manifest に残り、宣言⇄実際の照合（meta-loop の gate-effectiveness）に載る。
限界（steelman）: 根本原因は指示到達経路の provider 分岐（flow 監査 DR2）。単一 instruction 基盤（agent-workflow 保留節）が採用されれば本件はそこへ吸収され、runtime 注入は暫定の戦術解である。
<!-- SECTION:NOTES:END -->
