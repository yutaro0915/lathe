# 設計の founding 原則: agent と human の二重操作性（dual-operability）

2026-06-13 ユーザー表明。lathe の**根本哲学**として全設計に反映する。導入の完全形は最終フェーズ
近くになる見込みだが、それまでの各設計が**この方向を塞がない**こと。

## 原則

1. **agent が使えること = human が使えること と同等、もしくはそれ以上に重要**。lathe は「人間が
   見るビューア」ではなく、**agent と human が同じ UI・同じ能力で共同作業する場**。
2. **同じ UI を agent も human も使う**。人間専用 UI を作らない。人間ができる操作はすべて agent も
   できる（その逆も）。
3. **agent にとてもフレンドリーであるべき**: 機械可読な構造、すべての human 操作に対応する
   MCP ツール面（query / verdict / backlog 更新 / 分析実行 等）。observability-dense な UI は
   人間の可読性と機械可読性を兼ねる（既に整合）。
4. **chat はどこからでも呼べる**べきで、agent は「今何をやっているか」を確認できるべき
   （= P2.5 chat/agent と直結。全画面に被さるレイヤー構想）。
5. **agent は付属物ではなく一級のオペレーター**: 分析させる / 異常検知させる / タスクを任せる /
   マネージさせる。これらを最初から念頭に置く。

## 各設計が守るべき含意（塞がないこと）

- **MCP tool 面は UI のミラー**: 人間が画面でできる主要操作は packages/mcp / lib/mcp の tool として
  agent にも開く（現状 query_findings / submit_finding が原型。verdict・backlog 操作・分析起動も
  将来 tool 化できる形に）。
- **findings / backlog は agent 操作可能に**: triage・accept・backlog 状態遷移・改修案起こしを agent が
  実行できる余地を残す（human 専用のクリック前提で hard-code しない）。
- **データ構造は agent が読んで意味が取れる形**（根拠リンク・logical coordinates など既存方針と整合）。

## 時期

- 完全な agent operability（agent が分析・検知・タスク受領・マネジメントまで担う）は**最終フェーズ
  近く**に導入。それまでは「塞がない設計」を維持し、P2.5（chat/agent）でその土台を作る。
- 現在の finding 深掘り + backlog の設計（design/phase2-finding-depth-and-backlog.md）も、この
  二重操作性と P2.5 接続余地を前提に進める（findings は「仮」）。
