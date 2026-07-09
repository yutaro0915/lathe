meta-audit 完了しました（対象: 統一世代 13 issue / 42 stage・旧世代 37 issue / 197 stage を分離集計。接地 = run manifest の stage 別 duration_ms ＋ orchestrator.log のパス間隔 ＋ gh の PR/CI 実測）。

## どこで時間がかかっていたか（実測）

**統一世代（ADR 0035）の stage-time 内訳**: IMPLEMENT **38%**（median 8.1 分）> LAND_REVIEW 22.7% > TASK_PLAN 19% > PLAN_REVIEW 13% > LAND_REWORK 7.3%。

しかし壁時計の消え方はレイヤで全く違いました:

1. **旧世代は壁時計の 68〜96% が idle**（stage ごとに dispatch を待って寝ていた。#46 は正味 11.8 分に対し壁時計 296 分）。**統一世代はこれがほぼ 0**（driver が 1 プロセスで back-to-back 実行、stage 間 gap 0.0〜0.2 分）。ADR 0035 の単一 driver 化が最大の勝ち筋で、**ここは維持**
2. 統一世代の最大損失は構造でなく**単発事故**: #229 の LAND_REVIEW が API socket error で **~72 分 stall（課金ゼロ）**。これ 1 件が run 壁時計を倍化
3. **rework 周回 1 回 ≒ 15 分**（review 4.6m + rework 6.1m + 再 review 4.6m + 再 CI）。LAND_REVIEW の 1 周目 CHANGES 率は 3/10
4. CI は median 1.0 分・全 success で**非ボトルネック**。dispatch リードタイム（Ready→着手）は median 15 分・最大 52 分

## #189 の粒度論点への含意

- implement の **median は既に 8.1 分**で、議論の仮置きレンジ（5〜15 分)に収まっています。合計を押し上げるのは p95 の大型実装（#186 32.4 分・12 ファイル）のみ
- overhead（plan＋review 系）は stage-time の **62%**。分割は implement（38%）しか割れず、overhead は task 数に比例して増える — **「分割義務より、まず p95 の見積り超過を観測せよ」**が数字の答えです。規範は「見積り欄必須化＋実測超過の meta finding」で足り、時間上限の分割強制は不要と考えます

## 短縮案（効果順・裁定候補）

1. **【fix・最優先】stage の API エラー耐性**: 接続系エラーを短い上限（60〜120s）で打ち切り→同一 stage 即再試行。あわせて orchestrator 側に dead-driver 検知（open PR × driver 生存痕跡なし × 未 arm → 再 dispatch）。#229 型で **1 件 ~50〜70 分**の回収
2. **【improve】1 周目通過率の向上**: 頻出 CHANGES 事由（例: #229 の「gh 失敗時の倒し方が plan の明示制約と逆」）を実装段の自己検証チェックリストに前倒し。CHANGES 3/10→1/10 で **~5 分/run**
3. **【improve・別枠】dispatch リードタイム**: パス間隔の上限を締める（空きスロット時は 5 分間隔保証）。p95 52 分→15 分。run 本体でなくスループット改善
4. **【却下推奨】auto-merge 既定 arm**: 監査は「PASS 前 arm」を提案しましたが、これは **review 前置の裁定（ADR 0035 追記）と衝突**します。現行の「PASS 後 arm」でも green 後 tail は ~3 分で、review 時間は削るべきでない本体です

レポート全文は監査役が保持（必要なら repo に収載します）。**1〜3 の起票をご承認いただければ task-request で流します** — このコメントへの返信一言で結構です。
