# §6 durable execution はどう関係するか — 機能ベース

- 作成: 2026-07-09／read-only 編纂（repo・issue・PR への書き込みなし）
- 読者: 本プロジェクトを一切知らない外部の分析 AI（repo アクセス不可）を想定。内部用語は初出で定義し、参照先の内容は本文に収載する。
- 情報源: fl-temporal-design-v0（Temporal ベース基盤設計）・fl-alternatives（軽量代替の比較調査）・fast-loop-foundation-v1（統合設計材料・敵対 critique 反映済み）・code-red-charter-material（事故台帳と要件の正本）。いずれも 2026-07-08 作成の一次調査文書。
- 記法: 全主張に【事実】（一次証拠あり）／【設計仮説】（PdM 裁定前の設計提案）／【critique】（敵対検証者の指摘。設計側の主張への反論として峻別）／【未確認】のタグを付す。PdM = プロダクト裁定者（人間・本プロジェクトの意思決定者）。

---

## 6.0 前提 — この節を読むのに必要な最小文脈（用語定義込み）

### 6.0.1 プロジェクトと壊れた系【事実】

- **lathe**: AI コーディング agent の観測・改善・評価を行うプラットフォーム（Next.js + Postgres）。本節の主題は lathe 本体ではなく、**lathe の開発自体を回していた自律 agent ループ（開発基盤）**である。
- その開発基盤の形: GitHub issue = task（issue 番号がそのまま task ID）、**orchestrator**（5 分間隔で常駐発火するプロセス）が承認済み task を検出して **inner agent**（`claude -p`＝Claude Code CLI の headless・非対話モード）を **dispatch**（子プロセスとして起動）し、agent が plan（計画）→ PdM 承認待ち → implement（実装）→ verify（検証）→ land（PR 作成・CI 通過・merge）を進める。1 回の agent 走行を **run**、その内部工程を **stage** と呼ぶ。task の状態は保存せず GitHub から**導出**する原則（open PR あり=In Progress 等）。人間の承認入力は GitHub Projects 盤面の **Ready 列**（そこへ issue を移すことが承認）。
- 2026-07-08、PdM がこの基盤の**全面再構築（code red）を裁定**。実測 66〜79 run・326 stage・$150.9 の完走実績はあるが（「動かない」は不成立）、下記 5 つの事故クラスが実弾化していた。

### 6.0.2 構造で不可能にすべき事故クラス 5 つ【事実・incident 26 件からの帰納。原文 verbatim】

> 1. **二重 dispatch / 二重生成**（M3→M4→M8、窓内 3 回）— fs マーカー導出をやめ、DB 一次の一意性制約で「2 本目が物理的に生成できない」形へ。
> 2. **stale 常駐・stale 定数**（M1・M6・A2）— 版固定 LoopDefinition＋パス冒頭 ff-only self-update＋外部 id の毎パス名前解決。
> 3. **成果物・所見の transcript 死蔵**（P1–P3・A1）— stage 終端契約を「正本への投稿完了」まで機械執行、失敗は記録＋次パス補償。
> 4. **散文契約に依存する I/O**（F1–F4）— prompt 契約の構造化データ化・配信は決定的スクリプト・配置は決定的規則。
> 5. **silent death**（E1×M9・A1）— 起動記録×live marker×outcome の 3 点突合を原因非依存で常設＋install self-check＋検収 4 点。

（M3/M4/A1 等は incident 台帳の行 ID。代表実弾: **二重 dispatch** = 同一 task に agent が 2 本走り子 issue 8 件が重複投函・教材 2 本が 8 秒差で二重投稿、防止 guard 追加**後**にも再発／**silent death** = OS の cgroup 回収で dispatch 子プロセスが産まれた直後に全滅、ログ 0 byte・検知機構ゼロ・発見が 1 時間超後の人間の質問起点／**終端保証の破れ** = 通信断で GitHub への label 付与と comment 投稿が両方失敗したのに「非致命 continue」で握りつぶされ、系が「open PR=In Progress」と誤読して永久待機。）【事実】

### 6.0.3 新基盤への必須要件 M1〜M13【事実・正本 verbatim。本節の対応表が参照する要件 ID の定義】

> | # | 要件 | 根拠 incident |
> |---|---|---|
> | M1 | **二重実行の物理的不可能化**: dispatch は単一 writer、run の生成は DB 一次 RunStore の一意性制約で排他。fs マーカー・worktree 有無からの実行中導出を禁止。cross-machine（複数ホスト併存）も同一制約下に置く | M3/M4/M8（窓内 3 回実弾化・guard `eca8247` 後も再発）・#237 |
> | M2 | **silent death 検知の常設**: 起動記録×live marker×outcome の 3 点突合を原因非依存・毎パスで実施。信号ゼロの死を人間の質問より先に機械が報じる | E1×M9（#281、発見 1 時間超・PdM 起点）・A1（#254、痕跡ゼロの永久 WAIT_PR） |
> | M3 | **権能分離 fail-closed**: inner 実行体は起票・merge・承認系の credential を最初から持たない（token scope 分割 or 書き込みの driver/orchestrator 一元 proxy）。承認入力（Ready 移動・close・reaction）は agent 資格情報と分離された面に置く。hook（fail-open・配布されない・検証不能）を統治機構の置き場にしない | cr-runtime §3 R1/R2（#224＋pin 貼り忘れ 2 箇所現存）・G1（無承認起票）・G2（承認シグナル汚染、ADR 0034 §4 自認の限界） |
> | M4 | **I/O の構造化**: 散文 prompt 契約の禁止。verdict・plan 書式・配信 body は runtime の構造化出力（JSON schema／envelope）と決定的スクリプトで機械保証。Stop hook による書式強制（prompt 再生成）は採用しない | F1（書式クラッシュ×2）・F2（stub #292/#295）・F4（二重課金 #302）・資産⑧（PdM 裁定「プロンプトに頼る前に機械的保証」） |
> | M5 | **終端契約の機械執行＋書込失敗の補償**: stage 完了 = 「正本（issue/DB）への投稿完了」まで。書込失敗は「非致命 continue」で握りつぶさず、記録＋次パス補償（冪等 repair を done-explain 限定でなく全書き込み面に）。エラーメッセージは実在する参照のみ指す | P1（#239 transcript 死蔵）・P2/P3（#192 所見不達）・S1-3（#229 label/comment 両失敗の恒久化） |
> | M6 | **runtime spawn の単一モジュール集約**: agent 呼び出しは 1 モジュール経由に強制し、全 caller をその経由に限定する機械検査を置く | cr-runtime R5（spawn 4 箇所分散・pin 貼り忘れ 2 箇所） |
> | M7 | **版固定＋self-update**: LoopDefinition の版固定＋パス冒頭 ff-only self-update で stale 常駐を構造排除。外部 id（盤面 option id 等）のハードコード禁止・毎パス名前解決 | M1/M6（#263、5 commit 遅れ走行）・A2/Q4（#202 option id 失効） |
> | M8 | **環境前提の repo 正本化＋install self-check＋切替検収 4 点基準**: KillMode・認証・依存はすべて repo 正本（ops/…・install script）に恒久化。導入・切替は (a) live marker 1 パス生存 (b) claude 応答 (c) 成果物の期限内出現 (d) outcome=success の 4 点機械照合で完了宣言 | E1〜E4（#281/#282。基準は PdM 承認済み・適用実績は未確認） |
> | M9 | **投稿物の post-check**: 教材 Discussion・comment 等の外部投稿は、実在・非 stub（本文長・展開済み）・対象整合を投稿直後に機械照合。失敗は M5 の補償経路へ | Q7/F2（#292/#295 が承認材料として盤面に載った）・cr-github-defects §4-5 |
> | M10 | **状態は保存せず正本から導出・二重台帳禁止**: ADR 0031 原則を維持しつつ、導出の証拠着地ラグは M1 の一意性制約で塞ぐ（導出だけに依存した再実行判定をしない） | 資産①（実証済み）・M1(ledger)（二重帳簿事故）・cr-github-defects §4-1（ラグが再実行の窓になる実測） |
> | M11 | **loop 本体を loop で改修しない**: harness-release を別 loop（outer 一括編成）に分離 | G6（#201 で改修対象の不完全さが改修作業自体を破壊 → ADR 0036 の対照実測） |
> | M12 | **外部契約の contract test**: gh API 挙動・盤面 id・CI action の前提を毎回検証する面を置き、「silent 障害→実測→hotfix」の順を逆転する | cr-github-defects §4-3（Q1〜Q6 がすべて事後発見）・A3 |
> | M13 | **着地ゲート CI への検証資産の全量搭載**: PR+CI が単一着地ゲートである以上、テスト/rubric 資産の全量を CI に載せる | R2（#279「ザル」自己認定）・ADR 0026 |

（表中の #N は GitHub issue 番号、`eca8247` 等は git commit ID、ADR NNNN は Architecture Decision Record 番号。読者は参照先にアクセスできない前提のため、必要な内容は本文に展開済み。）

### 6.0.4 durable execution とは【事実・一般定義】

**durable execution** = ワークフロー（多段の処理列）の各ステップの結果と発火予定を永続ストアに記録し、プロセス・マシンの crash 後に**記録（履歴）を replay して「最後に完了したステップの続きから」再開できる**実行モデル。代表実装は Temporal（OSS サーバー＋SDK）、DBOS（Postgres 上のライブラリ）、Restate・Inngest 等。共通して提供される primitive は概ね次の 7 つ:

1. **排他的 claim**（workflow ID 一意性）: 同一 ID のワークフローは同時に 1 実行しか存在できない（エンジンが原子的に保証）。
2. **exactly-once activity / step checkpoint**: 副作用を持つステップ（activity/step）の完了結果を履歴に記録し、replay 時は再実行せず記録値を返す。完了記録は 1 回だが、**実行自体は retry で複数回走り得る（at-least-once 実行）**——ここは本節の対応表で正直に扱う。
3. **永続 timer**: プロセス再起動を跨いで発火が保証される sleep / cron（durable sleep・Schedules）。
4. **heartbeat / 生存監視**: 長時間 activity が定期 heartbeat を送り、途絶（heartbeat timeout）・超過（start-to-close timeout）をエンジンが検知して retry policy で自動再試行。
5. **実行履歴の永続化**: 何がいつ起き・何が返ったかの event history / checkpoint がエンジン DB に単独正本として残る。
6. **signal（外部入力の注入）**: 走行中ワークフローへ外部から入力を注入する口（Temporal: signal=非同期／update=同期・受理前 validate 可）。
7. **workflow versioning**: 走行中ワークフローは開始時のコード版で完走し、新規のみ新版で開始（Temporal Worker Versioning の pinned モード等）。

---

## 6.1 中心対応表 — durable execution の提供保証 ↔ 本系の事故クラス / 要件

PdM の問い「提供するもの（機能・保証）がどう関係するのか」への直接回答。各行 =「この保証を採用すると、どの事故クラス対策が**自前コードから primitive へ**移るか」。

| durable execution の保証 | 移る事故クラス / 要件 | 「自前コード → primitive」の内訳（1 行） | タグ |
|---|---|---|---|
| ① 排他的 claim（workflow ID 一意性） | **二重 dispatch / 二重生成**（事故クラス 1・M1） | 自前の claims テーブル DDL＋fs マーカー導出＋dedup guard（guard 後も再発した）が、「issue #N = workflow ID `task-N`、同時 open は 1 本」というエンジンの原子的 hard guarantee に置換。cross-machine 排他も同一エンジン配下なら自動 | 【事実】（保証は Temporal 公式明記）＋【critique B-1】保証は「**同時 open** 1 本」のみで、close 後の再 start は既定 Policy（Allow Duplicate）が止めない → **再開始判定の設計は自前に残る**（実装は消えるが設計は消えない） |
| ② exactly-once activity（step checkpoint・記録値 replay） | **終端保証**（事故クラス 3=transcript 死蔵・S1-3 fail-open 握りつぶし・M5）＋二重生成の残余 | 「書込失敗を非致命 continue で握りつぶす」自前 driver コードが、「activity 失敗は retry policy で自動再試行・最終失敗はワークフローへ返り compensate 分岐が必須になる」構造に置換＝**『失敗を無視して先へ進む』が書きにくい形**になる。stage 間の再開処理（自前 resume）も「完了 activity は replay で再実行されない」に置換 | 【事実】（機構は公式）＋【事実・正直な限界】activity **内部**は checkpoint されない: worker が agent run の途中で死ねば retry は stage 頭からやり直し＝**stage 内の冪等性（worktree リセット等）は自前責務のまま**。DBOS では step 書込と durability 記録が同一 Postgres トランザクションで commit＝トランザクショナル exactly-once（DBOS 公式 blog の主張・第三者検証は未実施） |
| ③ 永続 timer（durable sleep / Schedules） | **dispatch 遅延**（S3-1: 5 分設定に対し実測パス間隔 median 15 分・Ready→着手 p95 52 分。要件 R2/V2）＋silent death の補助 | 自前の launchd/systemd 5 分 cron ＋ pass 内同期実行（遅延の根因）が、エンジンの timer/schedule（プロセス再起動を跨いで発火保証・非 blocking 起動）に置換 | 【事実】（機構）＋【設計仮説】（V2: 反応遅延 p95≤15 分の充足手段としての採用）。注意: 永続 timer は 5 事故クラスの直接対策ではなく**効率要件（velocity）側**の対応物 |
| ④ heartbeat / 生存監視 | **silent death**（事故クラス 5・M2） | 自前 watchdog（起動記録×live marker×outcome の 3 点突合。plan 承認済み・**実装未**）の大半が、activity heartbeat（30 秒毎）＋heartbeat timeout（≤2.5 分）＋start-to-close timeout（90 分）＋自動 retry に置換。「信号ゼロの死」をエンジンが検知・再試行 | 【事実】（Temporal の機構は公式）＋【事実・限界】**マシンごと死・エンジンサービスごと死は検知不能**＝系外 heartbeat（GitHub Actions cron 等、系の外からの死活監視）はどの案でも自前に残る。**DBOS はここが急所**: 「プロセスが生きたまま hang」の検知が公式に明記されておらず【未確認】、採用時は自前 watchdog 併設が条件 |
| ⑤ 実行履歴の永続化（event history / PG checkpoint） | **transcript 死蔵**（事故クラス 3・M5 の回収経路）＋**I/O 構造化**（M4 の記録面）＋二重台帳の解消（M10） | 自前 manifest ファイル層（run/stage の試行記録。DB との二重データ層で drop 判定済み）が、エンジンの履歴＝「実行 telemetry の単独正本」に置換。activity 戻り値（構造化 envelope JSON）がそのまま履歴に永続記録され、「成果物が agent の transcript の中にしか無い」状態が構造的に起きにくくなる | 【事実】（機構）＋【設計仮説】（envelope を activity 戻り値に載せる設計）＋【設計・規律】エンジン履歴は lathe の transcript 観測とは**別物**＝重複投資にしない規律が要る。task 状態を workflow 内部変数に溜めると GitHub との二重台帳が再発 → 「実行状態はエンジン一次・人間入力のみ GitHub から読む」の方向規律とセット（6.5 節） |
| ⑥ signal（外部入力の注入） | **承認待ちの状態機械**（二重 dispatch の一種である「承認済みかの導出誤読」窓・統治面 M3 の一部） | 自前の「polling で GitHub 盤面を読み、承認済みかを毎回導出し直す」状態機械が、`await approval`（signal/update 待ち）1 行に置換。update なら受理前 validate（不正入力の拒否）も可能。承認の正本は GitHub ラベルのまま、検出役 activity がラベル→signal に変換 | 【事実】（機構＋Replit Agent が「update で人間同意を注入して agent 再開」の同型を production 実証・公式 case study）＋【未確認】承認者の本人性検証（GitHub timeline の labeled イベント actor 網羅性）は全案共通で未実測＝自前責務 |
| ⑦ workflow versioning（pinned） | **stale 常駐**（事故クラス 2・M7）＋**loop を loop で改修しない**（M11） | 自前の self-update 規律（パス冒頭 ff-only pull。不在で 5 commit 遅れの旧コードが走行した実弾あり）と「走行中 loop に改修を混ぜない」**運用**規律が、「走行中 workflow は開始時の版の worker で完走・新 task のみ新版」というエンジンの**機械強制**に置換。副産物として replay test（旧履歴×新コードの互換を機械検証）という新しい CI 資産 | 【事実】（Temporal Worker Versioning GA・公式）＋【事実・裏面】worker という**常駐プロセス自体の stale 化リスクが戻る**（自作案は使い捨て oneshot で構造排除する方針だった）。**DBOS には版固定の機械強制なし**＝プロセス再起動規律＋CI からの版付き deploy という運用担保に留まる |

**要約（機能ベースの結論）**【設計仮説・critique C-2 反映】: 5 事故クラスのうち、**二重 dispatch（①）・silent death の run/worker 死部分（④）・終端保証の骨組み（②）・stale 常駐（⑦・Temporal のみ機械強制）** が「自前コードで保証を書く」から「エンジンの primitive を使う」へ移る。**移らないもの** = 系外の死活監視（マシン/エンジン丸ごと死）・stage 内冪等性・再開始判定の設計・投稿物の内容検証（post-check）・承認者の本人性検証・権能分離（OS user 分離）・観測（transcript 主権）。throughput は論点にならない（実測数 task/日に対し、先行事例は 10M activities/日級＝容量は 2〜4 桁の余裕）。**選定は容量でなく「保証の置き場」と値札（運用・学習・新バグクラス）の交換**で決まる。

---

## 6.2 手作りしていた対応物の一覧 — 「知らずに durable execution を再発明していた」考古学

現行系（再構築対象）には、durable execution の各 primitive に対応する**手作り版**が既に存在し、それぞれ実測の欠陥を持つ。この対応が「エンジン導入 = 新規概念の輸入」ではなく「**既に必要だと判明した機構を、自前実装から既製の保証に置き換える**」ことを示す。

| 手作り部品（現行系・実在コード） | durable execution での対応 primitive | 手作り版の実測欠陥【事実】 |
|---|---|---|
| **manifest**（`.lathe/runs/` 配下の JSON。run/stage の試行記録。DB に二次コピーされ二重データ層） | **event history**（実行イベント史の永続化） | 二重データ層そのものが設計文書（ADR 0038）に名指しで問題視され drop 判定。evidence の GitHub 着地ラグが「未完了と誤読 → 再実行」の窓になる実測あり |
| **live marker**（fs 上の実行中マーカー。orchestrator が「実行中 skip」判定に使用） | **liveness / heartbeat**（生存の一次信号） | 実行中検出が worktree（作業ディレクトリ）有無のみで plan 段 task を見逃す欠陥を実測 → 二重 dispatch 実弾化の起点。fs マーカー由来の実行中導出は M1 で明示的に禁止対象 |
| **circuit breaker**（`outcomes.jsonl` ledger を fold し、連続 failure が閾値到達で dispatch 抑制。success でリセット・escalation は故障と数えない） | **supervision / retry policy**（失敗の集約と再試行統制） | 誤 open（止めるべきでない時に dispatch を止める）が実弾化し、PLAN_REVIEW の RED ループとの合わせ技で恒久対処 commit が必要になった（repo commit 履歴 5cb8679 に「RED ループと breaker 誤 open の恒久対処」と明記） |
| **resume**（`recordAttempt` が manifest に試行を書き、`decideResumeState` が再開位置を決める自前再開機構） | **replay**（完了 activity は再実行されない履歴再生） | recordAttempt は plan 段も記録するのに decideResumeState が IMPLEMENT 起点前提 → **plan 段を通った run の `--resume` が常に失敗**（issue #192）。「履歴を書く側と読む側の前提ずれ」という、replay をエンジンに任せれば型ごと消えるバグクラス |
| **dedup guard**（dispatch 重複防止の強化 commit `eca8247`） | **排他的 claim**（workflow ID 一意性） | guard 追加（07-07）の**翌日（07-08）に二重生成が再発**＝「発火の瞬間だけ塞ぐ」guard では危険窓（run 終了後の投影ラグ含む in-flight 全期間）を覆えないことが反証済み |
| **watchdog 3 点突合**（起動記録×live marker×outcome の突合。issue #281 の plan として PdM 承認済み・**実装未**） | **heartbeat timeout ＋ 生存監視** | 実装される前に code red 裁定。DBOS 採用時は（hang 検知未確認のため）この自前 watchdog の併設が採用条件として復活する【設計仮説】 |
| **launchd/systemd 5 分 cron ＋ pass 内同期実行**（orchestrator の駆動） | **永続 timer / Schedules** | 同期実行によりパス間隔 median 15 分・最大 51.9 分（設定 300 秒）・Ready→着手 p95 52 分（issue #256 実測） |
| **承認 polling**（GitHub Projects の Ready 列を毎パス読み直して承認を導出） | **signal / update**（外部入力の注入） | 状態の読み戻し（投影ラグ窓）が二重 dispatch の再発火条件の一部。盤面の内部 id 全再生成で検出が silent に停止した実弾もある（issue #201/#202） |

**この表の含意**【設計仮説】: 手作り版 8 部品はすべて「必要性が実弾事故で証明されたが、実装が壊れていた」もの。durable execution の採用とは、この 8 部品のうち上 6 行を**保証ごと**エンジンに移し、自前に残すのは「系外監視」と「承認の本人性・内容検証」だけにする、という機能の再配置である。逆に言えば、エンジンを採用しない場合はこの 8 部品を自前で正しく作り直す義務が残る（自作カーネル案の見積り: 新規 2.5〜3.5k 行）。

---

## 6.3 エンジン二択の機能差 — Temporal self-host vs DBOS Transact TS

候補は統合設計材料の時点で二択に収束している【設計仮説・PdM 裁定前】。ここでは PdM 指示に従い**機能差（提供する保証・運用の重さ・先行例）だけ**を並べる。価格・実装行数は §他節に譲る。

### 6.3.1 前提の定義【事実】

- **Temporal self-host**: OSS のワークフローエンジン。専用サーバー群（コンテナ 3〜4 個: server＋専用 Postgres＋管理 UI）を自分のマシンに常駐させ、アプリ側は「worker」プロセスがサーバーへ outbound 接続して仕事を受ける。ワークフローコードは**決定的**（乱数・時計・I/O 禁止）でなければならず、TypeScript SDK はこれを sandbox（Webpack バンドル・`Date.now` 差し替え等）で**機械強制**する。
- **DBOS Transact TS**: アプリ内ライブラリ（npm install するだけ）。**追加常駐物ゼロ**で、既存の Postgres（本系には稼働中の Postgres が既にある）に system database を同居させ、workflow/step 注釈だけで durable execution を得る。MIT license・1.3k★・企業バックあり・Temporal 比で採用実績は浅い。

### 6.3.2 機能差の対比表【事実ベース＋タグ付き】

| 機能軸 | 案 T: Temporal self-host | 案 D: DBOS Transact TS |
|---|---|---|
| **運用の重さ**（常駐・保守） | **三案中最重**【事実】: コンテナ 3〜4 個＋専用 Postgres が常駐純増。サーバー版上げに schema migration 手順。UI は無認証既定（ローカル bind 運用）。バックアップ対象 DB が 2 系統 | **三案中最軽**【事実】: 追加常駐ゼロ。既存 Postgres に論理 DB 追加のみ。版上げ = npm 更新 |
| **排他的 claim** | 同時 open 1 本は platform hard guarantee・cross-machine 自動【事実・公式】。close 後再 start は Policy 裁定＋再開始判定の設計が残る【critique B-1】 | workflow ID の exactly-once 起動＋Postgres 一意性。**自前の claim 台帳と同一 DB・同一トランザクション**で書けるのが固有の強み【事実・公式主張】 |
| **生存監視（hang 検知）** | **◎ activity heartbeat が platform 提供**（30 秒毎送信・timeout ≤2.5 分で V3=「silent death 検知 5 分以内」要件を充足）【事実・公式】 | **△ 急所**: crash 後の再開は PENDING scan で可（○）だが、「プロセスが生きたまま hang」の検知は公式に明記なし【未確認】→ 自前 watchdog 併設が採用条件【設計仮説】 |
| **版固定（stale 常駐対策・M7/M11）** | **◎ 機械強制**: pinned で走行中は旧版完走・新 task のみ新版。replay test（旧履歴×新コード互換の機械検証）が CI 資産として付いてくる【事実・公式 GA】 | **△ 運用担保のみ**: プロセス再起動規律＋CI からの版付き deploy。機械強制なし【事実】 |
| **決定性の強制** | TS SDK が sandbox で機械強制（「決定性はレビューで守る」でなく構造で守る）【事実・公式】。裏面: **non-determinism error という現行系に存在しない新バグクラス**と学習領域（目安 1〜2 週間【推測・実測なし】） | 決定性 sandbox なし＝新バグクラスの輸入も小さい。既知の道具（TS ライブラリ＋Postgres）の延長【事実】 |
| **履歴の置き場** | 専用 Postgres 内の event history（管理 UI で timeline・retry・signal 履歴を可視化） | 既存 Postgres 内の checkpoint。**「エンジンが観測（lathe ingest）schema へ直接書く」発展経路が既定で開く**（同一 DB 同居のため）【設計仮説】 |
| **LLM agent ループでの先行例** | **強い existence proof**【事実・一次情報】: OpenAI Codex（coding agent が Temporal 上で production・数百万リクエスト。内部構成は非公開＝設計参照は不可【未確認】）・Replit Agent（**agent session ごとに 1 workflow・workflow ID 一意性で「同時に 1 agent」・update で人間承認を注入**＝本設計と同型が production 実証・公式 case study）・Dust（10M+ activities/日）。公式 AI cookbook に agentic loop パターンが正典化 | 調査資料内に LLM agent ループの先行例の記載**なし**【未確認＝「無い」ではなく本調査で未発見】 |
| **両案共通の穴** | **「headless CLI（`claude -p`）を engine の activity/step として subprocess spawn する」公開先行例は両エンジンとも未発見**【未確認】。技術的障壁は特定されていないが、先行実装の裏取りが無い → 導入前 spike で自前 existence proof を取る計画 | 同左 |

### 6.3.3 交換の要約【設計仮説・敵対 critique C-2 反映済み。原文 verbatim】

> **交換の要約（C-2 反映）**: Temporal 固有の実利は 3 点に縮む——①M11 の機械強制＋replay test ②activity heartbeat による hang 検知（DBOS の急所を platform で埋める） ③保証実装の bus factor 緩和。**値札** = 常駐 1 式（podman 4 コンテナ＋PG 追加）＋non-determinism という新バグクラス＋学習 1〜2 週【推測・実測なし】。DBOS 側の同 3 点の自前コスト: ①CI deploy 規律＋再起動運用（機械強制なし） ②watchdog 純関数 5 個＋oneshot（#281 plan で PdM 承認済み・実装未） ③自前保証の bus factor 1 が残る。**throughput（V1/V5/V7）は三案とも余裕で満たし選定を弁別しない**。PdM 裁定「プロジェクト外のハーネスは必要ない」に形態が最も適合するのは app 内ライブラリ＋既存 PG（案 D）——ただしこの整合は形態論であり、保証の強度（②の未確認）と交換関係にある。

### 6.3.4 要件充足の三案比較表【事実＋設計評価・統合設計材料 §4 の原文 verbatim。◎=構造/platform 保証・○=自前コードで充足・△=条件付き・✗=未解決】

（routines 列は「実行を外部 SaaS platform に預ける」旧第三案の参考再掲。）

> | # | 要件 | 案 T: Temporal self-host | 案 D: DBOS＋自前 watchdog | 参考: routines（cloud/hybrid） |
> |---|---|---|---|---|
> | M1 | 二重実行の物理不可能化 | **○→◎条件付**: 同時 open 1 本は platform hard・cross-machine 自動。ただし Reuse Policy 既定は close 後再 start を許す（B-1）→ Policy 裁定＋再開始判定の engine 照会化で ◎ | **○**: workflow ID exactly-once 起動＋PG 一意性（claim と同一 DB・同一 Tx）。再開始判定の設計宿題は案 T と同じ | ○ DB claim 同設計。DB 到達 (d) 未確認・不達 no-op が silent |
> | M2 | silent death 検知 | **◎（run/worker 死）**: heartbeat 30 秒・timeout ≤2.5 分で V3 充足＋自動 retry。サービス/マシン丸ごと死は系外 heartbeat 必要（共通） | **△**: **hang 検知未確認（#281 直撃の急所）** → 自前 3 点突合 watchdog 併設が採用条件。crash 再開は PENDING scan で ○ | △ 系外監視なし・platform 相関故障（監視も同時沈黙） |
> | M3 | 権能分離 fail-closed | △ task queue 分離＋別 OS user。**existence proof 未取得（三案共通）** | △ プロセス分離＋別 OS user（同上） | ✗ 実行 identity (g) 仕様待ち・最重大未解決 |
> | M4 | I/O 構造化 | ○ activity 戻り値が history 永続（回収経路構造化） | ○ step 戻り値が PG checkpoint | △ envelope 回収経路が cloud-full で不存在 |
> | M5 | 終端契約＋補償 | ○ retry policy＋compensate 分岐が骨組み。post-check 自前 | ○ step retry＋durable 再開。post-check 自前 | △ M4 連動で未規定 |
> | M6 | spawn 単一モジュール | ○ 自前＋CI grep（三案同一） | ○ 同 | △ session 生成手段 (b) 未確認 |
> | M7 | 版固定＋self-update | **◎ pinned が機械強制**（走行中は旧版完走・replay test）。裏面: worker 常駐の stale 化が戻る（deploy 規律で緩和） | △ ライブラリ＝プロセス再起動で版切替（oneshot 化は durable 再開と両立させる設計次第）。外部 id 名前解決は自前（共通） | ◎ 毎発火 fresh checkout |
> | M8 | 環境正本化＋検収 4 点 | **✗→○ 三案中最重**: E クラス全残＋Temporal service 運用純増（podman 4 コンテナ・PG もう 1 系統・版上げ schema migration） | **○ 三案中最軽**: E クラス全残・**追加常駐ゼロ**・PG は既存 55433 | ◎/△ cloud で宿主消滅だが proxy 等の自前常駐 2〜3 新設で集計矛盾 |
> | M9 | 投稿物 post-check | ○ 三案同一の自前設計 | ○ 同 | ○ 同（M4 経路に連動） |
> | M10 | 状態は導出・二重台帳禁止 | ○ **修正後**: 人間入力のみ gh 読み・実行状態は engine 一次（E-1 解消） | ○ 同（PG 一次が最短） | ○ gh 導出維持＝投影 lag 窓の S1-2 残余あり |
> | M11 | loop を loop で改修しない | **◎ 三案中最強**: repo コード＋PR+CI に加え pinned が走行中混入を機械禁止 | ○ repo コード＋PR+CI（機械強制なし・運用規律） | △ routine 定義・cron 変更がゲート外 |
> | M12 | 外部契約 contract test | ○ 共通＋Temporal 契約は SDK 型と replay test が肩代わり | ○ 共通＋DBOS 契約面は npm ライブラリ（薄い） | ○ 共通 |
> | M13 | CI 検証資産全量 | ○ 共通＋**replay test という新資産** | ○ 共通 | ○ 共通 |

---

## 6.4 「軽い代替＋自前薄層」に戻る場合、何が自前に残るか

エンジン二択の外側に「Postgres ネイティブの job queue（pg-boss / graphile-worker 等の成熟ライブラリ）＋自前の薄い層」という更に軽い選択肢がある。調査結果【事実】: **「キュー」は買えるが「durable execution」は買えない**。

### 6.4.1 買える部分【事実】

SKIP LOCKED による安全な job 取り出し・retry/backoff・cron・遅延 job・DLQ（dead letter queue）・LISTEN/NOTIFY 低遅延（<3ms）。既存 Postgres にそのまま乗り、常駐物ゼロ、TypeScript 親和も最高。queue としての実績は 2010 年代後半からと長い。

### 6.4.2 自前に戻る部分【事実・調査資料の原文 verbatim】

> **自作に戻る部分（正直に）**: durable execution 級に必要な「step 単位 checkpoint と再開」「途中結果の journal と決定的 replay」「durable timer（週単位 sleep）」「workflow 履歴のモデル」は queue の上に**自分で設計・実装**することになる。想定事故クラス: 非冪等 step の二重実行（at-least-once ＋自前 checkpoint の隙間）・checkpoint スキーマの migration 事故・「job は成功したが workflow 状態の更新に失敗」の分裂・自前 replay の determinism バグ。これは lathe が避けたい「自作 harness の保守」がそのまま戻る構図。

6.1 の対応表に写像すると【設計仮説】: 軽い代替で primitive 化できるのは **③永続 timer（部分: cron/遅延 job まで。週単位 durable sleep は不可）** のみ。**①排他 claim・②exactly-once step・④生存監視・⑤履歴・⑥signal・⑦versioning はすべて自前に残る**＝6.2 の手作り 8 部品のうち 7 部品を正しく作り直す義務が戻る。しかも queue の実行保証は at-least-once（worker crash 時に再配送）であり、自前 checkpoint との隙間が**二重実行（事故クラス 1 の同型）を再輸入**する。

付随事実【事実】: この「薄層を自作した人」の existence proof は存在する（pg-boss 上に durable execution を実装した個人 repo）が、その作者自身が docs で「大規模用途には Temporal/Inngest/DBOS 等を推奨」している。また pg-boss は実質単独メンテ（bus factor 低）。

### 6.4.3 参考: 軽量代替の全候補比較表【事実・調査資料の原文 verbatim】

> | 候補 | 形態 | 保証（exactly-once / timer / heartbeat / 履歴） | 常駐物の増加 | 既存 PG 55433 活用 | TS/Node 親和 | 成熟度・license |
> |---|---|---|---|---|---|---|
> | **DBOS Transact TS** | app 内ライブラリ | step checkpoint で再開・イベント起点 workflow の exactly-once 起動・durable sleep（週単位可）・履歴は PG 内＋API で照会可。**heartbeat 明記なし**（単一ノードは起動時 PENDING scan で回復。分散回復は Conductor(SaaS) か手動※要注意） | **0**（app + PG のみ） | ◎ system database として同居可（1 物理 PG に複数論理 DB） | ◎ npm `@dbos-inc/dbos-sdk`・TS first | MIT・1.3k★・v4.23 (2026-06-30)・DBOS Inc.（企業バック） |
> | **Restate** | 独自 server（Rust 単一バイナリ） | journal ベース durable execution・**通信 exactly-once semantics**・durable timers/promises・K/V state。fsync 済み単一ノードでも耐久 | **+1**（restate-server。DB 追加不要） | ✗ 独自埋め込みストレージ（log+state 同居）。PG 資産は使わない | ○ 公式 sdk-typescript あり。ただし「Restate のサービスモデル」への書き換えが要る | **BSL 1.1**（内部利用・self-host は明示的に許可、4 年後 Apache-2.0）・4.1k★・v1.7.2 (2026-07-06)・元 Flink 創設者ら |
> | **Inngest（self-host）** | 独自 server（単一バイナリ、HTTP で app を起動） | step 単位の永続化＋step 単位 retry・sleep（日単位）・イベント待ち。app 側 worker 常駐不要（HTTP 呼び出しモデル） | **+1**（inngest server。SQLite 内蔵 or 外部 PG/Redis） | △ 永続化先に自前 PG を指定可（`postgres-uri`）。ただし本番マルチノードは PG+Redis 両方要 | ◎ TS SDK が主力 | **SSPL + DOSP(遅延 Apache-2.0)**・self-host は公式サポート対象外（DB 自動 cleanup なし等の注記あり）・signing key 必須 (2026-02〜) |
> | **pg-boss** | app 内ライブラリ（queue） | 「exactly-once **delivery**」（SKIP LOCKED）＝実行は実質 at-least-once・retry/backoff・cron・遅延 job・DLQ。**workflow の step 再開・履歴 replay は無い**（job dependency orchestration どまり） | 0 | ◎ そのまま乗る（PG 13+） | ◎ TS 96.8% | MIT・3.7k★・12.25.1 (2026-07)・**実質単独メンテ（timgit）＝bus factor 低** |
> | **graphile-worker** | app 内ライブラリ（queue） | at-least-once・retry 25 回/約 3 日・crontab・LISTEN/NOTIFY で低遅延 (<3ms)。durable execution（step checkpoint）は無い。crash 時 lock 回復のタイムアウト値は**未確認** | 0 | ◎ そのまま乗る | ◎ TS 主体 | MIT・2.3k★・クラウドファンド型（Benjie 中心）＝bus factor 中 |
> | **River** | Go ライブラリ | transactional enqueue・retry・cron・step 型 workflow あり | 0（ただし Go worker プロセス） | ◎ | **✗ worker は Go 専用**（enqueue のみ Python/Ruby 対応。Node 非対応） | MPL-2.0・5.4k★・v0.40.0 (2026-07-02) |
> | **Absurd**（調査中に発見） | PG 内（PLpgSQL）＋薄い SDK | Postgres だけで durable execution（step checkpoint・retry・スケジュール・event 待ち・exactly-once semantics を標榜） | 0 | ◎ PG のみで完結 | ○ TS SDK あり（Python/Go も） | Apache-2.0・2.2k★・**0.4.0 (2026-05) = pre-1.0**・「AI 支援で構築」と明記・本番実績主張なし |

（PG 55433 = 本系で既に稼働している Postgres インスタンスのポート。Restate/Inngest は「常駐＋1」の時点で、Absurd/pg_durable（Microsoft の PG 拡張）は成熟度で、River は言語不適合で、それぞれ二択から外れている【事実・調査時の適合順位】。）

### 6.4.4 どのエンジンを選んでも自前に残るもの（エンジンでは買えない機能）【設計仮説・全案共通】

1. **系外の死活監視**: マシン丸ごと・エンジンサービス丸ごとの死は、系の内側からは検知できない（監視も同時に沈黙する相関故障）。GitHub Actions cron 等、系の外に置く heartbeat 監視は全案で自前。
2. **stage 内の冪等性**: activity/step の途中死は「stage 頭からやり直し」になるため、worktree リセット等の再実行安全化は自前。
3. **再開始判定の設計**: 「同時 open 1 本」保証は close 後の再 start を止めない。「この task をもう一度走らせてよいか」の判定ロジックは自前設計（エンジン履歴 or 台帳への照会）。
4. **権能分離（M3）**: agent 実行体に GitHub 書込 credential を持たせない構造（OS user 分離＋書込専用プロセス）。エンジンは routing（どの仕事をどの worker に渡すか）を提供するだけで、分離の実体は OS 設計。existence proof 未取得【未確認・全案共通】。
5. **投稿物の内容検証（M9 post-check）**: 「投稿が実在する・stub でない・対象と整合する」の機械照合。エンジンは「投稿 activity が成功した」ことしか知らない。
6. **承認者の本人性検証**: 承認ラベルを付けたのが許可された人間かの検証（GitHub timeline actor の網羅性は未確認【未確認】）。
7. **I/O の schema 設計（M4 の中身）**: envelope JSON の schema・agent が schema 通り出力するかの検証と bounded retry（headless CLI の schema 強制出力可否は未確認【未確認・全案共通】）。
8. **エンジン非依存の keep 資産**: spawn 単一モジュール・posting 台帳＋post-check・contracts データ（plan 契約 6 節等）・rubric（機械検査規範）48 本・escalation triage 純関数・GitHub API 癖台帳。これらはどの案でも同じ場所に載る＝裁定前の先行着手が無駄にならない【設計仮説】。

---

## 6.5 GitHub 再設計の要約 — 速い面／遅い面の分離と durable execution の関係

### 6.5.1 分離の原理【設計仮説・敵対 critique E-1 反映済み】

再設計の中核は**面の分割**:

- **速い面**（実行状態・排他・再実行判定）= durable execution エンジンの DB が**一次所有**。機械が読み書きする状態はすべてここ。
- **遅い面**（人間の入力・読み物・着地）= GitHub に**限定**。残る役割は (a) 起票面（issue 作成・採番）、(b) 承認・裁定の入力面（承認ラベル/盤面・裁定 comment）、(c) 読む面（人間向け投影・恒久記録）、(d) PR+CI の単一着地ゲート（コードが main に入る唯一の経路）。
- **方向規律**: **機械は GitHub から「状態」を読み戻さない**。GitHub から読むのは人間の入力（新規 issue・承認ラベル・裁定 comment）のみ。GitHub 上の状態表示は engine からの一方向投影（台帳＋キャッシュ）に格下げ。

### 6.5.2 なぜこの分離が事故クラスに効くか【設計仮説・実測根拠は事実】

旧系は「GitHub への evidence 書込 → GitHub から状態を導出 → 導出結果で dispatch 判定」という**往復**を機械の判定経路に置いていた。GitHub は結果整合的（書込の着地ラグがある）・書込は fail-open（失敗しても系が止まらず握りつぶされる）・API 契約は不安定（内部 id の silent 再生成等）であり、この往復こそが二重 dispatch の再発火条件（着地ラグ×毎 5 分パス）と永久待機（fail-open 書込→誤導出）の実測根因だった【事実】。速い面をエンジン一次に移すと、**GitHub の結果整合性が機械の判定経路から外れる**＝保証を要求されない面に退く。これが「durable execution が GitHub 再設計を可能にする」関係の機能的核心: **エンジンが①排他・⑤履歴・③timer・④生存監視の正本を引き受けるから、GitHub は正本業務から解放できる**。

### 6.5.3 遅い面の確定方向（要点のみ）【設計仮説・裁定前】

- **着地**: 1 task 1 PR を維持（複数 task の batch 着地は棄却——rework 混入確率 89〜97% の試算・事故の再輸入。PR を経ない direct-to-main は過去事故の制度化として棄却）。強化: branch 最新化の機械強制（strict モード）＋エンジンによる直列 arm＋main への push 時 CI。**寿命条件**【critique E-2】: 現在の「CI 51 秒」前提の数字であり、検証資産全量搭載（M13）後に CI が 10 分級になれば直列 arm は再設計。
- **承認入力**: 現行の盤面列 drag（Ready 列）から `gov:approve` ラベルへの変更が候補優位（actor の機械検証がしやすい）。ただし**未確認×未確認の比較**【critique D-1】＝両方式とも actor 取得可否・PdM 操作性が未実測であり、実測＋移行ハザード対策（ラベル忘れで統治が silent 停止する窓）を裁定条件とする。durable execution 側では、どちらの入力面でも「検出 activity → workflow への signal/update 注入」に正規化される（6.1 表⑥）。
- **教材配信**: 承認材料（plan の教材化文書）は「承認が起きる場所」へ一次配信し、投稿直後に post-check（実在・非 stub・整合）。GitHub Discussion は放送・アーカイブ面に格下げ（存廃は裁定待ち）。旧系では `@file` 未展開の 59〜64 字の壊れた stub が承認材料として盤面に載った実弾がある【事実】。

### 6.5.4 残余（分離しても消えないもの）【設計仮説・隠さない】

- 人間が GitHub 投影を読んで誤解する余地（投影 stale）は残る——ただし機械の判定には接続しないため事故クラス 1 には戻らない。緩和: 台帳⇄GitHub の毎パス突合＋生成時刻の刻印。
- 移行窓（旧系と新系の併走期間）の二重 dispatch は、新系内のテストでは検証できない切替時運用リスクとして残置【critique・両検証者共通指摘】。
- V1（日次 10〜20 PR 着地）という velocity 目標自体の錨が一次出典なし【未接地】であり、人間の承認読解時間（1〜数時間/日）が成立しない場合、エンジン投資は「拘束されていない制約の最適化」になる【critique A-1/A-3】——durable execution の採否とは独立に、要件の根の照合が先行する。

---

## 6.6 本節の結論（機能ベースの一枚絵）

【設計仮説・PdM 裁定前】durable execution は本系にとって「新しい能力の追加」ではなく、**実弾事故で必要性が証明済みの 8 つの手作り機構（manifest・live marker・breaker・resume・dedup guard・watchdog・cron 駆動・承認 polling）を、保証ごと既製 primitive に置き換える再配置**である。置き換えの対応は: 排他 claim→二重 dispatch（M1）／heartbeat→silent death（M2）／exactly-once step＋履歴→終端保証と transcript 死蔵（M5・M4）／versioning→stale 常駐と loop 自己改修（M7・M11）／signal→承認注入／永続 timer→dispatch 遅延（R2）。移らないのは系外監視・stage 内冪等性・再開始判定・権能分離・投稿検証・承認者検証で、これらは全案共通の自前責務。エンジン二択の機能差は「hang 検知と版固定の機械強制（Temporal ◎）」対「運用の軽さと既存 Postgres 同居（DBOS ◎）」の交換に縮約され、throughput は弁別しない。軽い代替（PG queue＋薄層)へ戻ると 7/8 部品の自作義務が復活し「自作 harness の保守」構図が再輸入される。GitHub 再設計はこの再配置の系: エンジンが状態の正本を引き受けることで、GitHub を「人間の入力と着地ゲート」だけの遅い面に限定でき、結果整合性・fail-open 書込・契約不安定という GitHub 固有の弱点が機械の判定経路から外れる。

**未確認の筆頭（本節スコープ）**: headless CLI spawn の engine 内先行例（両エンジンとも未発見・spike で自前実証予定）／DBOS の hang 検知／OS user 分離の existence proof／承認 actor の網羅性／V1 錨の PdM 本人照合。
