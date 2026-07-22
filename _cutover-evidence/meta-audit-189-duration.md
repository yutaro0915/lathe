# meta-audit: 実装 task 1 周の「時間内訳」監査（run duration）

**対象**: lathe 統一ライフサイクル（ADR 0035）における実装 task 1 周。**分析タイプ**: run duration 監査（どの段で壁時計時間が消えているか）。
**問い（Discussion #251, PdM）**: 「実際にどこで時間がかかっていたのかを meta-audit で確認するべき。lathe を利用して。それでより具体的な案を出すべき」
**接地**: `.lathe/runs/issue-*.json`（stage 別 duration_ms/ts）＋ `.lathe/logs/orchestrator.log`（pass 間隔）＋ `gh`（PR→merge・CI）＋ lathe MCP（`list_runs` で run 世代照合）。**read-only・提案のみ**。

世代の混同を避けるため **統一世代（2026-07-07・ADR 0035 世代: issue 138/139/140/143/147/186/189/206/224/225/229/231/232/239）** と **旧統治世代（issue 23〜62・multi-dispatch）** を分けて集計しています（平均は混ぜていません）。

---

## ① stage 別集計表（世代別）

### 統一世代（13 issue / 42 stage-observation・stage-time 合計 255.2 min）

| stage | n | median | p95 | 合計 | 合計比 | verdict 内訳 |
|---|---|---|---|---|---|---|
| IMPLEMENT | 8 | 485s (8.1m) | 1941s (32.4m) | 97.1m | **38.0%** | IMPL_DONE 8 |
| LAND_REVIEW | 10 | 278s (4.6m) | 1122s (18.7m) | 57.8m | **22.7%** | PASS 6 / CHANGES 3 / UNPARSABLE 1 |
| TASK_PLAN | 13 | 240s (4.0m) | 368s (6.1m) | 48.6m | 19.0% | PLAN_READY 8 / ESCALATE 5 |
| PLAN_REVIEW | 8 | 254s (4.2m) | 423s (7.1m) | 33.1m | 13.0% | PASS 7 / RED 1 |
| LAND_REWORK | 3 | 365s (6.1m) | 427s (7.1m) | 18.6m | 7.3% | IMPL_DONE 3 |

- **IMPLEMENT が最大の単一段**（38%）。ただし median は 8.1 分と穏当で、合計を押し上げているのは p95 の外れ値（#186 32.4m / #143 25.8m の大型実装）。これは「消える時間」ではなく**正味の作業時間**。
- **LAND_REVIEW（22.7%）は n=10 と回数が多い**。CHANGES 3 / UNPARSABLE 1 が示すとおり、**同一 PR に対する複数周回**（review → rework → 再 review）が回数を膨らませている。p95=18.7m の 1 件は API socket error の空振り（後述 ③）。
- **TASK_PLAN の verdict のうち 5/13 が ESCALATE**（#138/139/140/189/225）。これらは 1 段 2.5〜5.6 分で即エスカレーション終了＝**「1 周」に到達していない run**。壁時計は短く、時間監査上のボトルネックではない。

### 旧統治世代（37 issue / 197 stage-observation・stage-time 合計 662.7 min）※対比

| stage | n | median | p95 | 合計 | 合計比 |
|---|---|---|---|---|---|
| IMPLEMENT | 54 | 305s | 1527s | 373.2m | 56.3% |
| REVIEW | 52 | 162s | 367s | 140.0m | 21.1% |
| VERIFY | 39 | 69s | 765s | 79.1m | 11.9% |
| PLAN | 49 | 41s | 281s | 66.9m | 10.1% |
| TRIAGE | 3 | 103s | 112s | 3.6m | 0.5% |

- 旧世代も **IMPLEMENT が最大**（56%）。段構成は違う（VERIFY/TRIAGE が独立段）が、「実装が正味最大」という骨格は世代を跨いで不変。
- ここで重要なのは **stage-time でなく壁時計**（②）。旧世代は stage-time が小さくても run の壁時計が桁違いに長い。

---

## ② 壁時計の内訳（agent 実行 vs 待ち時間）

「1 周の壁時計」は 3 レイヤに分解できます。**待ち時間の所在が世代で激変している**のが最大の発見です。

### レイヤ A: run 内 stage 間の idle（＝ dispatch を跨ぐ待ち）

各 run の「最初の stage 開始 → 最後の stage 終了」の壁時計スパンから、stage-time 合計を引いた idle。

**統一世代（driver が全ライフサイクルを 1 プロセスで連続実行）**:

| issue | stages | stage-time | wall-span | intra-gap(idle) |
|---|---|---|---|---|
| 229 | 7 | 51.9m | 105.6m | **53.7m** ←唯一の大 idle |
| 224 | 6 | 32.9m | 49.0m | 16.1m |
| 239 | 6 | 29.4m | 29.6m | 0.2m |
| 231 | 6 | 28.5m | 28.7m | 0.2m |
| 232 | 4 | 15.4m | 15.5m | 0.1m |
| 147 | 4 | 8.1m | 8.2m | 0.2m |
| 143/186/138/139/140/189/225 | 1〜3 | — | — | **0.0m** |

**旧統治世代（stage ごとに orchestrator が別 dispatch＝multi-dispatch）**:

| issue | stages | stage-time | wall-span | idle | idle率 |
|---|---|---|---|---|---|
| 46 | 5 | 11.8m | 296.4m | 284.6m | **96%** |
| 40 | 5 | 12.3m | 278.6m | 266.2m | **96%** |
| 28 | 5 | 10.9m | 152.7m | 141.7m | 93% |
| 27 | 5 | 10.1m | 143.0m | 132.9m | 93% |
| 26 | 7 | 23.2m | 133.4m | 110.1m | 83% |
| 30 | 5 | 45.8m | 197.9m | 152.2m | 77% |
| 24 | 6 | 48.0m | 149.3m | 101.3m | 68% |
| 23 | 5 | 16.9m | 52.3m | 35.3m | 68% |

> **これが ADR 0035 の最大の効果であり、同時に「時間内訳」の核心**。旧世代は run の壁時計の **68〜96% が idle**（stage 間で run が polling パスを待って寝ていた）。統一世代は driver が TASK_PLAN→PLAN_REVIEW→IMPLEMENT→LAND_REVIEW を **1 プロセスで back-to-back**（各 stage 開始が前 stage 終了の ~1 秒後）に回すため、intra-gap は **ほぼ 0**。#229 の 53.7m だけが例外で、これは idle でなく **API エラーの in-process stall**（③）。

### レイヤ B: orchestrator の dispatch 待ち（パス間隔）

`orchestrator.log`（10 pass・2026-07-07 12:31〜15:24）のパス間隔:

- **median 15.0 分・min 5.0・max 51.9 分**（間隔列: 5.0, 5.0, 9.0, 11.0, 15.0, 17.7, 25.4, 32.3, 51.9）。
- 統一世代では driver が 1 プロセスで完走するため、**dispatch 待ちは「run の開始まで」の 1 回だけ**に縮んだ（旧世代は stage ごとに毎パス待った）。ただし **新規 issue が Ready になってから最初に dispatch されるまで、最悪 1 パス分（median 15 分・最大 52 分）待つ**。この待ちは run duration そのものではないが「issue を投げてから着手までのリードタイム」として体感時間に乗る。

### レイヤ C: PR→merge の tail（manifest の外側・gh 実測）

**manifest は最後の LAND_REVIEW PASS で終わるが、「task 完了」は PR merge**。この tail は manifest に一切写らない。

| issue | PR# | open→merge | CI |
|---|---|---|---|
| 186 | 191 | 1.0m（auto-merge） | 0.9m |
| 143 | 200 | 1.3m（auto-merge） | 1.2m |
| 232 | 249 | 2.5m | 1.0m |
| 147 | 215 | 3.9m | 0.9m |
| 231 | 253 | 6.6m | 0.9m |
| 224 | 226 | **32.8m** | 1.0m |
| 229 | 230 | **85.6m** | 1.0m |
| 239 | 250 | 未 merge（open） | 1.1m |

- **CI は速く一様（median 1.0m・全 success）＝ボトルネックではない**。
- **PR→merge の median は 3.9 分**だが、#224（32.8m）・#229（85.6m）が突出。gh 実測では **#229 は 1 回目 CI green（14:12:54）→ 2 回目 commit まで 80.5 分の idle → 再 CI green（15:34:26）→ 2.9 分後 merge**。この 80.5m は manifest の #229 LAND_REVIEW stall（53.7m）と**同一事象を別アンカーから測ったもの**（PR 側の方が長く見えるのは CI green 時刻起点のため）。
- **auto-merge を付けた 2 件（#186/#143）が最速**（~1 分）。auto-merge 無しは CI green 後に人/driver の merge 操作を待つ。

---

## ③ 外れ値 run とその原因

| run/stage | 消えた時間 | 原因（manifest verdict / result_text 実データ） |
|---|---|---|
| **#229 LAND_REVIEW #1** | 18.7m 空振り + 53.7m stall | verdict=UNPARSABLE・cost=0.00・result_text=`API Error: Unable to connect to API (FailedToOpenSocket)`。socket error で 18.7 分ハングし verdict を出せず、リトライの 2 回目 LAND_REVIEW が始まるまで **53.4 分の in-process 空白**（14:30:30→15:23:55）。**課金ゼロだが最大の時間損失**。PR 側でも 80.5m の idle として観測。 |
| **#229 全体** | wall 105.6m（正味 51.9m の 2 倍） | 上記 socket stall が run 壁時計を倍化。これ 1 件を除けば統一世代の intra-gap は最大 16m（#224）。 |
| **#224 LAND_REVIEW → REWORK 周回** | +16.1m idle / open→merge 32.8m | verdict CHANGES → LAND_REWORK(IMPL_DONE) → LAND_REVIEW(PASS)。gh 側で「PR life 中の re-push で CI 2 回」。**review 指摘 1 件（回避可能）で 1 周分の追い commit と再 CI が発生**。 |
| **#231 PLAN_REVIEW RED → TASK_PLAN やり直し** | +7m（PLAN_REVIEW 1 周 + TASK_PLAN 再実行） | 唯一の PLAN_REVIEW RED。plan が 1 回で通らず TASK_PLAN→PLAN_REVIEW を 2 周（RED→PLAN_READY→PASS）。 |
| **#186 IMPLEMENT** | 32.4m（p95） | verdict IMPL_DONE・cost 7.43。12 ファイル 1 commit の大型実装。**正味作業＝削減対象でない**（分割の是非は別論点）。 |
| **TASK_PLAN ESCALATE 5 件** | 各 2.5〜5.6m | #138/139/140/189/225。1 段で即エスカレーション＝「1 周」未到達。壁時計は小さく、時間監査の主対象ではない（ただし件数は多い＝別途エスカレーション率の監査対象）。 |

**まとめ（統一世代の壁時計の消え方）**:
1. **正味の agent 実行**（IMPLEMENT 38% + review 系）＝削減対象外の本体。intra-gap がほぼ 0 になった今、run 壁時計 ≒ stage-time。
2. **rework 周回**（LAND_REVIEW CHANGES→REWORK→再 REVIEW／PLAN_REVIEW RED→再 PLAN）＝**review 品質で削れる冗長**。#224・#231 で各 +1 周。
3. **API エラーの in-process stall**（#229 の 53m）＝**インフラ起因の単発だが 1 件で最大の損失**。
4. **PR→merge tail**（median 3.9m、auto-merge 無しで CI green 後に滞留）＋ **dispatch リードタイム**（median 15m・最大 52m）。

---

## ④ 具体的な短縮案（効果順・期待削減の見積り根拠つき）

### 案 1【最優先・fix】LAND_REVIEW の API エラーに in-process タイムアウト＋即時リトライを入れる

- **根拠**: #229 LAND_REVIEW #1 が `FailedToOpenSocket` で 18.7 分ハング＋その後 53.4 分の空白（合計 ~72 分・課金ゼロ）。統一世代 13 run 中この 1 件だけで run 壁時計を倍化させ、PR→merge を 85.6 分に押し上げた。
- **対策（提案のみ）**: socket/接続系エラーを verdict UNPARSABLE として長時間ハングさせず、**短い上限（例 60〜120s）で打ち切り→即座に同一 stage を再試行**する retry ガードを driver stage runner に。cost=0.00 のエラー stage は「失敗即再試行」に分類。
- **期待削減**: この事象再現時に **1 件あたり ~50〜70 分**。頻度が 13 run 中 1 件でも、統一世代の壁時計外れ値の唯一の主因なので費用対効果が最も高い。

### 案 2【高・improve】LAND_REVIEW / PLAN_REVIEW の 1 周目通過率を上げ、rework 周回を減らす

- **根拠**: LAND_REVIEW n=10 のうち CHANGES 3（#224/#229/#239）で追い commit の 1 周が発生。#224 は review 指摘 1 件で +16m idle と open→merge 32.8m。#231 は PLAN_REVIEW RED で TASK_PLAN やり直し +7m。**周回 1 回 = review(4.6m) + rework(6.1m) + 再review(4.6m) ≒ 15m + 再 CI/再 push の tail**。
- **対策（提案のみ）**: 頻出する CHANGES 事由（例: #229 の「gh 失敗時フォールバック方向が plan と逆」は plan の明示制約に反する実装ミス）を **plan-format / IMPLEMENT の事前チェックリストや rubric の機械検査に落とせるものは前倒し**（review でなく実装前/実装時に捕捉）。plan の「gh 失敗は FF 保全側 true」のような**方向性制約を実装段の自己検証項目に含める**。
- **期待削減**: CHANGES 発生率を 3/10 → 1/10 に下げられれば、統一世代あたり **周回 2 回 ×15m ≒ 30 分＋再 CI/tail** の削減。1 run 平均では ~5 分/run。

### 案 3【中・improve】merge 済み PR の tail を auto-merge で潰す

- **根拠**: auto-merge を付けた #186/#143 は open→merge ~1 分（最速 2 件）。付けていない PR は CI green（~1m）後も merge 操作待ちで滞留（#231 6.6m 等、外れ値除く median 3.9m）。CI 自体は median 1.0m で速く、tail は「green 後の待ち」。
- **対策（提案のみ）**: driver 産 PR に **auto-merge を既定で arm**（CI green + review PASS で自動 merge）。既に explain PR では auto-merge を使っている（log の "auto-merge arm"）ので、task PR にも横展開。
- **期待削減**: 1 PR あたり **~3〜5 分**（外れ値の #224/#229 は別要因＝案 1/2 で対処）。安定効果。

### 案 4【中・improve】dispatch リードタイムの短縮（polling 間隔の下限を締める）

- **根拠**: orchestrator パス間隔が median 15 分・**最大 52 分**。統一世代は driver が完走するので run 中の dispatch 待ちは消えたが、**Ready になった issue が最初に着手されるまで最悪 1 パス（〜52 分）待つ**。これは run duration ではないが「投げてから着手まで」の体感リードタイムに直結。
- **対策（提案のみ）**: パス間隔の**上限を締める**（例: 空きスロットがあるときは最短 5 分間隔を保証／52 分の伸びの原因＝長時間 run に dispatch がブロックされているなら並列度調整）。**run duration ではなくスループット/リードタイムの改善**なので、案 1〜3 と別枠で扱う。
- **期待削減**: 着手リードタイムの p95 を 52m → ~15m 以内に。run 本体の壁時計には効かないが、複数 issue を捌く 1 日の総リードタイムに効く。

---

## 付記（keep＝壊さない知見）

- **ADR 0035 の driver 単一プロセス化は run duration の最大の勝ち筋**。旧世代の 68〜96% idle を統一世代でほぼ 0 に落とした。**この構造は維持**。案 1〜4 はいずれもこの上に乗る周辺最適化で、本体の再設計は不要。
- **CI（~1m・全 success）と TASK_PLAN/PLAN_REVIEW の正味時間（各 median ~4m）は健全**。ここは触らない。
