---
id: 17
title: findings 表示 + 採否 UI（1 クリック + 理由一言）
status: todo
assignee: codex (/goal loop)
depends_on: [14]   # 15/16 と並行可（表示は DB 直読み）
estimated: medium
workflow: loop
audit: B
bound: 20 turns / 2h
---

## What

[ADR 0007](../adr/0007-finding-model-and-phase2-gate.md) Consequences。Phase 2 の表示面と
**採否オラクル UX**（ループ成立の急所。重いと止まる）。

1. **Findings タブ**（上部タブ列。Annotations と同様の routable in-page タブ。件数 badge = 未判定数）
2. 一覧: kind chip / title / analyst / confidence / evidence 数 / harness 版 / 未判定・採否状態。
   ui-design-language.md 準拠（ニュートラル + dot、mono 数値、未判定のみ目立たせる）
3. **採否 = 1 クリック + 理由一言**: 行内に Accept / Reject ボタン + 一言 input（Enter で確定、
   空でも確定可）。判定は finding_verdicts へ。**undo（直後の取り消し）**あり
4. evidence click → 該当 subject（Transcript の step / Git の hunk / PR）へジャンプ（既存導線再利用）
5. S2-1 の dogfood 線: accept した finding に「ハーネス編集はユーザー手動（P2 境界）」の注記表示

## 受け入れ条件（すべて機械検証）

| # | 条件 | 検証 |
|---|---|---|
| 1 | タブと一覧 | 新 E2E: fixture findings が一覧表示され、kind / analyst / 未判定 badge が DB と一致（independent oracle） |
| 2 | 採否フロー | 新 E2E: Accept click + 一言 → verdicts に行が入り UI が判定済み表示に変わる。undo で消える |
| 3 | 操作コスト | 新 E2E: 判定完了までの操作が「1 click（+ 任意入力 + Enter）」以内であることを操作列で検証 |
| 4 | evidence ジャンプ | 新 E2E: evidence click で該当 step / hunk が active になる |
| 5 | 回帰なし | e2e 全件 / build / coverage GREEN |

## Out of scope

- 採否データの分析・G2 定義の改訂（運用）/ 通知

## Loop 運用

- 作業ブランチ: `loop/17-finding-ui`（tasks/14 merge 後の main から分岐。16 と別 worktree で並行可）
