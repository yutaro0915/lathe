# ADR 0036: harness 改修の版管理 — loop を loop で改修しない

- status: accepted（2026-07-07 PdM 総括。#201 再編の実測に基づく）
- date: 2026-07-07
- 関連: #201（実測の場）／ADR 0026（bootstrap の先例）／0035／design/loops.md

## 原理（PdM 総括の写し）

**loop は完成しているから機能する。** 大きな系であっても、完成から少しでもずれた loop は
途端に道具でなく障害物になる。したがって **loop 本体（driver・orchestrator・ゲート機構）の
改修を、走行中の loop 自身に食わせてはならない**。改修はちょくちょく進めるものではなく、
**版（version）として計画し、outer の編成で一回で実装を完了させる**。

## 実測根拠（2026-07-07）

- loop 自身に #201 を回した場合: 確定済み plan の再生成に 25 分×2・FILE_CHILDREN の
  書式クラッシュ×2・規範誤読の ASK_PDM 空振り——**改修対象の不完全さが改修作業自体を破壊**
- outer 一括編成（bootstrap）に切替後: 15 スライスを 4 波 8 PR で数時間内に全着地。
  前置 review が着地前に real major 2 件（投影シグネチャ・stale fixture）を捕捉

## 決定（harness-release loop）

1. **対象**: loop 本体・ゲート・配車・状態面の意味論に触る改修すべて（= 改修中に自分自身の
   実行経路が変わり得るもの）。製品コード（apps/ 等）の通常 task は対象外＝通常 loop で回す
2. **版の計画**: scope を全スライスまで事前確定し、PdM が設計を一括承認する（needs-review の
   逐次消化にしない）。承認された設計文書（issue）が版の正本
3. **実装**: outer が bootstrap 編成（worktree 隔離 subagent の波状並列）で**一括実装**する。
   ゲートは全て維持——各着地は PR＋前置 review（PASS まで arm しない）＋CI
4. **切替と受け入れ**: 版の完了 = 全スライス着地 → 常駐の再読込 → **機械検証**（無人一巡
   GREEN 等、版ごとに受け入れ条件を事前定義）→ 完了記録（逸脱含む）を版 issue に残して close
5. **走行系との分離**: 改修中も現行版 loop は製品 task を回してよい。ただし改修対象パーツに
   触る task を現行 loop に流さない（needs-review 等で堰き止める）
6. bootstrap は「本来許されない例外」ではなく、**harness 版改修の正規手段**として本 ADR で
   位置づける（ADR 0026 の受理事例 2 件はこの先例）

## loops.md への反映

harness-release loop を台帳に追加する（本 PR）。既存の harness-hotfix（緊急最小修正）とは
別物: hotfix = 故障の止血・最小 diff、release = 計画された版の一括改修。

## 環境切替の検収 4 点基準（issue #282 追記、2026-07-08）

launchd→systemd 移行のような**常駐の実行基盤そのものの切替**（loop 本体ではなく実行基盤の
入れ替え）も、決定 4「切替と受け入れ」の具体化として、応急処置（case ローカルの drop-in・
手動 env 注入等）を撤去し repo の正本（unit ファイル・install script）のみに戻した状態で、
実 dispatch 1 件に対する機械照合 4 点をもって「切替完了」と宣言する:

(a) **live marker 生存**: dispatch した pass の live マーカー（`.lathe/runs/live-*.json`）が
    1 パス以上、kill されず生存する（cgroup 回収設定の誤りが無いことの証跡）
(b) **claude 応答**: dispatch された inner loop 内で claude 呼び出しが応答を返す
    （認証・環境注入が有効であることの証跡）
(c) **成果物の期限内出現**: 最初の成果物（PR / comment 等）が期限内に対象 issue 上に
    出現する（dispatch から着地までの経路が実際に機能することの証跡）
(d) **outcome=success 記録**: `.lathe/runs/outcomes.jsonl` に対象 dispatch の
    `outcome:"success"` レコードが記録される（機械集計可能な完了記録）

4 点すべてが GREEN で初めて切替完了。1 点でも欠ければ切替未完了として応急処置を維持し、
原因を repo の正本（unit / install script）へ反映してから再検収する（応急処置を case ローカル
に留めたまま次の切替に進まない — 実測 2026-07-08、issue #282: 未反映のまま進めた結果、
同じ環境差が次の導入先で再発した）。

関連: `ops/systemd/lathe-orchestrator.service`（KillMode=process・EnvironmentFile 反映）／
`ops/install/case-setup.sh`（self-check）。
