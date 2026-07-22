# routines 基盤設計 v0（統合）

- 作成: 2026-07-08／read-only（repo・issue・PR への書き込みなし）
- 入力: `rf-transcript-observability.md`（transcript 取得可否の調査）・`rf-problem-mapping.md`（問題→解決対応）・`rf-skill-tool-definitions.md`（定義ドラフト）＋元資料 `code-red-charter-material.md`（S/C/M/R・keep-drop・D1〜D4。すべて本 scratchpad 内）
- 記法: 事実（一次証拠・実測に接地）／設計提案（PdM 裁定前）／**未確認**を峻別。入力間の矛盾は §7 に丸めず残す。

---

## 1. TL;DR（10 行）

1. **transcript 判定 = B（劣化した形なら取得できる）**。cloud session の事後 transcript API は無く、OpenTelemetry export で tool span・token・cost が取れる（full message history 不可・5〜60 秒 batch・過去遡及不可。出典 rf-transcript-observability）。
2. **分岐規則**: A（完全取得）なら cloud 全面移行＋既存 ingest adapter 改修のみ／**B なら cloud 全面移行＋OTel collector→lathe ingest の再設計（本書の基線構成）**／C（取得不能）なら hybrid（統治=cloud・実行=ローカル）か採用見送り。
3. ただし **B には二重の但し書き**: (i) 劣化幅（tool I/O 全文は opt-in・履歴取得不可）が lathe の観測要件を満たすかは PoC 実測、(ii) **OTel を cloud session で有効化できるか自体が未確認**（env/settings 注入 (e) 依存、§7-4）。どちらかが不成立なら実質 C ＝ hybrid へ縮退（§2 に併記）。
4. 基線構成: **cadence dispatcher routine＋stage-ledger 冪等再開（案C）＋DB claim 排他（INSERT=実行権）＋posting proxy（決定的 render＋post-check）＋watchdog（毎時突合・補償）**。
5. 最重大未決は **M3 権能分離**: routines が本人身元で実行されるなら承認シグナル汚染（S2-11）は現行より悪化しうる。D2(c) 裁定＋仕様確認 (d)(g) が **routines 採用可否そのものを左右**（§6-1）。
6. M1〜M13・R1〜R8 は §3 で全網羅。platform が構造で消すのは環境差・stale 常駐・worktree 相当の隔離のみ。dedup・watchdog・終端契約・構造化 I/O・post-check は**全部自前**。
7. R5（backend 抽象・codex A/B）は routines 採用で**縮退**（runtime は Claude 固定の公算）。D1 と一体で裁定。
8. 定義 v0（routine 9・skill 9＋凍結 1・label 9・contracts 9）は §4 に実物として収載。
9. 導入は PoC 先行: **最小 1 routine（dispatcher＋決定的 driver 一体）で実 issue 1 件を plan→merge まで一巡→切替検収 4 点の機械照合で判定**（§5 Step 1）。
10. PdM 裁定 8 点を優先順で §6。入力間の矛盾 6 点は §7（丸めない）。

---

## 2. 全体構成図

### 2.1 基線構成（判定 B・cloud 全面）

```
              ┌─────────────── GitHub（task/承認/着地の正本）────────────────┐
              │ issue = task（ADR 0031）   label: task / needs-plan / gov:* / run:*      │
              │ PR + CI = 単一着地ゲート（ADR 0026・検証資産全量 M13）                    │
              └────▲──────────────▲───────────────────────▲────┘
          導出(read only)│        書込は proxy のみ│                 PR 作成 / auto-merge arm│
              ┌────┴─────────┐ ┌──┴───────────────┐         │
   cron 毎N分 ─►│ dispatcher routine │ │ posting proxy（決定的 render │◄─ envelope ──┐
              │ gh導出→trigger述語 │ │ ＋投稿直後 post-check＋台帳） │               │
              │ →claim INSERT     │ └──▲───────────────┘               │
              └────┬─────────┘     │                                       │
        claim INSERT=実行権│              │台帳 read/write                          │
              ┌────▼───────────┴────────────────────┐    │
              │ managed Postgres（claims / stage-ledger / posting台帳 / RunStore）│    │
              └────┬───────────────────────▲────────┘    │
                    │spawn（注入prompt: thin bootstrap→repo scripts）│watchdog routine        │
              ┌────▼─────────────────┐    │（毎時: 3点突合・posting補償・     │
              │ cloud session（fresh・fresh checkout）│    │  escalation終端・actor監査・     │
              │ 案C: stage-ledger の未完 stage から   │    │  stale/契約check・検収4点）      │
              │ 進めるだけ進む→graceful 終了          │────┘                              │
              └────┬─────────────────┘ 最終メッセージ = envelope JSON ────────┘
                    │ OTel export（5〜60秒 batch・tool span/token/cost。※cloud で有効化可能かは未確認）
              ┌────▼─────────────────┐
              │ OTLP collector → lathe ingest 変換 pipeline │ ＝観測接続（判定 B・劣化形）
              └──────────────────────┘
```

要点（rf-problem-mapping §1 案C を採用）:
- 多段ライフサイクル（TASK_PLAN→PLAN_REVIEW→IMPLEMENT→LAND）は **1 発火 = 進めるだけ進む**。stage 境界ごとに ledger へ冪等記録し、run 上限接近・CI 待ちで graceful 終了→次発火が ledger から再開。resume 機構（S2-3 の事故源）は廃止。
- label 遷移で session を繋ぐ案B は不採用（内部遷移を gh に露出・書込ラグ×段数）。イベント trigger (a) が使えれば中断レイテンシは消えるが、**設計は cron polling だけで成立する形を基線**とする。

### 2.2 hybrid 構成（判定 C の場合。B でも劣化不受容なら同形に縮退）

```
 cloud routines: dispatcher（cadence 発火・claim・spawn 指令）＋ watchdog ＝ 統治・突合のみ
        │ spawn 指令（DB 経由 or ローカル runner が claim を poll）
 ローカル runner（Mac / case）: 実行 session を spawn ＝ local JSONL transcript が 100% 残る
        │
 lathe ingest = 現行 providers/claude.ts / codex.ts をそのまま使用（観測は無劣化）
```

- 排他は同一 DB claim（cross-machine 排他 M1 はどちらの構成でも同一制約下）。
- 代償: 宿主環境差（E1〜E4・S2-10）と宿主起因 silent death（S1-1）が**残る**＝[platform] で消えるはずだった分が M2/M8 自前部品に戻る。install self-check＋検収 4 点＋systemd 正本化（KillMode 等）を repo 正本として維持する必要。
- 補足: Session events stream API（run 中のみ購読可）は**常駐 listener が要る**ため cloud-only 構成とは両立せず、採るならこの hybrid（ローカル常駐 collector）でのみ成立（§7-6）。

---

## 3. 問題→解決の対応表（M1〜M13・R1〜R8 全網羅）

種別タグ: [platform]=routines が構造で解決／[自前:*]=自前部品で解決／[skill契約]=散文契約として残す／**[未解決]**=裁定・仕様確認待ち。
事象別（S1-1〜S3-7・構造 5 クラス C1〜C5）の詳細対応は rf-problem-mapping §3〜§6 が正本。集計: platform が消すのは E 系環境差・stale 常駐・隔離のみ、他はすべて自前部品（dedup／watchdog／終端契約／post-check／構造化 I/O／注入／CI）。

### 3.1 必須 M1〜M13

| # | 要件 | 種別 | routines 基盤での充足（1 行） |
|---|---|---|---|
| M1 | 二重実行の物理的不可能化 | **[自前:dedup]** | claim `INSERT … ON CONFLICT DO NOTHING` = 実行権（DB unique・fail-closed・cross-machine 同一制約）。fs マーカー・worktree 導出は全廃。DB 不達時は実行しない |
| M2 | silent death 検知の常設 | **[自前:watchdog]** | §4.2-watchdog の 3 点突合（起動記録×heartbeat×outcome）＋dispatcher⇄watchdog 相互 dead-man's switch。platform 完了通知は補助（仕様 (c) 未確認） |
| M3 | 権能分離 fail-closed | **[未解決（最重大）]** | routines は本人身元実行の可能性（(g) 未確認）＝現行より**後退しうる**。GitHub App／bot token／書込 proxy 案は (d)(g) 仕様確認＋D2(c) 裁定が前提。**採用可否を左右** |
| M4 | I/O の構造化 | **[自前]** | 最終メッセージ = envelope JSON（schema 固定・§4.3）＋決定的スクリプト。Stop hook 不採用（#302 二重課金の drop と整合） |
| M5 | 終端契約＋書込失敗の補償 | **[自前:終端契約＋watchdog]** | stage 完了 =「envelope 受理＋posting 台帳 confirmed」まで。失敗は台帳に必ず記録→次パス watchdog が補償（「非致命 continue」の構造禁止） |
| M6 | spawn の単一モジュール集約 | **[自前]＋[platform]** | session 生成者を dispatcher routine 1 本に限定。routine list API×ledger 突合で野良 run を機械検出（動的生成 (b) 未確認） |
| M7 | 版固定＋self-update | **[platform（前半）]＋[自前（後半）]** | 毎発火 fresh checkout が stale 常駐を構造排除。routine prompt は thin bootstrap（正本は repo・PR+CI 下）。外部 id の毎パス名前解決は自前 |
| M8 | 環境 repo 正本化＋検収 4 点 | **[platform]＋[自前:検収]** | 環境は cloud spec としてコード化＝宿主依存が消滅（hybrid 時は残る・§2.2）。**切替完了宣言は検収 4 点の機械照合 GREEN のみ** |
| M9 | 投稿物の post-check | **[自前:post-check]** | 投稿直後に GET 読み戻し: 実在・本文長≥契約 min・未展開 placeholder 不在・対象 id 一致・必須節存在（§4.3-3） |
| M10 | 状態は導出・二重台帳禁止 | **[自前]** | task 状態は gh 導出を維持。claim/ledger は「実行 telemetry の DB 単独正本」＝同一事実の二重書きではない。再実行判定は導出でなく claim 制約へ |
| M11 | loop 本体を loop で改修しない | **[skill契約→自前化]＋[運用残余]** | thin-prompt 化で本体 = repo コード = 改修は必ず PR+CI。**routine 定義の作成・削除・cron 変更だけはゲート外**＝運用規律 or (b) があれば repo 正本＋同期スクリプト |
| M12 | 外部契約の contract test | **[自前:watchdog]** | 毎時＋CI。第 1 号 = timeline `labeled` イベントの actor 取得（§4.6 承認検証の前提・**未確認**） |
| M13 | CI への検証資産全量搭載 | **[自前:CI]** | routines 非依存。PR+CI 単一ゲート維持の限り基盤選定と独立に必須（#279「ザル」の解消） |

### 3.2 推奨 R1〜R8

| # | 要件 | 種別 | 充足（1 行） |
|---|---|---|---|
| R1 | stage ごとの情報注入契約 | **[自前:注入]** | prompt 生成を決定的スクリプトに一元化・欠落時 spawn 拒否。fresh session 化で必須度は現行より**上がる**（毎回ゼロベース探索になるため） |
| R2 | 非同期 dispatch | **[platform（(a)(b) 未確認）]＋[自前:SLO 突合]** | 発火 = 独立 session で同期詰まり消滅。イベント trigger 無しなら cadence が下限（p95 52 分よりは改善見込み・設計値保証は (a) 次第） |
| R3 | 教材 2 段化＋密度の構造契約 | **[skill契約]＋[自前:post-check]** | 予算・必須節・禁則・self_check は contracts データ。検証可能部分は機械 RED（形容詞注文は使わない） |
| R4 | 決定的配置規則 | **[自前]** | 選択肢の正解位置等は proxy の render 時に乱択スクリプトで確定（LLM に決めさせない） |
| R5 | backend 抽象の維持 | **[未解決（縮退）]** | routines の runtime は Claude 固定の公算＝codex 併用・stage 単位 A/B の実測資産を失う。可逆性を残すなら dispatcher に backend 抽象を自前保持（コスト増）。D1 裁定 |
| R6 | escalation triage 三分岐 | **[自前:コード可搬]** | `classifyEscalation`（純関数＋unit test）を session 終端の exit 分類へ移植。結果は label＋ledger |
| R7 | plan 契約 6 セクション＋過小 RED | **[自前:データ keep]** | `contracts/plan.schema.json` へ移送（構造化 I/O の schema として） |
| R8 | 優先度の第一級表現 | **[自前]** | `gov:p1/p2/p3` label 新設＋dispatcher の claim 順序に反映（body 退避の解消・即日可能） |

---

## 4. routine・skill・label 定義 v0（実物）

指示文の全文正本は `rf-skill-tool-definitions.md` §1（同 scratchpad）。本節は統合版として trigger 式・注入・allowlist・envelope・指示文要旨を実物で収載する。**注意: 本節は M3（credential 分離）解決後の姿として書かれている**（§7-2）。

### 4.0 前提モデル（5 点）

1. **routine = 版固定されたデータ**: `routines/<name>.json` = `{name, version, trigger, instruction, allowlist, skills, injection, envelope_schema}`（M7・ADR 0038 contracts-as-data）。
2. **dispatcher（cadence routine・常駐ではない）**が毎パス gh から状態導出（M10）→ trigger 述語で候補抽出 → **DB claim INSERT が唯一の排他**（M1）→ 単一 spawn（M6）が allowlist を明示注入（settings 暗黙 load 禁止 = S2-6 封じ）。
3. **inner 実行体は GitHub credential を持たない**（M3。実現手段は未決）。gh 書込は全て posting proxy が envelope から決定的に行う。
4. **入力は注入・出力は envelope**（M4・R1）。再発掘させない・散文で返させない。注入 1 つでも取得失敗なら spawn しない（fail-closed）。
5. permission は **allow 列挙＋deny デフォルト**。`ask` 不使用。WebFetch/WebSearch は全 routine deny。MCP は nightly-rubric の lathe read 系のみ例外。

### 4.1 routine 一覧 v0（9 本）

共通: trigger 種別 = `gh-state`（dispatcher 毎パス評価）／`run-internal`（driver が run 内遷移＝案C）／`cadence`。`approved` := `has(gov:approve)` ∧ labeled イベント actor ∈ 人間 allowlist。`posted(kind)` は posting 台帳×gh 実在の突合で導出（label を冪等判定に使わない）。escalation 三分岐（context→bounded retry／environment→修理起票／decision→`run:escalation`）を全 routine 継承。

| routine | trigger | 注入（主要） | allowlist（CC 語彙・列挙外 deny） | skill | envelope |
|---|---|---|---|---|---|
| plan-generate | gh-state: `open ∧ has(task) ∧ ¬has(needs-plan) ∧ ¬has(gov:hold) ∧ ¬has(run:escalation) ∧ ¬plan_green ∧ ¬active_run` | issue 本文＋全 comment・（再試行時）前回 findings 全文・対象領域サマリ・plan-format 全文・plan.schema.json | Read/Grep/Glob＋Bash(git log/diff/show:*)。Edit/Write/gh なし・read-only checkout | plan | plan.schema.json（plan 全文を body に。ファイル参照禁止） |
| plan-review | run-internal: plan envelope 受理直後。RED は findings 注入で plan-generate 最大 2 回再試行 | plan 全文・issue 全 comment・plan-format・（再審査時）前回 findings＋diff | Read/Grep/Glob のみ。Bash なし | plan-review | verdict GREEN\|RED＋findings[]{section,what,why} |
| implement | gh-state: `open ∧ has(task) ∧ plan_green ∧ (class=trivial ∨ approved) ∧ ¬has(gov:hold) ∧ ¬active_run ∧ ¬pr_open`。standard は承認必須（fail-closed） | 承認済み plan 全文・AC・（差し戻し時）findings・worktree パス・該当 rubric 一覧 | worktree 内 Read/Grep/Glob/Edit/Write＋Bash(pnpm test:*, git add/commit/rebase/status/diff/log:*)。**push・gh なし** | implement | commit sha・変更ファイル・AC⇄実装対応表・自己検証コマンド＋実 exit code |
| verify | run-internal: implement envelope 受理後（driver が rebase 済み tip で起動） | 変更パス・selector 選定の検証コマンド列（scope×tier）・tip sha | Read/Grep/Glob＋Bash(selector 列挙コマンドのみ＋git status/log/diff:*)。変更系なし | verify | check ごと GREEN/RED/INVALID＋evidence（RED は診断しない） |
| land-review | gh-state: `pr_open ∧ ¬posted(review, head sha)`。CHANGES 2 周まで・以後 escalation | branch diff 全文・plan・該当 rubric JSON 全文・過去周回 findings 全文（再出力させない＝#302 封じ） | Read/Grep/Glob＋Bash(git diff/log/show:*) | review | verdict approve\|changes-needed＋findings[]{severity,file,line,what,why}。merge arm は proxy |
| explain | plan 段: `plan_green ∧ class=standard ∧ ¬approved ∧ ¬posted(explain-plan)`／PR 段: `pr_open ∧ posted(explain-plan) ∧ ¬posted(explain-pr)`。**冪等の正は posting 台帳** | plan 段: issue＋plan＋explain-plan.json／PR 段: diff＋plan＋plan 段教材＋explain-pr.json | Read/Grep/Glob＋Bash(git log/show:*)。gh なし | explain | body=教材全文 md＋self_check[]＋target。正解位置は決めない（選択肢集合のみ返し配置は機械） |
| watchdog | cadence: 毎パス（毎時本体＋dispatcher 同居軽量版） | —（**LLM なし・決定的スクリプト**。検査項目は contracts/watchdog-checks.json） | DB read/write・gh **bot** credential（issues/labels/comments。merge なし）・proxy 呼出 | — | — |
| nightly-rubric | cadence: nightly | 直近 24h run 台帳サマリ・rubric 発火/verdict 集計・judge 実行結果・rubric 48 本 index | Read/Grep/Glob＋Bash(read-only)＋**例外: mcp__lathe__* read 系**（submit_finding は deny） | meta-audit＋result-classification | findings[]＋proposals[]{kind,origin}。**提案止まり・起票しない** |
| test-triage／plan-decompose | run-internal: verify RED 直後／gh-state: `open ∧ has(needs-plan) ∧ …` | RED 一覧＋playbook 全文＋diff／親 issue | read-only＋playbook 再実行コマンドのみ／read-only | test-triage／plan | 既知(playbook ID)/新規(evidence＋仮説)。INVALID は即 escalation／children[] を proxy が機械投函 |

**watchdog-checks.json v0 の検査項目**（M2/M5/M9/M12 の実体）:
1. 3 点突合（起動記録×heartbeat×outcome→dead 判定・escalation 起票）　2. posting 補償（台帳⇄gh 実在。missing は sha256 冪等再投稿・stub は補修＋報告）　3. escalation 終端補償（裁定 comment 済みの `run:escalation` 除去・逆向きも）　4. `gov:*` actor 監査（allowlist 外は剥がす＋報告）　5. `run:*` 投影整合（導出に合わせ修正）　6. stale 検査（routine 版 vs origin/main・外部 id 名前解決）　7. cross-machine 二重検査（active run 2 件・Discussion 2 本→escalation・自動削除なし）　8. 切替検収 4 点（導入時のみ）　9. **［本書追加・提案］観測突合**: run ledger×lathe ingest 到着の突合＝OTel export 欠落の検知（判定 B 経路の監視。(f)/(e) 依存）。

**指示文要旨**（全文は rf-skill-tool-definitions §1）: 全 routine 共通で「必要入力は注入済み・再発掘禁止・不足は escalate(context)」「最終メッセージは envelope JSON のみ・ファイル参照記法禁止」。plan-generate = 座標特定→スケール判定→選択肢 2 つ以上→契約（typedef/schema を plan に書く）→正準見積り。plan-review = 判断の質のみ（書式は機械検査済み）・迷ったら通す・findings は再試行注入される形式で。implement = plan の契約セクション変更禁止（必要なら escalate(decision)）・明示 add のみ・実 exit code を記録・push/PR は driver。land-review = 設計判断のみ（機械で測れる規範は再実行しない）・severity＋file:line＋根拠。explain = 読者は plan 段 PdM only・TL;DR 必須・字数予算内・禁則 4 パターン・self_check を envelope に。

### 4.2 skill 構成 v0

線引き原則: **SKILL.md（散文）= 変わらない手順・観点・ESCALATE 条件**（判断を託す場所）／**contracts/（JSON データ）= 書式・schema・予算・禁則・台帳**（機械検証の正本。SKILL.md からパス参照のみ・inline 複製禁止）。配送は runtime 非依存（CC は `.claude/skills/`・他 runtime は prompt inline 注入。正本は repo 1 箇所）。

| skill | 状態 | 使う routine | keep 資産との対応 |
|---|---|---|---|
| plan | 新設（plan-format 手順化） | plan-generate・plan-decompose | 資産④ 6 セクション原則（散文）＋ plan.schema.json（書式） |
| plan-review | 新設 | plan-review | 資産④差し戻し基準＋P2/P3 対策観点 |
| implement | keep（ほぼ転用＋credential 境界 1 節追記） | implement | worktree 単一 writer・明示 add・ESCALATE 規約 |
| verify | keep（コマンド面差し替え・receipt/preflight 節削除） | verify | 5 値報告・RED を診断しない・read-only 規律 |
| review | keep（＋過去 findings 再掲禁止を追記） | land-review | 観点 3 点＋severity＋機械検査と重複しない |
| test-triage | keep | test-triage | playbook 参照・既知/新規二分・INVALID 即 escalate |
| explain | 再編（explain-diff→2 形態契約） | explain | 資産⑦＋explain-plan/pr.json |
| meta-audit | keep（tool マップを新台帳 read 面に更新） | nightly-rubric・outer 監査 | read-only・固定 pipeline にしない |
| result-classification | keep | nightly-rubric・escalation 判別 | taxonomy 参照＋判断の記録義務 |
| （凍結）lathe-ui | 凍結 | — | lathe 開発再開まで参照しない |

escalation triage（資産⑤）は skill にしない——純関数 `classifyEscalation` をコード移送。

**contracts/ データ一覧**: `plan.schema.json`（6 セクション・trivial/standard 判定・見積り regex）／`plan-review-criteria.json`／`explain-plan.json`・`explain-pr.json`（字数予算・必須節・禁則・self_check）／`envelopes/*.schema.json`／`injection/*.json`（注入必須リスト・欠落時 spawn 拒否）／`watchdog-checks.json`／`rubrics/**/rubric.json` **48 本そのまま移送**（枠組み run.mjs/select.mjs は移送しない・scope×tier selector I/F のみ後継）／`design/test-failure-playbook.md`／`routines/<name>.json`。

### 4.3 出力契約（Stop hook 無しの 3 層機械保証）

1. **生成時**: 最終メッセージ = envelope JSON 1 個（共通骨格: `{routine, issue, run_id（注入値エコーバック）, verdict（enum）, summary, artifacts[]{kind, body=全文}, escalate{class, reason}}`）。成果物は body に全文（`@file`・パス参照は schema レベルで禁止＝P1/F2 封じ）。parse/validate 失敗 = UNPARSABLE → エラー全文＋schema 注入で **bounded retry 最大 2 回** → 超過は decision escalation。正常系は 1 回生成（Stop hook の毎回全文再生成 = #302 と対照）。**未確認**: CC headless の schema 強制出力可否（D1 材料）。
2. **配信時**: proxy が envelope からテンプレート**関数**で決定的 render（配置乱択 R4 もここ）→ 台帳に intent 行（sha256）→ gh REST 投稿（GraphQL label 系は癖 Q5 のため回避）→ **投稿直後 post-check**（実在・本文長・placeholder 不在・対象 id 一致・必須節）→ confirmed。失敗は台帳 status=failed＋エラー全文（握りつぶし禁止）。
3. **事後**: watchdog が台帳⇄gh を毎パス突合し missing 再投稿・stub 補修・label 補正。**3 層のどれが落ちても「正本に成果物がある」へ収束**——これが Stop hook（1 層・確率的）の置き換え。

### 4.4 統治 label 語彙 v0

| label | 付与者（正） | 意味／trigger での役割 |
|---|---|---|
| `task` | 人間 or 承認済み機械投函（proxy） | task の印（issue=task・ADR 0031 keep）。全実装系 routine の必要条件 |
| `needs-plan` | 起票者 | 分解型。plan-decompose の trigger |
| `gov:approve` | **人間のみ** | 実装解禁（Ready 相当）。implement trigger（**actor 検証つき**） |
| `gov:hold` | **人間のみ** | dispatch 停止（故障に数えない・ADR 0037 keep）。全 trigger の除外条件 |
| `gov:p1/p2/p3` | **人間のみ** | 優先度（R8）。claim 順序 |
| `gov:require-approval` | **人間のみ** | trivial でも承認必須に強制 |
| `run:escalation` | **機械のみ**（proxy/watchdog） | 裁定待ち。実装系 trigger の除外条件 |
| `run:explained-plan` / `run:explained-pr` | **機械のみ** | 教材投稿済みの**投影**（正は posting 台帳。冪等判定に使わない＝M1） |
| `run:blocked` | **機械のみ** | blocked-by 未解消の投影（可読性のみ） |

原則: **進行状態の label は作らない**（In Progress/Done は PR open/merge close から導出＝ADR 0031/M10 維持）。label は (a) 人間の承認入力 `gov:*` (b) 導出不能な例外 `run:escalation` (c) 純投影のみ。

**承認の効力判定（M3 の機械実装・3 層）**: (1) credential 分離（harness = App/bot token・inner = token なし・人間 = 人間アカウント）　(2) **actor 検証**: `gov:*` の存在でなく timeline `labeled` イベントの actor ∈ 人間 allowlist を効力根拠に（bot が貼っても trigger 偽＝S2-11 封じ。**未確認**: timeline API の actor 網羅性——M12 contract test 第 1 号）　(3) watchdog が allowlist 外 `gov:*` を剥がす。D2 で Projects Ready 列継続の裁定になっても、述語 `approved` の adapter 差し替えで trigger 式・routine 定義は不変（**未確認**: Projects v2 API の actor 取得可否）。

---

## 5. 段階導入計画

各 Step は「先へ進む条件」を機械照合で判定（記憶・印象で完了宣言しない）。

| Step | 内容 | 先へ進む条件 |
|---|---|---|
| **0. 仕様 spike**（PoC 前提・1〜2 日） | 未確認 (d) secret 注入・(e) env/settings 持ち込み（**OTel 有効化可否を含む**）・(g) 実行 identity・(c) run 上限の existence proof。DB（managed Postgres）への cloud session からの到達確認 | (d) or DB 到達が不成立なら **claim 排他が建たない＝採用中止の裁定材料として §6-1 へ**。成立なら Step 1 |
| **1. PoC（最小 1 routine で issue 1 件を一巡）** | 部品最小セット: claims table 1 枚＋dispatcher routine 1 本（cadence 5 分）＋決定的 driver script（案C・stage-ledger）＋envelope（plan/implement/verify の最小 schema）＋手動承認（gov:approve 手貼り）。**trivial class の実 issue 1 件を plan→PR→merge まで一巡**。同時に OTel 出力を実測（tool span 粒度・latency・cost の local 単価一致＝D4 材料） | **切替検収 4 点の機械照合 GREEN**: (a) heartbeat/live 1 パス生存 (b) runtime 応答 (c) 成果物（plan comment・PR）の期限内出現 (d) outcome=success。RED なら result-classification で類別して戻る |
| **2. dedup＋watchdog 本設**（M1/M2） | claim 排他の全面化（fs 導出全廃）・watchdog 検査 1〜5 常設・dead-man's switch | 並列 2 issue で二重 dispatch 不発を機械確認（意図的競合テスト）・watchdog が模擬 dead run を検知 |
| **3. posting proxy＋post-check＋台帳**（M4/M5/M9 全面） | 全書込を proxy 経由に・explain 2 段を搭載（stub 事故 S1-4 封じの実証面） | post-check 5 項目が CI＋実投稿で GREEN・模擬書込失敗が台帳→次パス補償で回収される |
| **4. 権能分離**（M3。**D2(c) 裁定後**） | App/bot token・actor 検証・contract test 第 1 号（timeline actor）・allowlist 外 gov:* 剥がし | 「bot が gov:approve を貼っても implement が発火しない」を実測 |
| **5. 全 routine 展開＋CI 全量** | plan/plan-review/implement/verify/land-review/explain/test-triage/plan-decompose/nightly-rubric・M13 全量搭載・M12 毎時 contract test | 各 routine の envelope validate 率・escalation 三分岐の実弾動作・CI GREEN |
| **6. 観測本設＋旧系退役** | OTLP→lathe ingest pipeline の本設（or **D4 裁定により hybrid 縮退**）。旧系（Mac launchd・case systemd）退役 | 退役は **cross-machine 排他が DB claim に入った後・検収 4 点 GREEN 後のみ**（#237/#247 の分掌解消込み。併存の実測 §7-5 を踏まえ「退役完了」を機械照合なしに宣言しない） |

数値パラメータ（cadence 5 分・plan 再試行 2 回・差し戻し 2 周・lease 期限等）は現行 loops.md 値の継承＝**新基盤で再測定対象**。

---

## 6. PdM 裁定が要る点（優先順）

1. **【採用可否を左右】M3×D2(c) — 権能分離の実現手段と本人身元実行の受容**: routines が PdM 本人の身元で実行されるなら承認汚染（S2-11）は構造的に悪化。GitHub App／bot token／書込 proxy のどれで分離するか、それが platform 仕様 (d)(g) で実現可能か（Step 0 で実測）を先に裁定・確認しないと、routines 採用そのものを決められない。
2. **D4 — 観測劣化（判定 B）の受容 or hybrid 縮退**: OTel 経路は tool span・token・cost は取れるが full message history・事後遡及は不可。lathe の観測製品として tool I/O 全文が必須なら B では足りず hybrid（§2.2）へ。**cloud での OTel 有効化可否（(e) 依存）の実測前に本裁定を確定しない**こと。
3. **D1 — runtime 選定と R5 縮退の受容**: routines 採用 = Claude 固定の公算 = codex 併用・stage 単位 A/B（実測済み資産）の喪失。可逆性を残す（dispatcher の backend 抽象を自前保持・コスト増）か、縮退を受容するか。コスト削減は選定理由にしない（コスト主因は turn 数・runtime 非依存）。
4. **D2(a)(b) — 承認面の正**: `gov:approve` label（actor 検証つき・本書の正案）か Projects Ready 列継続（ADR 0035）か。trigger 式は adapter 差し替えで両対応可能に設計済み——どちらを正にするかの裁定のみ要る。
5. **D3 — 基盤の置き場**: lathe repo 内（ADR 0038 の packages 構成）か別 repo か。「プロジェクト外のハーネスは必要ない」裁定（2026-07-08）と「lathe 開発中止・基盤再構築」の整合。keep 資産（rubric 48 本・plan 契約・ADR 群）の移送先も連動。
6. **Step 0/1 の実施承認と PoC 対象 issue の指名**（trivial class 1 件）。
7. **label 語彙 v0 と数値パラメータの暫定承認**（`gov:`/`run:` 新設・既存 task-request からの移行・cadence/retry 値は再測定前提の暫定）。
8. **旧系退役のタイミング**（Step 6。cross-machine 併存が実測されており、退役完了は機械照合後のみ宣言）。

---

## 7. 入力間の矛盾・未確認（丸めずに残す）

1. **dispatcher の形態**: rf-problem-mapping は「毎 N 分発火する配車 routine」（常駐なし）、rf-skill-tool-definitions §0 は「dispatcher（常駐）」と表記。routines の trigger は cron/fireAt のみ（実測）で常駐は置けないため、**本書は cadence routine を採用**。run-internal 遷移は session 内の決定的 driver script が駆動（案C と整合）——両入力の意味は接合可能だが表記は矛盾のまま注記。
2. **M3 の扱い**: rf-skill-tool-definitions は「inner は credential を持たない」を**前提**として定義を書くが、rf-problem-mapping は M3 を**最重大の未解決**とする。本書は「定義 v0 = M3 解決後の姿・解決手段は §6-1 の裁定待ち」と峻別（定義の実物性と未決性は両立させる）。
3. **D4 前提の変形**: rf-problem-mapping §9-6 は「(f) transcript export の existence proof が採用判断の前提」とした。rf-transcript の判定 B により existence proof は**劣化形でのみ成立**（完全形は不存在が確認された）。よって前提は「充足/不充足」の二値でなく「**劣化受容の裁定（§6-2）に変形**」。
4. **OTel の cloud 適用可否**: rf-transcript の根拠文書（monitoring-usage・Agent SDK observability）は Claude Code 一般の telemetry 設定であり、**cloud routines session で OTEL 環境変数を注入できるかは書かれていない**＝rf-problem-mapping の未確認 (d)(e) と同じクラス。rf-transcript は判定 B にこの依存を明示していないため、本書で Step 0 の実測項目に格上げ（推測を事実に混ぜない）。
5. **元資料から継承する矛盾**: rubric 本数 47 vs 48（機械計数 48 を採る）／launchd 退役の完了範囲（07-08 に Mac×case 併存の実測あり・#237 OPEN——退役完了と扱わず M1 cross-machine 排他＋Step 6 に編入）／PdM 申告「CC は向いていない」vs 実測「動かないは不成立・ただし 3 点で実質支持」（両論のまま D1 材料）。
6. **Session events stream API の位置づけ**: rf-transcript は代替 2 に挙げるが、run 中のみ購読可＝**常駐 listener が必要**で、cloud-only 構成（常駐なし）と両立しない。採るなら hybrid（ローカル常駐 collector）でのみ成立——rf-transcript 内ではこの制約と構成の矛盾が明示されていないため注記。
