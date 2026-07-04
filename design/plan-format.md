# Plan Format — PLAN 段の成果物規約（正本）

> status: adopted 2026-07-05（PdM 指示。契機: ADR 0025 manifest drift の事後監査——plan が型・インターフェース設計を要求せず、PdM が読んで判断できる形でもなかった）
> 適用: inner-loop PLAN 段の成果物すべて。PLAN prompt（`scripts/inner-loop-prompts.mjs`）がこの骨格を注入し、needs-approval の task は PdM がこの形式で読んで承認する。

## 原則

**plan は PdM の判断材料である。PdM が理解できない plan は通らない。**
plan は「何を・なぜ」まで。「どうやって」の詳細は implement の仕事（plan が implement を食わない）。

## スケール規則（過剰形式化の禁止）

| クラス | 例 | 要求 |
|---|---|---|
| **trivial** | 明確なバグ修正・数行・契約/構造に触れない | **軽量形**: 問題 / 修正方針 / 検証 の3行〜。承認不要（既存の「低リスク小変更は軽量 plan で可」を維持） |
| **standard** | 機能追加・複数ファイル・契約/構造に触れる | **完全形**（下記5セクション）＋ needs-approval なら PdM 承認 |

## 完全形の5セクション

1. **問題** — 何が起きているか・なぜ今やるか（2〜5行。座標付き）
2. **選択肢** — 検討した解決策（2つ以上）と却下理由、採用案を選んだ理由（各1〜2行。ミニ ADR）
3. **方針** — goal と概要**のみ**。構造に触るならモデル図・UML・インターフェース概形（ASCII 可）を必ず入れる。**ファイル別の詳細手順は書かない**
4. **契約** — 契約（型・schema・API 境界・artifact 形式）に触るなら、**typedef / schema そのものを deliverable としてここに書く**。implementer はこれを変更できない（変更が必要なら ESCALATE）
5. **検証** — AC との対応・回す gate/tier・「実 artifact の照合」が要る場合はその手順

## 設計原則（plan が示すべきもの・reviewer / PdM の却下基準）

- **深いモジュール**: インターフェースは狭く、ロジックは深く。**複数の関数を呼ぶだけの薄い糊層を新設しない**（契機: `appendManifestEntry` が path 関数と中身関数を別々に呼び、同一情報が2つの入口から入って片方だけ配線された事故）
- **同一情報の入口は1つ**: optional 引数（opt-in extra）で契約が切り替わる API を作らない。呼び忘れが型的・実行的に成立する設計は plan の段階で却下
- **契約は型で表現し、型は PLAN が決める**: implementer は宣言された型に合わせて書く。型を変えたくなったら実装せず ESCALATE（型 = 設計判断 = PLAN の管轄）

## 運用

- 違反 plan は PdM / reviewer が**このドキュメントを根拠に差し戻す**（散文根拠の明文化が本書の役割）
- この規約で再発が防げない場合の次段: rubric 化（機械 ratchet）を検討——ただし依存追加は慎重に（gate-effectiveness 監査で効きを測ってから）
