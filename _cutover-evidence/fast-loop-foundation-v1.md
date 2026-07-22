# 高速ループ基盤 設計材料 v1（統合）

- 作成: 2026-07-08／read-only。読者: PdM。判定は書かない（§6 決定木のみ）。
- 入力: fl-velocity-requirements / fl-temporal-design-v0 / fl-alternatives / fl-github-role-redesign ＋ fl-critique（敵対検証・全指摘を本書に反映）＋ code-red-charter-material（M1〜M13/R1〜R8/S 系の正本）＋ foundation-decision-material（旧比較 routines vs 自作・runtime 子問題）。
- critique 反映の方針: 高重大度（A-1/A-3/B-1/C-1/E-1/E-2）は本文の設計・数値を**修正**、中低は注記。反映しきれない残余は §5 に隠さず列挙。
- 記法: 【接地】= 一次証拠あり／【未接地】【未確認】明記。数値正誤の統一: 07-04 merged = **31 件**（fl-github §2 の 5 件は窓切れ誤り・critique D-4）／run 母数 = **79 manifest**（66 は数え方の差・fl-velocity §1.6）／rework 率は二定義併存: **run 単位 36%**（25/70）と **stage 単位 50%**（CHANGES 18/LAND_REVIEW 36）——用途を都度明記（critique E-4）。

---

## 1. TL;DR

1. 構図 = **速い面／遅い面の分割**: 実行状態・排他・再実行判定は実行エンジン（DB 一次）が所有し、GitHub は「人間の入力面（起票・承認・裁定）＋読む面＋PR+CI 着地」に限定。**機械は GitHub から状態を読み戻さない**（方向規律）——S1-2（二重 dispatch/生成、窓内 3 回実弾・guard 後再発）の再発火条件を根治する。
2. エンジンは**二択に収束**: **Temporal self-host**（保証最強・値札 = 常駐 1 式＋non-determinism 新バグクラス＋学習 1〜2 週）vs **DBOS Transact TS**（追加常駐ゼロ・既存 PG 55433・急所 = プロセス生存中 hang の検知【未確認】）。routines は M3/M4 未解決（旧比較）で参考列に降格。
3. throughput は**全候補が 2〜4 桁の余裕で満たす**＝選定は容量でなく「保証の置き場」（M1 排他・M2 死活・M11 版固定）と値札の交換で決める。
4. Temporal の看板「claims テーブル消滅」は**過大**: Workflow ID の hard guarantee は「同時 open 1 本」のみで、Reuse Policy 既定（Allow Duplicate）は close 後の再 start を止めない。**再開始判定の設計は消えない**（critique B-1 反映済み・§3.1 で修正）。
5. velocity 要件のうち V2（p95≤15 分）・V3（≤5 分）は PdM 承認済み issue に接地。**V1（10〜20 PR/日）の錨は資料束に出典なし【未接地】**＝PdM 本人照合＋「人間律速の予算」（承認読解 1〜数時間/日）の成立確認が要件確定の前提（A-1/A-3）。
6. GitHub 着地は **1 task 1 PR 維持＋A'（strict=true・エンジン直列 arm・update-before-arm）＋push:main CI** が推奨。ただし定量根拠は「CI 51 秒」の世界の数字であり、**M13（heavy 層 CI 搭載）後の CI 予算で感度分析するまで「ほぼ無料」とは確定しない**（E-2）。
7. 承認入力の label 化（`gov:approve`）は機械検証面で優位だが、**未確認×未確認の比較**（timeline actor 網羅性 vs Projects actor 取得可否、両操作性とも未実測）。前日裁定 ADR 0035 の統治資産を置換する前に PdM 動線実測＋移行ハザード対策（drag だけして label 忘れ→統治 silent 停止）を条件化（D-1/D-2）。
8. 観測 = どちらのエンジンでも**無劣化**: `claude -p` はローカル worker/プロセスが spawn → local JSONL 100% → lathe ingest 変更ゼロ。Temporal Cloud を選んでも worker はローカル＝transcript 主権は保たれる。ただし「headless CLI を engine の step/activity で spawn」する公開先行例は**未発見**＝Step 0 で自前 existence proof を取る。
9. keep 資産（spawn 抽象・posting 台帳＋post-check・envelope・contracts・rubric 48 本・plan 契約・triage・gh 癖台帳）は**エンジン非依存の共通部品**として全案で同じ場所に載る＝裁定前の先行着手が無駄にならない。
10. 最安の不確実性削減 = **Step 0 spike 1〜2 日・並走可**（§7 の順: 錨照合→OS user 分離→spawn 実証→DBOS hang→Temporal podman/Policy）。

---

## 2. velocity 要件（確定数値案）

前提修正（critique 反映）: 「実測に正当化された目標」と言えるのは V2/V3/V6/V7。V1 は**目標としては可・実測正当化は不可**（単日ピーク 22 の 1 回到達 ≠ 毎日再現。直近 5 日の自律 loop 産は 31 日窓でなく 9・2・0・22・11＝中央値 ≈9）。

| # | 指標 | 確定数値案 | 接地状況・critique 反映 |
|---|---|---|---|
| V1 | 日次着地（**task loop PR に限定**・explain は別指標） | **10〜20 PR/日・5 営業日移動平均** | 【未接地】「PdM 発言」の一次出典なし（A-1）→ **裁定時に本人照合必須**。inner+explain 合算は Goodhart 脆弱（教材 PR で目標充足できる）のため task PR 限定に修正（A-6） |
| V1' | **人間律速の予算**（新設・V1 の成立条件） | PdM 承認読解 **20 件/日 × O(数分〜十分) = 1〜数時間/日** を PdM が受容するか | 【未検証】（A-3）。Ready→着手 p95 52 分の「機械遅延 vs PdM 不在時間」分解を §7-1 で先行実施。不成立なら V1 持続は基盤選定と独立に不成立＝V2 以降が非拘束制約の最適化になる |
| V2 | 反応遅延 Ready→着手 | **p95 ≤ 15 分**・設計値 pass ≤5 分＋非同期 dispatch | 【接地】issue #256（PdM「1,2,3 承認」）で本文一致確認済み |
| V3 | silent death 検知 | **≤ 1 pass（5 分）** | 【接地】issue #281（PdM「いいだろう」）。エンジン側の設定値対応を §3 に明記（B-3 反映） |
| V4 | 着地遅延（run 終端→merge） | **p95 ≤ 5 分**。ただし **wave（k≥6 同時 arm）時は k×CI 分の尾を正常系として許容**と再定義 | E-3 反映: V7（バースト正常系）と A' 直列 arm は素の p95 5 分と衝突する。再定義の採否は PdM 裁定 |
| V5 | 同時実行数 | **定常 3〜5・設計上限 10** | 導出を mean ベースで締め直し（A-4）: active は右裾分布（median 18.3・p90 46.2 分）＝mean 25〜30 分 → 20 PR/日で 8〜10h agent-busy → 3〜5 並列で日中窓。結論は維持・導出の甘さを明記 |
| V6 | 排他保証の窓 | **in-flight 全期間＋run 終了後の投影 lag 窓**（run wall p90 ≈150 分＋着地 lag）で二重生成が物理不可。cross-machine 込み | B-1 反映: 危険窓は run 終了後にも延びる（EXPLAIN#236 型＝同時 open だけでなく、close 後の「未完了」誤読も塞ぐ）。5 分だけ塞ぐ guard は `eca8247` で反証済み |
| V7 | イベント処理能力 | **分あたり複数 dispatch・1 pass 6+ を正常系** | 【接地】実測（<60 秒間隔起動 25%・1 pass 最大 6 dispatch） |
| V8 | 予算包絡 | **要件から降格 → PdM 裁定事項**: $70〜200/日（月 $2,100〜6,000）の支出承認 | A-5 反映: charter D1「コスト削減は選定理由にならない」は選定統制であって支出承認ではない。承認まで要件表に載せない |

連立性（不変）: V2/V5/V7 を維持する限り、現行部品（fs 導出 dedup・同期 dispatch・fail-open 書込）は構造的に壊れる（B1〜B10 照合表 = fl-velocity §3）。**V6・V3・V4 の同時採用で初めて充足可能**。「遅くして直す」は V2 と矛盾し選択肢にない。

---

## 3. 全体像

### 3.1 速い面 — エンジン 2 構成図

共通則（両案同一）: 実行状態・排他・再実行判定は engine DB 一次／`claude -p` spawn は**単一モジュール・ローカル実行**（credential なし・env strip・worktree 隔離）／gh 書込は**別 OS user の posting 面のみ**（唯一の credential・render→intent 台帳→REST→post-check→confirmed・失敗は台帳 failed＋次パス補償）／**intake が gh から読むのは人間の入力（新規 issue・承認 label・裁定 comment）のみ、状態は読み戻さない**（E-1 解消: fl-temporal 旧 M10「gh 導出維持」は本規律に書き換え済み）。

```
[案 T] Temporal self-host（保証を OSS engine から借りる）
  GitHub（入力・読み物・PR+CI 着地）＋ Actions cron = 系外 heartbeat
     ▲ 読み=人間入力のみ         ▲ 書込= worker B のみ    ▲ PR/auto-merge
  ┌ case ────────────────────────────────┐
  │ Temporal Service（podman compose: server+専用PG+UI、server≥v1.29.1）│
  │   = timer/retry/signal/history の正本。workflow ID task-N          │
  │ worker A（orchestration・credential なし・Versioning pinned）      │
  │   taskWorkflow: plan→投稿→await 承認(update)→implement→verify→land │
  │   spawn activity: claude -p ローカル spawn＋30 秒毎 heartbeat       │
  │   （heartbeat timeout ≤2.5 分・start-to-close 90 分 ⇒ V3 充足）     │
  │ worker B（posting・別 OS user・唯一の gh credential・別 task queue）│
  └── local JSONL 100% → lathe ingest（providers 変更ゼロ）──────┘
  M1 の正確な形（B-1 修正済み）: 「同時 open 1 本」は platform hard。
  close 後の再 start は Reuse Policy 裁定＋**intake の再開始判定を
  Temporal 照会（同 ID 実行履歴）or posting 台帳で行う**（gh 導出禁止）。
  ⇒ claims の「実装」は消えるが「再開始判定の設計」は残る。

[案 D] DBOS Transact TS（軽量代替最有力・ライブラリで既存 PG に建てる）
  GitHub（同上）＋ Actions cron = 系外 heartbeat
     ▲ 読み=人間入力のみ         ▲ 書込= posting proxy のみ ▲ PR/auto-merge
  ┌ case ────────────────────────────────┐
  │ engine プロセス（systemd 常駐 Node・DBOS ライブラリ・追加常駐ゼロ） │
  │   PG 55433 に system DB 同居。workflow ID task-N = exactly-once 起動 │
  │   step checkpoint→crash 後は最終完了 step から再開・durable sleep    │
  │   spawn step: claude -p ローカル spawn（案 T と同一モジュール）      │
  │   【急所】プロセス生存中 hang の検知は未確認 ⇒ 自前 watchdog        │
  │   （#281 の 3 点突合・純関数 5 個・PdM 承認済み plan）を oneshot 併設 │
  │ posting proxy（別 OS user・唯一の gh credential）= 自作案と同一部品  │
  └── local JSONL 100% → lathe ingest（providers 変更ゼロ）──────┘
  再開始判定: PG 一次（claim/台帳と同一 DB・同一トランザクション）＝
  「step 書込と durability 記録が同一 commit」のトランザクショナル保証。
```

### 3.2 遅い面 — GitHub の再設計後の役割

| 面 | 確定方向（裁定は §6） | 補強・条件 |
|---|---|---|
| 着地 | **1 task 1 PR 維持**（batch 棄却: ρ≈1.4%・P(rework 混入)≈89〜97%・S2-4 再輸入／direct-to-main 棄却: ADR 0026 事故の制度化・M3 放棄／merge queue: 個人 repo 不可=一次情報） | **A' = strict:true＋エンジン直列 arm＋update-before-arm（merge commit 方式・rebase 禁止）＋squash 統一＋push:main CI**。現存穴「merge 後合成状態が無検査」（strict:false・push CI なし=実測）を塞ぐ。**寿命条件**: M13 後 CI が 10 分級になれば +10 分/件・wave 尾 k×10 分＝直列 arm の再設計（並列 arm＋strict 別形）が要る（E-2）。judge を CI に上げる場合の LLM key 配置は M3 と緊張＝未設計 |
| 承認入力 | 遅延は決め手にならない（人間段 O(分〜十分) ≫ polling 5 分）。決め手 = actor 機械検証・PdM 操作性・契約面の広さ | **B 案（`gov:approve` label・polling 床・webhook は加速器限定）が候補優位だが、裁定は D-1/D-2 の条件付き**: ①timeline actor contract test（M12 第 1 号）GREEN ②PdM 承認動線の実測（drag vs label タップ・デバイス・所要） ③移行ハザード対策（移行期間は Ready 列と label を**等価に読む**＋watchdog が「Ready 在中×gov:approve 不在×N 分」を検出して注意 comment）。将来 = lathe UI intent（DB 権限で fail-closed・S2-11 の唯一の構造解） |
| issue | 起票面（`gh issue create`・採番・却下ゼロ = ADR 0031 実証資産・task key = issue 番号維持）＋読む面＋恒久記録。承認 = **その時点 plan の sha 固定 snapshot を engine が取り込む**（承認後編集の曖昧さ排除） | 二重台帳は方向規律で「台帳＋キャッシュ」に降格。残余 = 投影 stale で人間が誤読（S1 系には戻らない）→ 台帳⇄gh 毎パス突合＋generated-at 刻印 |
| 教材配信 | 承認材料は**承認が起きる場所へ一次配信**（REST・post-check 5 項目・intent_sha256 冪等）。Discussion は放送・アーカイブ面に格下げ（存廃裁定）。explains/ 正本 keep・auto-PR を承認 evidence に直列させない | D-3 反映: 「issue comment へ全文投下」は読む面を自分で劣化させる（#281 実物: plan×3＋escalation 堆積）。**一次配信の形式（collapsed section／固定 comment 更新／先頭要約＋リンク）は実装前に設計**——1 面化の狙いと全文投下は別物 |

### 3.3 観測 — transcript 主権の担保方式

- 両案とも spawn はローカル＝**local JSONL 100%・ingest providers 変更ゼロ・観測無劣化**。routines cloud の判定 B（効率監査の中核所見が一つも導出できない=実測済み）はどちらでも発生しない。Temporal Cloud 選択時も worker はローカル＝主権維持（Cloud は history だけ預かる）。
- 【未確認】「headless CLI subprocess を engine の activity/step で spawn」の公開先行例は Temporal/DBOS とも未発見（「無い」でなく「未発見」・技術的障壁は特定されていない）→ **Step 0 で両エンジンの自前 existence proof**（JSONL 残存＋ingest 成功まで）。
- 発展経路: 「engine が ingest schema へ直接書く」（D4-b・観測=正本）は engine DB を PG 55433 同居にした場合にのみ自然に開く＝案 D は既定で同居・案 T は Temporal 用 PG の置き場裁定に依存。

### 3.4 keep 資産の載せ場所（エンジン非依存＝先行着手可能）

| keep 資産 | 案 T での置き場 | 案 D での置き場 |
|---|---|---|
| spawn 単一モジュール（backends.mjs 改造・R5 backend 抽象維持） | worker A の activity 実装 | engine の step 実装（同一コード） |
| posting 台帳＋post-check 5 項目＋intent_sha256 | worker B（edge activities） | posting proxy（自作案部品そのまま） |
| envelope schema 群（M4） | activity 戻り値（history 永続） | step 戻り値（PG checkpoint） |
| contracts データ（plan 契約 6 節・explain 2 段化・watchdog-checks）・rubric 48 本 JSON・label 語彙 `gov:*`/`run:*` | repo データ（両案共通・エンジン外） | 同左 |
| escalation triage（純関数＋unit test）・R7 plan schema・R8 `gov:p1/p2/p3` | workflow の分岐関数 | workflow の分岐関数 |
| gh 癖台帳 Q1〜Q7・REST 移行知見 | M12 contract test 化（毎時＋CI） | 同左 |
| ADR 0031「導出」原則 | **方向規律に改訂**: 人間入力のみ gh から導出・実行状態は engine 一次（両案共通・E-1 の解） | 同左 |
| ADR 0036 版固定 | Worker Versioning pinned＋replay test（機械強制） | systemd 再起動規律＋CI からの版付き deploy（運用担保） |
| worktree 単一 writer・chip 禁止・切替検収 4 点（#282） | 運用規律として不変 | 同左 |

---

## 4. M1〜M13 三案比較表（critique C-1 の充足・同一物差し）

◎=構造/platform 保証・○=自前コードで充足・△=条件付き・✗=未解決。routines 列は旧比較（foundation-decision-material §2）の現時点評価を再掲（hybrid 込み）。

| # | 要件 | 案 T: Temporal self-host | 案 D: DBOS＋自前 watchdog | 参考: routines（cloud/hybrid） |
|---|---|---|---|---|
| M1 | 二重実行の物理不可能化 | **○→◎条件付**: 同時 open 1 本は platform hard・cross-machine 自動。ただし Reuse Policy 既定は close 後再 start を許す（B-1）→ Policy 裁定＋再開始判定の engine 照会化で ◎ | **○**: workflow ID exactly-once 起動＋PG 一意性（claim と同一 DB・同一 Tx）。再開始判定の設計宿題は案 T と同じ | ○ DB claim 同設計。DB 到達 (d) 未確認・不達 no-op が silent |
| M2 | silent death 検知 | **◎（run/worker 死）**: heartbeat 30 秒・timeout ≤2.5 分で V3 充足＋自動 retry。サービス/マシン丸ごと死は系外 heartbeat 必要（共通） | **△**: **hang 検知未確認（#281 直撃の急所）** → 自前 3 点突合 watchdog 併設が採用条件。crash 再開は PENDING scan で ○ | △ 系外監視なし・platform 相関故障（監視も同時沈黙） |
| M3 | 権能分離 fail-closed | △ task queue 分離＋別 OS user。**existence proof 未取得（三案共通）** | △ プロセス分離＋別 OS user（同上） | ✗ 実行 identity (g) 仕様待ち・最重大未解決 |
| M4 | I/O 構造化 | ○ activity 戻り値が history 永続（回収経路構造化） | ○ step 戻り値が PG checkpoint | △ envelope 回収経路が cloud-full で不存在 |
| M5 | 終端契約＋補償 | ○ retry policy＋compensate 分岐が骨組み。post-check 自前 | ○ step retry＋durable 再開。post-check 自前 | △ M4 連動で未規定 |
| M6 | spawn 単一モジュール | ○ 自前＋CI grep（三案同一） | ○ 同 | △ session 生成手段 (b) 未確認 |
| M7 | 版固定＋self-update | **◎ pinned が機械強制**（走行中は旧版完走・replay test）。裏面: worker 常駐の stale 化が戻る（deploy 規律で緩和） | △ ライブラリ＝プロセス再起動で版切替（oneshot 化は durable 再開と両立させる設計次第）。外部 id 名前解決は自前（共通） | ◎ 毎発火 fresh checkout |
| M8 | 環境正本化＋検収 4 点 | **✗→○ 三案中最重**: E クラス全残＋Temporal service 運用純増（podman 4 コンテナ・PG もう 1 系統・版上げ schema migration） | **○ 三案中最軽**: E クラス全残・**追加常駐ゼロ**・PG は既存 55433 | ◎/△ cloud で宿主消滅だが proxy 等の自前常駐 2〜3 新設で集計矛盾 |
| M9 | 投稿物 post-check | ○ 三案同一の自前設計 | ○ 同 | ○ 同（M4 経路に連動） |
| M10 | 状態は導出・二重台帳禁止 | ○ **修正後**: 人間入力のみ gh 読み・実行状態は engine 一次（E-1 解消） | ○ 同（PG 一次が最短） | ○ gh 導出維持＝投影 lag 窓の S1-2 残余あり |
| M11 | loop を loop で改修しない | **◎ 三案中最強**: repo コード＋PR+CI に加え pinned が走行中混入を機械禁止 | ○ repo コード＋PR+CI（機械強制なし・運用規律） | △ routine 定義・cron 変更がゲート外 |
| M12 | 外部契約 contract test | ○ 共通＋Temporal 契約は SDK 型と replay test が肩代わり | ○ 共通＋DBOS 契約面は npm ライブラリ（薄い） | ○ 共通 |
| M13 | CI 検証資産全量 | ○ 共通＋**replay test という新資産** | ○ 共通 | ○ 共通 |

**交換の要約（C-2 反映）**: Temporal 固有の実利は 3 点に縮む——①M11 の機械強制＋replay test ②activity heartbeat による hang 検知（DBOS の急所を platform で埋める） ③保証実装の bus factor 緩和。**値札** = 常駐 1 式（podman 4 コンテナ＋PG 追加）＋non-determinism という新バグクラス＋学習 1〜2 週【推測・実測なし】。DBOS 側の同 3 点の自前コスト: ①CI deploy 規律＋再起動運用（機械強制なし） ②watchdog 純関数 5 個＋oneshot（#281 plan で PdM 承認済み・実装未） ③自前保証の bus factor 1 が残る。**throughput（V1/V5/V7）は三案とも余裕で満たし選定を弁別しない**。PdM 裁定「プロジェクト外のハーネスは必要ない」に形態が最も適合するのは app 内ライブラリ＋既存 PG（案 D）——ただしこの整合は形態論であり、保証の強度（②の未確認）と交換関係にある。

---

## 5. critique 反映後の残リスク（隠さない）

1. **V1 の錨が未接地のまま**（A-1）: 「10〜20 PR/日」の一次出典なし。本書は本人照合を前提条件化したが、照合前に下流（V5 導出・予算包絡）が仮数値で走るリスクは残る。
2. **人間律速の予算が未検証**（A-3）: 承認 1〜数時間/日 が不成立なら、エンジン投資自体が非拘束制約の最適化。p95 52 分の内訳分解（§7-1）を先行させる以外の緩和なし。
3. **headless spawn の先行実例なし**（両案共通）: Step 0 の自前 existence proof が落ちた場合の代替（API 直叩き・ADR 0014 の別 backend）は設計未着手。
4. **M3 の existence proof 未取得**（三案共通）: OS user 分離＋LoadCredential が不成立なら fail-closed は準構造（運用規律）に後退＝受容裁定が要る。
5. **案 D の急所は未確認のまま**: DBOS の hang 検知は spike で潰す計画だが、「watchdog 併設で足りる」は #281 plan の設計信頼に依存（適用実績なし）。fan-out 時の PG ロック/WAL 負荷・1.3k★ の採用実績の浅さも残る。
6. **案 T の値札は消えない**: 学習コスト【推測】・schema migration の実務負荷【未調査】・「Temporal を知る人間 1 人」という新 bus factor。規模ミスマッチ（数 task/日 vs 百万/日級の道具）の構図も残る。
7. **A' の定量根拠に寿命**（E-2）: M13 後の CI 予算が未計測。CI が 10 分級なら直列 arm・V4 再定義とも再設計。judge の CI 昇格と M3（LLM key 配置）の緊張は未設計。
8. **承認 label 化の両側未実測**（D-1）: 本書は「実測後に裁定」に修正したが、実測（§7-9）自体が未実施。移行ハザード対策（D-2）も設計のみ・適用実績なし。
9. **移行窓の旧新併走二重**（S1-2 再発窓・両 critique 共通指摘）: gov:hold＋旧 timer/orchestrator 停止→新系 PoC の隔離手順を Step に明記したが、旧新併走の二重を検証する試験は「新系内の並列 2 issue」では代替できない＝切替時の運用リスクとして残置。
10. 細部: rework「15 分/件」の時間実測なし（与件）／V4 wave 尾の再定義は PdM 未承認／系外 heartbeat（Actions cron）の遅延・60 日無効化仕様は未実測／Temporal Cloud 価格は未照合。

---

## 6. 決定木（判定は書かない。根 = PdM の仮説採否は済み: 速い面=エンジン所有・遅い面=GitHub 限定・観測主権維持）

```
FL-0. velocity 数値の確定（他の全分岐の物差し）
│  0a. V1 の錨: 「10〜20 PR/日」を PdM 本人が確認（出典 or 口頭裁定として記録）
│  0b. 人間律速予算: 承認読解 1〜数時間/日 を受容するか
│      → 受容しない場合: V1 を下方修正 or 承認粒度の再設計（重要 task のみ Ready 承認等）
│      → ここが崩れると FL-1 の投資規模の妥当性が変わる
│  0c. V8: $70〜200/日 の支出包絡を承認するか
│
FL-1. エンジン選定（Step 0 spike 結果を待って裁定可能）
│  ├ 案 T (Temporal self-host):
│  │   T-a. Reuse/Conflict Policy と再開始判定の設計裁定（B-1。RejectDuplicate は正当再走も塞ぐ）
│  │   T-b. SDK 言語（基線 TS: Node 資産と地続き・sandbox 強制）
│  │   T-c. Temporal 用 PG: 55433 同居 or 専用
│  │   T-d. self-host 基線・Cloud（$100/月）は縮退先として保持（可逆）
│  ├ 案 D (DBOS):
│  │   D-a. hang 検知の補完方式（自前 watchdog oneshot 併設 = 既定）
│  │   D-b. system DB は 55433 同居（既定）→「観測=正本」発展経路が開く
│  │   D-c. 版固定の運用形（systemd 再起動規律＋CI 版付き deploy）で M7/M11 の機械強制なしを受容するか
│  └ 共通: M3 existence proof 不成立時 → 準構造（同一 user＋運用規律）受容 or 撤退
│
FL-2. 承認入力（FL-1 と独立・ただし実測 §7-6/9 が前提）
│  ├ Ready 列継続（ADR 0035 資産温存・S2-2 面と actor 未検証を受容する裁定として記録）
│  ├ gov:approve label 化（actor contract test GREEN＋動線実測＋移行期間の両入力等価読みが条件）
│  └ 将来: lathe UI intent への移行予約（ADR 0031 §6 の扉）を今認めるか
│
FL-3. 着地面
│  ├ A（現状＋push:main CI のみ）or A'（strict=true＋直列 arm・推奨）
│  ├ squash 統一の追認
│  └ M13 後 CI 予算の感度分析（§7-8）後に A' の直列度を再確認（>10 分なら再設計）
│
FL-4. 配信面: Discussion 存廃／教材一次配信の形式（全文 or 要約＋リンク or 固定 comment 更新）
│
FL-5. 共通に決めるもの（エンジン非依存）
│   credential 種別（GitHub App or machine user PAT）／基盤の置き場
│   （lathe repo 内 ADR 0038 packages or 別 repo——「プロジェクト外のハーネス不要」裁定との整合）
│   ／共通部品（§3.4）の先行着手承認／Step 0 spike の実施承認
```

---

## 7. Step 0 検証項目の統合リスト（実測で潰す順・1〜2 日で並走可）

順序基準: 要件の根 → 採用可否を左右 → 設計の骨格 → 周辺。[T]=Temporal に効く・[D]=DBOS に効く・[共]=両案/裁定全体。

| # | 検証項目 | 効く先 | 潰し方／分岐 |
|---|---|---|---|
| 1 | **V1 錨の PdM 本人照合＋人間律速の分解**（Ready→着手 p95 52 分の機械遅延 vs PdM 不在時間。07-07 の承認所要の復元） | [共] FL-0（要件の根） | spike でなく裁定前確認。不成立なら V1 下方修正＝エンジン投資規模の再考 |
| 2 | **OS user 分離＋LoadCredential の existence proof**（agent が repo を書けて token を読めない） | [共] M3 採用可否 | case 上 1 日。不成立→準構造受容の裁定へ |
| 3 | **headless `claude -p` spawn の engine 内実証**: [T] 長時間 activity＋heartbeat＋worker kill→retry／[D] step 内 spawn＋crash→PENDING 再開。**両方で local JSONL 残存＋lathe ingest 成功まで確認** | [共] 設計成立・観測主権 | 先行実例未発見の穴を自前で閉じる。落ちたら backend 差し替え（ADR 0014）設計へ |
| 4 | **DBOS: プロセス生存中 hang の検知可否**（公式に heartbeat 明記なし） | [D] M2 採用可否 | 1 日 spike。検知不能なら「自前 watchdog 併設」が正式条件＝案 D の値札に計上 |
| 5 | **Temporal: case podman で compose 実測**（Postgres 構成・server ≥v1.29.1/CLI ≥v1.4.1/UI ≥v2.38.0＝Versioning GA 条件）＋**Reuse Policy 挙動実測**（close 後の同 ID 再 start・Conflict Policy） | [T] 採用可否・T-a | 動作報告はあるが本環境未検証。Policy 実測は B-1 の設計裁定の材料 |
| 6 | **timeline `labeled` イベントの actor 網羅性**（M12 contract test 第 1 号） | [共] FL-2 前提 | 承認検証の共通前提。取れなければ label 化の優位が崩れる |
| 7 | **CC headless の schema 強制出力可否** | [共] M4 強度 | 不成立でも bounded retry で運用可（強度 1 段落ち・三案同条件） |
| 8 | **M13 後 CI 予算の計測**（heavy 層 e2e/storybook/integration/judge を CI 相当で回した実測値） | [共] FL-3 感度 | CI >10 分なら A' 直列 arm・V4 再定義とも再設計。judge の key 配置（M3 緊張）も此処で設計 |
| 9 | **PdM 承認動線の実測**（Ready drag vs label 付与の実タップ数・所要・デバイス） | [共] FL-2 | 未確認×未確認の比較を実測に置換してから裁定（D-1） |
| 10 | **Actions cron の実遅延＋60 日無活動自動無効化の本 repo 照合** | [共] M2 系外段 | SLO 未達なら系外監視の代替（別マシン・外部監視）裁定へ |
| 11 | 課金経路（API key か Max サブスク充当か） | [共] V8/D1 材料 | $150.9/79run 前提の照合 |
| 12 | OS user 分離×worktree 運用詳細（git 所有権・pnpm store 共有） | [共] 運用 | #2 に同梱 |
| 13 | Projects v2 列移動 actor の API 取得可否 | [共] FL-2 で Ready 継続を選ぶ場合のみ | 選ばなければ不要 |

補足: #2〜5 は相互に排他でなく並走可能（計 1〜2 日）。#1・#8・#9 は spike でなく計測・照合であり、裁定日程と独立に着手できる。§3.4 の共通部品（claim/台帳 DDL・post-check・envelope・contracts・triage・M13 CI 全量）は**どの分岐でも無駄にならない**＝Step 0 と並行の先行着手候補。
