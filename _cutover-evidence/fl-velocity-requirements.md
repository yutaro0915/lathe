# velocity 要件の定式化 — 「超高速ループ」を設計入力の数値にする

- 作成: 2026-07-08／対象 repo: `/Users/cherie/LLMWiki/projects/lathe`（read-only・書き込みなし）
- 情報源: `.lathe/runs/*.json`（run manifest 79 本・stage 433 件、うち duration 有効 367 件）・`.lathe/runs/outcomes.jsonl`・`.lathe/logs/orchestrator.log`（1,805 行）・gh 読み取り（merged PR 132・issue 137）・`scratchpad/code-red-charter-material.md`
- 一次情報 URL の基底: https://github.com/yutaro0915/lathe （issue/PR/Discussion 番号は全てこの repo）
- 記法: 【実測】= 本調査でログ/API から機械計測した値。【引用】= issue/charter 記載の他者計測値。【推測】【未確認】は明記。

## 0. 観測の限界（先に明示）

1. 【未確認】`.lathe/runs/` は Mac ローカルの manifest のみ。**2026-07-04〜06 の run manifest が存在しない**（07-03 の次が 07-07）にもかかわらず同期間に inner PR 11 件が merge されている（07-04: 9・07-05: 2）。case 機など別ホストの run 記録は本調査から見えない。run 側の実測は 07-01〜03（bootstrap 窓・codex 主体）と 07-07〜08（claude 主体）の 2 窓に偏る。
2. 【実測】`orchestrator.log` の窓は 2026-07-07T12:31Z〜07-08T03:19Z（pass 120 回）のみ。charter §6-2 のとおり同時期は case 常駐と Mac launchd の**併存期**であり、本 log は系全体の部分観測。
3. stage `ts` は段の終端時刻、開始 = `ts - duration_ms` として復元（issue-229.json で連続性を検算済み）。run の wall clock には escalation・PdM 待ち・中断が混入する（active time と分けて示す）。

## 1. 実測プロファイル

### 1.1 着地スループット（merged PR/日）【実測・gh】

| 日 | 合計 | inner（task loop） | explain | outer/その他 |
|---|---|---|---|---|
| 07-04 | 31 | 9 | 0 | 22 |
| 07-05 | 17 | 2 | 0 | 15 |
| 07-06 | 5 | 0 | 0 | 5 |
| 07-07 | **60** | **17** | 5 | 38 |
| 07-08（部分日） | 13 | 4 | 7 | 2 |

- ピーク 07-07 は合計 60 PR/日、うち**自律 loop 産（inner+explain）22 PR/日**。PdM 目標「1 日 10〜20 PR」は、自律 loop 単独で 07-07 に一度は実測到達済み（ただし単日・事故多発日でもある。§3）。
- 07-07 の merge 間隔: median 15.0 分・最短 0.8 分・最長 98.9 分。07-04 は median 7.2 分・最短 0.1 分。

### 1.2 同時 in-flight 数の分布【実測・manifest 復元】

run（開始〜終端の区間 sweep、n=70）:

| 同時数 | 稼働時間シェア（>=1 run 稼働中の時間内） |
|---|---|
| 1 | 47% |
| 2 | 15% |
| 3 | 12% |
| 4 | 10% |
| 5〜10 | 15%（max **10**） |

- **稼働時間の 53% は同時 2 run 以上**。「同時実行は例外」ではなく定常状態。
- open PR の同時数（後に merge された PR の created→merged 区間）: max 6。open>=2 が open 時間の 34%。

### 1.3 段所要（duration 有効値のみ、分）【実測】

| stage | n | median | p90 | max |
|---|---|---|---|---|
| IMPLEMENT | 84 | 6.9 | 13.8 | 32.4 |
| REVIEW | 63 | 3.1 | 5.2 | 6.7 |
| PLAN | 56 | 3.7 | 7.5 | 10.1 |
| VERIFY | 47 | 1.5 | 5.3 | 27.2 |
| LAND_REVIEW | 36 | 4.6 | 7.7 | 18.7 |
| TASK_PLAN | 32 | 4.8 | 6.8 | 9.7 |
| PLAN_REVIEW | 28 | 3.9 | 7.8 | 9.5 |
| LAND_REWORK | 17 | 5.4 | 10.6 | 13.6 |

- run の **active time**（段所要の総和）: median 18.3 分・p90 46.2 分・max 107 分。
- run の **wall clock**（待ち・中断込み）: median 28.7 分・p90 152.7 分・max 515 分（issue #189、escalation 停止を含む）。
- run 内の段間ギャップ: median ≈0 分だが >10 分が 21 件・>30 分が 14 件（escalation・通信断・pass 待ちで開く）。
- 1 run あたり段数: median 5・p90 8・max 12。rework 発生率: **25/70 run（36%）が CHANGES を 1 回以上経験**＝1 発 GREEN を前提にできない。

### 1.4 イベント発生間隔【実測】

- run 開始の間隔: median 21.1 分。ただし **60 秒未満が 17/69（25%）**＝pass 内バースト起動（1 pass 最大 6 dispatch を実測）。
- orchestrator pass 間隔（Mac log 窓）: median 5.1 分（設定 300 秒どおり）・**>10 分が 10/119・max 65.9 分**（同期 dispatch で長 run が pass をブロック）。別窓の meta-audit【引用・issue #256 / Discussion #251】では median 15 分・max 51.9 分・**Ready→着手 p95 52 分**。
- issue 起票: ピーク 42 件/日（07-07。task-request のみで 41 件/日）。task-request の created→closed: median 1.3h・p90 50h。
- 着地 lag（inner run 終端→PR merge）: **15/20 件が 0.1 分以下**（auto-merge 正常系は実証済みに速い）。outlier 3 件 = 42 分（#263）・46.5 分（#239）・**533 分（#189、escalation 手動回収）**。

### 1.5 「前が着地する前に次が生まれる」重なりの実測頻度

- run レベル: **40/69（58%）の run が、別 run の in-flight 中に開始**。【実測】
- PR レベル: 35/131（27%）の PR が、別の（後に merge される）PR の open 中に作成。【実測】
- 同一 target への複数 dispatch（Mac log 窓 15h 内で 5 組）: PLAN#206×3（初回 exit=1 failure 後＝正当再試行）・PLAN#171×3（→子 issue 8 件二重投函事故 #241–#248）・IMPLEMENT#225×2・IMPLEMENT#117×2（再 dispatch の正当性は【未確認】、silent death 後の回収の可能性）・EXPLAIN#236×2（03:09:29 と 03:14:32 の連続 pass、outcomes.jsonl に success 2 件 03:17:50/03:20:11＝**dedup guard `eca8247` 後の再発**）。【実測】
- Discussion 二重生成: #294=05:40:16Z / #295=05:40:24Z の **8 秒差**（gh GraphQL で再検証済み）。【実測】
- 定量的な含意: **evidence の着地 lag（run 完走 8〜30 分）> pass 間隔（5 分）である限り、状態導出だけに依存した再実行判定は構造的に二重 dispatch を生む**。EXPLAIN#236 はその最小再現（run 約 8 分 > pass 5 分 → 次 pass が「未完了」と誤読）。

### 1.6 コスト面【実測】

- manifest 合計 $164.4（79 run。charter の「66 run・$150.9」と数え方が異なるのは attempt ファイルと 07-08 分の差）。
- 07-07 の claude 主体 run は $1〜13/run（median ≈ $5〜8）。07-07 単日の manifest 合計 ≈ $137。→ **現行の turn 効率のまま 10〜20 PR/日を回すと $70〜200/日**のオーダー（issue #301 の情報注入契約がコストレバー）。【実測に基づく推算】

## 2. 目標値の提案 — PdM「1 日 10〜20 PR・動的で高速」の翻訳

前提: 07-07 実測（自律 loop 22 着地/日）が示すとおり、目標は能力の背伸びではなく「**単日ピークを事故なしで毎日再現する**」ことの定式化である。

| # | 指標 | 実測（現状） | 提案目標 | 根拠 |
|---|---|---|---|---|
| V1 | 日次着地（自律 loop 産 merged PR） | max 22/日・中央値はるかに下 | **10〜20 PR/日を持続**（単日ピークでなく 5 営業日移動平均） | PdM 発言そのまま。実測 22/日で到達可能性は実証済み |
| V2 | 反応遅延（Ready→着手） | p95 52 分【引用 #256】 | **p95 ≤ 15 分**、設計値は pass ≤ 5 分＋非同期 dispatch | issue #256（PdM「1,2,3 承認」済みの数値）を要件へ昇格 |
| V3 | 検知遅延（silent death） | >60 分・発見が PdM 質問起点 | **≤ 1 pass（5 分）** | issue #281（PdM「いいだろう」承認済み）を要件へ昇格 |
| V4 | 着地遅延（run 終端→merge） | 正常系 ≤0.1 分・outlier 533 分 | **p95 ≤ 5 分＋書込失敗の次パス補償**（outlier の恒久化禁止） | auto-merge 正常系は実証済み。壊すのは fail-open（#229） |
| V5 | 同時実行数 | 実測 max 10 run／6 PR | **定常 3〜5・設計上限 10**（上限は縮退でなく排他保証の設計点） | 20 PR/日 × active median 18.3 分 ≈ 6.1h agent-busy/日 → 同時 3〜5 で日中窓に収まり、rework 36% とバースト（<60s 起動 25%）を吸収 |
| V6 | 排他保証の窓 | dedup が pass 間隔前提で破綻 | **in-flight 全期間（run wall p90 ≈ 150 分）で二重生成が物理的に不可能**（DB 一意性、cross-machine 込み） | §1.5。5 分だけ塞ぐ guard は eca8247 で反証済み |
| V7 | イベント処理能力 | 6 dispatch/pass・起票 42 件/日・起動間隔 <60 秒が 25% | **分あたり複数 dispatch・1 pass 6+ dispatch を正常系として設計**（バーストを異常扱いしない） | §1.4 実測 |
| V8 | 予算包絡 | ≈$137/日（07-07） | **$70〜200/日を許容包絡とし、削減は turn 数（情報注入 #301）で行う**。runtime 選定の理由にしない | §1.6・charter D1「コスト削減は選定理由にならない」 |

【推測】V5 の「定常 3〜5」の導出: 20 PR/日を直列（同時 1）で回すと active 6.1h＋rework＋escalation 待ちが直列化し、PdM 承認が日中に集中するバースト（07-07 実測: 数分間隔の連続 Ready）を吸収できない。逆に常時 8〜10 は排他・観測・レビュー面の検証が追いつかない（07-07 の事故密度）。3〜5 は実測の同時分布（2〜4 で 37%）を「正常運転」として包含する最小レンジ。

## 3. この velocity で壊れた既存部品（テンポ起因 incident の再掲と、目標値との対応）

| # | 壊れた部品 | 事故（一次証拠） | どの目標値が事故を**再現**するか | どの設計で**回避**するか |
|---|---|---|---|---|
| B1 | 実行中検出（fs/worktree 導出） | 二重 dispatch 窓内 3 回実弾化: #171→子 issue #241–#248 二重投函・EXPLAIN#236 二重・Discussion #294/#295 8 秒差（charter S1-2） | **V2（pass 5 分）単独で必ず再現**（run > 5 分である限り誤読窓が開く）。V5（同時 3+）が被害を増幅 | V6: DB 一意性で 2 本目を物理的に生成不能に（charter M1）。pass 間隔を run p90 より伸ばせば消えるが V2 と矛盾＝**遅くして直す選択肢は目標と両立しない** |
| B2 | 同期 dispatch（pass が run 完走を待つ） | pass 間隔 max 65.9 分【実測】・Ready→着手 p95 52 分（#256） | V5（同時 3+）×長 run（p90 wall 150 分）で必ず再現 | 非同期 dispatch（charter R2）。V2 の p95 15 分は非同期化なしに達成不能 |
| B3 | silent death 検知（不在） | #281: cgroup 回収で子が全滅・発見 1h 超・PdM 質問起点（charter S1-1） | V7（40 dispatch/15h のバースト）で死の発生機会が増え、V2 の速さに対して「死んだまま気づかない」時間が相対的に肥大化 | V3: 起動記録×live marker×outcome の 3 点突合を毎 pass（charter M2） |
| B4 | escalation 書込の fail-open | #229: 通信断で label/comment 両失敗→非致命 continue→**永久 WAIT_PR**・~72 分ハング・手動 resume（charter S1-3） | V5（同時 3+）で外部書込回数が線形増→失敗遭遇率も線形増。V4 の outlier 533 分（#189）と同族 | V4 の補償経路＝終端契約の機械執行（charter M5） |
| B5 | plan-task の並行実行排他 | #171 並行実行で FILE_CHILDREN 二重（M4） | V5・V7（同時 dispatch を正常系にする）で再現 | V6 の一意性を「issue 単位の in-flight」粒度で張る |
| B6 | 常駐コードの鮮度 | #263: 5 commit 遅れの旧コードが hold を知らず dispatch（charter S2-1） | **V1 そのもの**: 20 PR/日 ≈ main が数時間で 5 commit 進む＝self-update なしの常駐は数時間で必ず stale | 版固定＋毎 pass ff-only self-update（charter M7。Mac log 07-08 分に `self-update: synced` 実装済みを確認【実測】） |
| B7 | rework の rebase 戦略 | #224: push 済み履歴を書き換え non-FF 拒否→escalation 停止（charter S2-4） | V1×V5: main 前進が速く in-flight PR が多いほど「PR open 中に main が進む」が常態化 | open PR 検出で rebase skip（#229 で修正着地済み）＋FF-only |
| B8 | explain 配信（即興 gh コマンド） | #299: `@file` 未展開 stub 2 本が承認材料化・二重生成（charter S1-4） | V1（教材も 10〜20 本/日ペースで生成）で stub の混入率が承認ゲートを直撃 | V4 系の post-check（charter M9）＋決定的スクリプト化 |
| B9 | 外部 id 直書き（盤面 option id） | #201/#202: id 全再生成で Ready 検出 silent 停止（charter S2-2） | テンポ起因ではないが、V2（5 分 poll）が silent 停止を「毎 5 分空振り」に変える＝発見までの損失が velocity に比例 | 毎 pass 名前解決（charter M7）＋contract test（M12） |
| B10 | Stop hook（書式強制の再生成） | #302: review 全文 2 回生成の二重課金（charter S2-5） | V1×V8: 20 PR/日 × 周回 36% rework で課金増幅が予算包絡を圧迫 | 構造化出力（charter M4）。hook 廃止 |

**帰結（設計入力としての要点）**: 実測が示すのは「velocity を落とせば事故は消える」ではなく、**V2/V5/V7 を落とすと PdM 目標と矛盾し、維持すると現行部品（fs 導出 dedup・同期 dispatch・fail-open 書込）が構造的に壊れる**という二律。したがって velocity 要件は「目標値の表」単体でなく、**V6（in-flight 全窓の排他）・V3（5 分検知）・V4（補償）を同時採用して初めて充足可能**な連立要件として扱うこと。

## 4. 未確認事項

1. 07-04〜06 の run manifest の所在（case 機か・削除か）。同期間の inner PR 11 件の run 側時刻は復元不能だった。
2. IMPLEMENT#225/#117 の再 dispatch（07-07T19:43）の理由（silent death 回収か二重か）。manifest の wall 328/285 分に長い中断ギャップがあることのみ実測。
3. #256 の「median 15 分」と本調査 Mac log の「median 5.1 分」の差は観測窓・ホスト差とみられるが、meta-audit（Discussion #251）の測定窓を直接確認していない。
4. Ready 列移動（承認）の時刻は Projects の event として取得しておらず、Ready→着手は #256 の引用値に依拠。
5. case 機側 orchestrator log・outcomes は未見。同時 in-flight max 10 は Mac 視点の下限であり、併存期の系全体ではより高い可能性。

## 付録: 再現コマンド（read-only）

- run 解析: `node scratchpad/analyze-runs.mjs`・`node scratchpad/analyze2.mjs`（stage ts/duration からの区間復元・sweep）
- log 解析: `node scratchpad/analyze-log.mjs`（pass 間隔・重複 dispatch 抽出）
- gh 取得: `gh pr list --state merged --limit 300 --json number,createdAt,mergedAt,headRefName` ほか（scratchpad/gh-*.json に保存済み）
