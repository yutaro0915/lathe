---
title: UI design language — observability-dense（新標準）
status: accepted
created: 2026-06-11
updated: 2026-06-11
---

# UI design language（2026-06-11 ユーザー選定）

4 方向の並行 probe 比較（原本 / A: minimal-dark / B: observability-dense / C: refined-light を
同一データ・同一 viewport の実working app で比較）の結果、**B: observability-dense を新標準に採用**。
ユーザー評: 「情報密度がちょうどいい」。A / C は不採用（probe branch は参照用に保持）。

- 正本実装: `probe/ui-b-observability` commit `718ce88`（旧 main `1327a3e` ベース）
- 適用先: turn-first 化された新 main（`a35cab9` 以降）へ port + 新要素への拡張

## 原則（probe B から抽出）

1. **色の配給制**: muted 6 色（slate blue / sage / sand / dusty violet / steel teal / gray）を
   `--cat-*` トークンに集約し、使用面を TimeRibbon・minimap・チャートに**限定**する。
   行・バッジはニュートラル + 小さな色 dot のみ。**エラー赤だけが全面で特権**。
   彩度を全面に撒かない（原本の最大の問題 = 彩度の洪水への恒久対策）。
2. **計測の規律**: 数値・時刻・パス・ID は **mono + `tabular-nums`**。メタ列（tok/dur 等）は
   固定幅右揃えで実質テーブル列にする。
3. **密度**: 行はコンパクト（padding 細め）、区切りは hairline。zebra は使わない。
4. **ラベル階層**: セクション見出し・分類ラベルは 9〜11px uppercase micro-label。
   counts は mono 右揃え。
5. **チャート**: bar = slate blue、line = sage に統一。25/50/75% の hairline gridline。
   凡例・軸は mono。
6. **レイアウト規律**: grid/flex は `minmax(0,…)` + `min-width:0` を徹底し、ページ幅の
   オーバーフローを構造的に防ぐ。長い diff 行は隠さず**ペイン内横スクロール**
   （無言の切り捨て禁止）。wide 画面はコンテンツ max-width 中央寄せ。

## 適用範囲

- 全画面（transcript / Git diff / overview / Stats / Subagents / Tools / Skills）
- turn-first の新要素（turn rollup chip・一行要旨・step 時間バー・files chip）にも同じ規律を適用
  （rollup の数値は mono + tabular、chip はニュートラル + dot、エラー turn のみ赤）

## 経緯

- 比較手法: 3 並行 worktree probe（exploration workflow）。各 probe は同じ layout バグ 3 件
  （overview 右半分空白 / Git タブ横オーバーフロー / 左 rail 階層）も各流儀で修正済み
- 選定材料の screenshot は本セッション転記、実装 diff は各 probe branch を参照
