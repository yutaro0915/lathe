# 基盤裁定資料（最終比較・判定なし）

- 作成: 2026-07-08／read-only。読者: PdM。
- 入力: `routines-foundation-design-v0.md`・`self-built-foundation-design-v0.md`・`critique-routines.md`・`critique-self-built.md`・`code-red-charter-material.md`（すべて本 scratchpad）。
- 記法: 事実（一次証拠・実測）／critique の主張（設計側未応答）／**未確認** を峻別。本書は判定を書かない（§5 決定木のみ）。

---

## 1. 両案 1 枚図（同解像度）

層構成を揃えて併記。**太字**＝両案の差が出る層。

### routines 案・基線（cloud 全面／判定 B）

```
正本    GitHub: issue=task・PR+CI 単一着地ゲート（両案共通・ADR 0031/0026）
発火    cloud routines cron（cadence 5 分）… platform 管理＝宿主なし
排他    managed Postgres claim INSERT（ON CONFLICT DO NOTHING = 実行権）
実行    cloud session（fresh checkout・注入 prompt）… 環境差 E クラス消滅
書込    posting proxy（決定的 render＋post-check＋台帳）
        ※critique A-3: proxy/watchdog の実行基盤が cloud 上で規定されていない
監視    watchdog routine（3 点突合・補償）… 系外監視なし（critique B-1）
観測    OTel export → collector → lathe ingest ＝**劣化形（判定 B）**
        tool span/token/cost のみ・message history 不可・遡及不可
M3      **未解決（採用可否を左右）**: 実行 identity (g)・secret 注入 (d) が platform 仕様待ち
```

### 自作案・基線（case 単独・ローカル Postgres）

```
正本    GitHub: issue=task・PR+CI 単一着地ゲート（両案共通）
発火    systemd timer → dispatcher oneshot（常駐なし・ff-only self-update→re-exec）
排他    ローカル Postgres claim INSERT（同一 DDL・cross-machine は DB 単一化が条件）
実行    claude -p headless ローカル spawn（単一モジュール・env strip・worktree 隔離）
        … 環境差 E クラス＝**自前恒久負担**（systemd/認証/依存の repo 正本化）
書込    posting proxy（別 OS user＋LoadCredential・唯一の gh credential）
監視    watchdog oneshot ＋ **系外 heartbeat（GitHub Actions cron）**
観測    local JSONL 100% → lathe ingest（providers 変更ゼロ）＝**無劣化**
M3      構造で建つ設計・ただし OS user 分離の existence proof **未取得**（Step 0-i）
```

### routines 案・縮退形（hybrid: 統治=cloud・実行=ローカル runner）

両 critique が独立に「実質の比較対象」と指摘する第三形。観測＝local JSONL 無劣化（自作と同等）・排他＝同一 DB claim・**代償**＝E クラスと宿主 silent death が戻る（＝自作と同じ負担）＋統治面だけ platform 依存が残る。

---

## 2. 機能面の比較表（M1〜M13）

「充足」は各設計 v0 の自己申告に critique の未応答指摘を重ねた現時点評価。◎=構造保証／○=自前コード／△=条件付き／✗=未解決。

| # | 要件 | routines での充足 | 自作での充足 | どちらも未解決 |
|---|---|---|---|---|
| M1 | 二重実行の物理不可能化 | ○ DB claim（同一設計）。ただし DB 到達 (d) **未確認**。DB 不達→全 no-op が silent（critique B-2） | ◎ 同一 DDL・ローカル到達。cross-machine は DB 単一化が条件 | 移行期間中は旧 fs 排他×新 DB 排他が非共有＝S1-2 再発窓（自作 critique D-2。routines も同型） |
| M2 | silent death 検知常設 | △ watchdog 3 点突合。**系外監視なし**・platform 障害で監視側も同時沈黙（critique B-1） | ○ watchdog＋Actions cron 系外 heartbeat。マシン死の検知 SLO は Actions 遅延**未実測** | 「死因を語る証拠」: routines は最終 batch 未 flush で永久消失（critique C-2）・自作は JSONL 残存 |
| M3 | 権能分離 fail-closed | **✗ 最重大未解決**。(g)=本人身元なら actor 検証が汚染を正規化（critique D-1）・Step 1〜3 が分離なし実弾（D-2） | △ 構造設計あり。OS user 分離＋LoadCredential の existence proof **未取得**（不成立なら準構造に格下げ＝critique E-2） | credential 種別（GitHub App vs machine user PAT）の裁定は両案共通 |
| M4 | I/O 構造化（envelope） | △ **envelope の回収経路が cloud-full で不存在**（critique A-1: 最終メッセージは API 取得不可・設計内部矛盾） | ○ ローカル spawn の stdout JSON＝回収経路が自明。unparsable retry は keep 転用 | CC headless の schema 強制出力可否（**未確認**・両案共通の強度差要因） |
| M5 | 終端契約＋書込補償 | △ 設計あり。ただし M4 の envelope 受理が前提＝A-1 に連動 | ○ 台帳＋watchdog 補償（S1-3 #229 封じ） | — |
| M6 | spawn 単一モジュール | △ dispatcher→session 生成手段 (b) **未確認**・spike 項目に漏れ（critique A-2） | ○ backends.mjs 改造転用＋CI grep 検査 | — |
| M7 | 版固定＋self-update | ◎ 毎発火 fresh checkout（platform） | ◎ oneshot＝常駐なし＋ff-only re-exec | 外部 id の毎パス名前解決は両案自前 |
| M8 | 環境 repo 正本化＋検収 4 点 | ◎ cloud spec 化で宿主消滅——**ただし proxy/collector/DB 監視の自前常駐 2〜3 個が新設され集計と矛盾**（critique A-3） | ✗→○ **自前恒久負担**として全部残る＋unit 新規書き直し＝E1 級を踏み直す位置（critique B-1'）。self-check は未着手コード | 検収 4 点の適用実績なし（基準のみ PdM 承認済み） |
| M9 | 投稿物 post-check | ○ 設計同一。M4 経路に連動 | ○ 設計同一＋intent_sha256 冪等 | — |
| M10 | 状態は導出・二重台帳禁止 | ○ gh 導出維持＋claim/ledger は telemetry 単独正本 | ○ 同一（derive.mjs コード参考 keep） | — |
| M11 | loop を loop で改修しない | △ **routine 定義・cron 変更だけゲート外**。(b)(g) 成立時は inner が loop を書き換える経路が広がる（critique D-3） | ◎ 全部 repo コード＝PR+CI 内。install 実行のみ運用残余 | — |
| M12 | 外部契約 contract test | ○ watchdog 毎時＋CI | ○ 同一＋gh 癖台帳 Q1〜Q7 の test 化 | 第 1 号 timeline `labeled` actor 網羅性は**未確認**（承認検証の前提） |
| M13 | CI 検証資産全量 | ○ 基盤非依存（#279 解消） | ○ 同一＋カーネル自身のテスト | 両案とも「これから書く」——書くのは同一人物（自作 critique C-1 の自己参照問題は程度差で両案に掛かる） |

### R1〜R8 の差分のみ

| # | 差が出る点 |
|---|---|
| R1 注入契約 | 両案自前・同設計。routines は fire payload に注入を渡せるか**未確認**（critique A-2、劣化すると fail-closed が「起動後自殺」に落ちる） |
| R2 非同期 dispatch | 自作=timer 設計値保証（構造）／routines=cadence 下限・(a) イベント trigger **未確認**＋dispatch 用 LLM session 288 本/日の quota 未見積（critique C-3） |
| R5 backend 抽象 | **自作=維持（backends.mjs 転用・codex A/B 資産温存）／routines=縮退（Claude 固定の公算）**。hybrid なら維持 |
| R3/R4/R6/R7/R8 | 両案同一（contracts データ・乱択 render・triage 移植・plan schema・gov:p ラベル） |

### 両案共通で「どちらを選んでも建てるもの」（裁定不要・先行着手可能な共通部品）

claim DDL＋dedup／posting 台帳＋post-check 5 項目／envelope schema 群／contracts データ（plan.schema・explain 2 段・watchdog-checks）／label 語彙 `gov:*`/`run:*`／escalation triage 移植／M13 CI 全量。両設計 §4 は routine/loop 定義・skill 構成・label 語彙を**基盤非依存の共通正本**として既に共有している。

---

## 3. 戦略軸の比較（機能表とは独立）

| 軸 | routines（cloud 基線） | 自作（最小カーネル） |
|---|---|---|
| ① **保証の所有権**（壊れた時に自分で直せるか） | 発火・環境・版管理・実行 identity は platform 内＝**壊れても自分では直せない**（(c)(d)(g) の挙動変更に事後追随）。dedup・補償・post-check は自前＝直せる | 全層が自 repo コード＋systemd＝**全部自分で直せる。裏返しに全部自分でしか直らない**（bus factor 1・セキュリティ境界 proxy 含む。critique C-1/C-2） |
| ② **依存の非対称性** | GitHub（正本・承認・着地）＋Anthropic（発火・実行・観測経路）の**二枚依存**。どちらの仕様変更も系を止めうる・交渉力なし | GitHub 一枚＋自前保守。Anthropic 依存は「headless CLI の JSON 出力」1 点に縮小（backend 抽象で codex へ逃げ道あり）。代わりに保守が監査役個人に非対称集中 |
| ③ **観測の主権**（lathe の存在条件） | 判定 B＝durable log→best-effort stream への**質の変更**。今日の meta-audit 2 本との照合（critique E）: 効率監査の中核所見（再読 3.0/session・bash 37% 探索・Stop hook 二重課金の発見）は**判定 B では一つも導出できなかった**＝実測済みの事実。lathe が自分を dogfood できない製品になる | local JSONL 100%・ingest 変更ゼロ・**観測が今日と同じ深さで続く**。「自作 runtime が ingest schema へ直接書く」（D4-b・観測=正本）への発展経路もこちら側にのみ開く |
| ④ **製品戦略**（lathe は駆動を所有するか） | lathe＝**統治と観測に徹する製品**。駆動（loop 実行）は外部化し、契約（contracts・rubric・検収）だけを所有。駆動の改善知見は platform に帰属 | lathe＝**駆動を所有する製品**。loop 実行そのものが観測対象かつ改善対象＝「既存 agent の観測・改善・評価」（AGENTS.md）を自系で閉じる。代償: 駆動コードの増殖動力が残る（現行系 32 日 0→7k 行の実測・critique A-2'） |
| ⑤ **可逆性**（乗り換え・撤退の経路） | 撤退＝自前実行系の再構築（hybrid に落ちれば実行面は可逆・統治面の platform 依存は残る）。R5 縮退で codex A/B 資産を失うと復元コスト増 | 乗り換え＝spawn モジュール 1 点差し替え（CC→codex→pi→API 直・ADR 0014 維持）。**routines への後乗り換えも「dispatcher の発火面だけ platform 化」で可能**＝共通部品（§2 末尾）が両世界で使い回せる |

補足（軸①②に掛かる非対称・事実）: routines 案の未確認 (b)(d)(e)(g) は**自分では潰せず platform 仕様の実測でしか閉じない**。自作案の未確認（OS user 分離・Actions 遅延）は**自分の環境で 1〜2 日の spike で閉じる**。不確実性の「所有権」も非対称。

---

## 4. 両 critique の要点（対称・各 5 点）

### critique-routines（自作側からの攻撃）

1. **A-1 設計内部矛盾**: cloud session の最終メッセージを回収する確認済み経路がゼロ（retrieval API は transcript 取得不可・stream は常駐要）。M4/M5/M9 の 3 層保証が起点から未規定。**Step 0 の spike 項目にも入っていない**。
2. **A-2/A-3 「cloud 全面」の自壊**: dispatcher の spawn 手段 (b) が spike から漏れ、proxy・watchdog・OTel collector は cloud 上に置けない（LLM なし routine は存在できない）＝自前常駐 2〜3 個を新設しながら「platform が宿主を消す」と集計。
3. **B 相関故障**: dispatcher と watchdog が同一 platform・同一 DB 到達 (d) の上＝両者同時沈黙を報じる者が系内にいない。DB 不達 fail-closed は「全パス no-op」という最も検知しにくい停止形態を新設。
4. **D M3 の帰結は自己申告より重い**: (g)=本人身元なら actor 検証が bot の暴走 approve を「人間の承認」として通す（防御の反転）。Step 1〜3 は権能分離なしの実弾運転で、順序が自作案（Step 0 で existence proof 先行）と逆。
5. **E 判定 B の実証的棄却**: 今日の meta-audit 2 本を判定 B の観測で再現照合→効率監査はほぼ全滅。「劣化の受容」は開いた裁定ではなく、B 単独では要件を満たさないことが scratchpad 内の証拠で閉じている、と主張。

### critique-self-built（routines 側からの攻撃）

1. **A 「小さなカーネル」は会計境界の産物**: 2.5–3.5k 行に contracts 群・ops/ unit 群・install self-check・migration・テスト 6.2k 行超が入っていない。現行系は同じ人・同じ規律で **32 日 0→7,015 行**（機械計測）＝増殖を止める新機構は本案にない。driver 65〜76% 削減は未実測の楽観。
2. **B 常駐負荷の過小計上＋相関故障**: unit を新規に書き直す＝E1 級設定事故を踏み直す位置。Postgres が M1/M2 両方の単一依存点なのに運用工数が無計上。監視系が被監視系と同じマシン・同じ DB に立ち、最後の砦 Actions cron は best-effort＋60 日無活動で自動無効化仕様（本 repo 照合は**未確認**）。
3. **C bus factor 1**: 唯一の write credential を持つ proxy（新規 400–600 行）の設計・実装・テスト・レビューが全部同一人物＝自己参照的保証。#279「ザル」は同じ体制・同じ理念の下で起きた。lathe 開発再開後、最初に腐るのが自前カーネル（S2-1 は「係が不在」で起きた実績）。
4. **D 移行窓と恒久残余**: Step 1〜5 は旧 fs 排他×新 DB 排他が非共有＝S1-2 再発窓を内蔵したまま実 issue で PoC。E2 類（ローカル認証・課金経路未照合）は自作固有の恒久残余。
5. **E 比較枠の歪み**: 自作の 2 大優位のうち transcript 主権は **routines hybrid が完全に中和**し、M3 は Step 0 未実測の条件付き。「自作 vs cloud 全面」で比較枠を切った時点で結論が半分決まっており、裁定は「自作 vs hybrid」行と Step 0 実測を揃えてから。

### 両 critique が独立に一致する点（構図の事実）

- 実質の比較は「**自作 vs routines-hybrid**」であり、cloud 全面基線はどちらの critique からも支持されていない。
- hybrid に落とすと観測は両案同等（無劣化）になり、**残る差分は「統治・発火面を platform に置くか自前に置くか」＋「E クラス負担の所在」だけ**に縮む。
- dedup・proxy・post-check・envelope・contracts は両案共通の自前部品＝どちらの裁定でも無駄にならない。

---

## 5. 裁定の分解（決定木——判定は書かない）

この裁定は 1 つの選択ではなく、以下の順序の決定の束。上位が決まると下位の選択肢が絞られる。

```
D-0. 製品戦略（軸④）: lathe は駆動を所有する製品か、駆動を外部化し統治と観測に徹する製品か
│    ※最上位に置く根拠: この選択だけが他の全軸（保証所有権・依存・観測・可逆性）の重み付けを決める
│
├─「駆動を所有する」──────────────────────────────┐
│   D-1a. M3 実現手段: OS user 分離＋LoadCredential の existence proof（Step 0-i）│
│   │      成立 → 構造の M3。不成立 → 同一 user＋運用規律（routines の未解決と同格）│
│   │              に落ちることを受容するか、ここで撤退するか                     │
│   D-1b. 恒久保守の受容: E クラス管理・DB 運用・外部仕様追随・bus factor 1       │
│   │      （critique-self-built B/C。一時費用でなく恒久費用として裁定）           │
│   D-1c. DB 置き場: lathe Postgres 同居（観測=正本方向と整合）or 専用（境界優先） │
│   D-1d. 系外監視の経路: Actions cron（遅延・60 日仕様の実測後）or 代替           │
│   D-1e. 移行窓の閉じ方: PoC issue の旧系からの隔離手順（gov:hold・旧 timer 停止）│
│
├─「駆動を外部化する」────────────────────────────┐
│   D-2a. 観測劣化（判定 B）の受容 ※実測材料あり: 今日の meta-audit 照合で        │
│   │      効率監査は B で再現不能（critique E）。受容しない → hybrid 強制         │
│   │      → hybrid なら E クラス負担が戻り、対自作の差分は統治面のみに縮む        │
│   D-2b. M3: platform 仕様 (d)(g) の実測結果待ち。 (g)=本人身元なら              │
│   │      承認検証が成立しない（critique D-1）→ 採用可否ごと再裁定                │
│   D-2c. envelope 回収経路の設計し直し（critique A-1。仕様確認以前の設計課題）    │
│   D-2d. R5 縮退の受容: codex A/B 資産を失うか、dispatcher に抽象を自前保持か     │
│
└─ どちらでも共通に決めるもの（基盤選定と独立）
    D-3a. 承認面の正: gov:approve label（actor 検証つき）or Projects Ready 列継続
    D-3b. credential 種別: GitHub App or machine user PAT
    D-3c. 基盤の置き場（D3）: lathe repo 内（ADR 0038 packages）or 別 repo
           ※「プロジェクト外のハーネスは必要ない」裁定（2026-07-08）との整合
    D-3d. 共通部品（§2 末尾）の先行着手可否: 裁定前でも無駄にならない集合
    D-3e. Step 0 spike の実施承認（§6 の順で。両案並走 1〜2 日・相互に排他でない）
```

順序に関する両案・両 critique の一致点: **Step 0 spike が最も安い不確実性削減であり、D-0 の裁定材料（M3 成立可否・観測経路の実態）自体を spike が供給する**。D-0 を先に直感で決めることも、spike 結果を見てから決めることも可能——後者を選ぶ場合、§6 の 1〜4 が判明するまで D-0 を仮置きにできる。

---

## 6. 未確認事項の統合リスト（Step 0 spike で潰すべき順）

順序基準: 採用可否を左右するもの → 設計の骨格を決めるもの → 周辺。[R]=routines に効く／[S]=自作に効く／[共]=両案。

| # | 未確認事項 | 効く先 | 潰し方／判明した時の分岐 |
|---|---|---|---|
| 1 | **(g) routines 実行 identity**（本人身元か否か） | [R] 採用可否 | platform 実測。本人身元なら M3・承認検証が自壊（critique D-1）→ R 案は hybrid 込みで再設計 |
| 2 | **(d) secret 注入・cloud→DB 到達** | [R] 採用可否 | 不成立なら claim 排他が建たない＝R 案中止の裁定材料 |
| 3 | **OS user 分離＋LoadCredential の existence proof**（agent が repo を書けて token を読めない） | [S] 採用可否 | case 上で 1 日 spike。不成立なら S 案 M3 は準構造に後退＝受容裁定へ |
| 4 | **envelope 回収経路**（cloud session の最終出力を proxy がどう受けるか） | [R] 設計成立 | critique A-1 指摘・**現 Step 0 リストに無い→追加必須**。session 自身が DB へ書く形なら §4.3 全面書き直し |
| 5 | **(b) 動的 session 生成／dispatcher の spawn 手段**＋fire payload への注入可否 | [R] 設計成立 | critique A-2 指摘・spike 漏れ→追加必須。注入不可なら R1 fail-closed が劣化 |
| 6 | **(e) env/settings 注入＝OTel の cloud 有効化可否** | [R] D4 前提 | 不成立なら判定 B すら成立せず実質 C＝hybrid 強制 |
| 7 | **CC headless の schema 強制出力可否** | [共] M4 強度 | 不成立でも bounded retry で運用可（強度 1 段落ち）。両案同条件 |
| 8 | **timeline `labeled` イベントの actor 網羅性** | [共] 承認検証の前提 | M12 contract test 第 1 号。両案の承認機構が共通に依存 |
| 9 | **課金経路**（API key か Max サブスク充当か） | [共] D1 材料 | ローカル headless $150.9/66run の前提照合。S 案は現状維持＝中立、R 案は cloud 課金と比較要 |
| 10 | **GitHub Actions schedule の実遅延**＋60 日無活動の自動無効化仕様の本 repo 照合 | [S] M2 最終段 | SLO 未達なら系外監視の代替経路（別マシン・外部監視）裁定へ |
| 11 | **(c) run 上限・接近シグナルの有無** | [R] C-1 livelock | 警告なし kill なら stage>上限 の run が永久再実行（実測 306 turn/$7.70 の IMPLEMENT が既存）→ attempt cap の設計追加 |
| 12 | (a) イベント trigger の有無 | [R] R2 のみ | 基線は cron で成立＝採否に非影響・レイテンシのみ |
| 13 | Projects v2 API の actor 取得可否 | [共] D2-b | Ready 列継続を選ぶ場合のみ必要 |
| 14 | stage 別 allowlist の session 内切替可否 | [R] 最小権限 | 不可なら union 許可（権限主張の後退）か nested spawn（課金未確認） |
| 15 | OS user 分離×worktree の運用詳細（git 所有権・pnpm store 共有） | [S] 運用 | #3 の spike に同梱 |

補足: #1〜2（R 側）と #3（S 側）は**相互に排他でなく並走可能**（計 1〜2 日）。#4〜5 は仕様確認でなく R 案側の設計宿題であり、spike と独立に設計者へ差し戻せる。

---

## 7. 本書自身の限界

- 両 critique は敵対的レビューであり、指摘の一部（増殖力学・bus factor・比較枠）は推測を含む（各所で明記済み）。設計側の反論機会は未実施。
- 「判定 B で今日の監査が再現不能」（critique E）は scratchpad 内の照合として閉じているが、OTel の cloud 実測（#6）前であり、full I/O opt-in の cloud 適用可否次第で緩和の余地が残る（**未確認**）。
- charter 継承の未決（rubric 47/48・launchd 退役範囲・「CC は向いていない」両論）は両設計が同一の扱いで編入済み＝本書で再掲しない。
