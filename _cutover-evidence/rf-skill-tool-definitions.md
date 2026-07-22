# skill・tool・統治 label 定義 v0（code red 再建・具体物ドラフト）

- 作成: 2026-07-08／read-only。入力: `code-red-charter-material.md`（keep 資産・M1〜M13/R1〜R8）
  ＋現物照合（`design/plan-format.md`・`rubrics/`＝rubric.json **48 本**機械計数・`.claude/skills/`
  8 本・`scripts/inner-loop-escalation-triage.mjs`・issue #288・`design/loops.md`・
  `ops/outer-harness/discipline.md`・ADR 0038）
- 記法: 事実（現物・裁定に接地）と設計提案（PdM 裁定前）を峻別。確認できないものは「未確認」と明記。
- 未決 D1/D2 に依存しない形で書く。tool 名は Claude Code 語彙で例示し、他 runtime では同等機能へ写像。

---

## 0. 前提モデル（本定義が依存する最小の実行系像）

材料 §4 の M 要件から、routine 定義が依存する骨格だけを固定する（実装設計は本書 scope 外）。

1. **routine = 版固定されたデータ**（M7・ADR 0038「駆動 context = LoopDefinition」）。
   `routines/<name>.json` = `{name, version, trigger, instruction, allowlist, skills, injection,
   envelope_schema}`。指示文・allowlist・注入契約はコードでなくデータ（contracts-as-data）。
2. **dispatcher（常駐）**が毎パス gh から状態を導出（M10）→ trigger 式で候補抽出 → **DB 一意性
   制約への INSERT が唯一の排他**（M1。label・fs マーカー・worktree 有無での実行中判定は禁止）→
   単一 spawn モジュール（M6）が allowlist を**明示注入**して起動（settings 暗黙 load 禁止＝S2-6 封じ）。
3. **inner 実行体は GitHub credential を持たない**（M3 fail-closed）。gh 書き込みは全て
   driver/orchestrator の **posting proxy** が envelope から決定的に行う（§3）。
4. **入力は注入・出力は envelope**（M4・R1）。agent に再発掘させない／散文で返させない。
5. permission は **allow 列挙＋deny デフォルト**。`ask` 不使用（headless で ask=自動拒否となる対話前提の名残を採らない）。

---

## 1. routine 一覧 v0

### 1.0 共通規約（全 routine に適用）

- **trigger 述語**（機械評価・毎パス導出・id 直書き禁止＝M7）: `open`/`has(<label>)`＝gh 導出。
  `approved` := `has(gov:approve)` かつ labeled イベント actor ∈ 人間 allowlist（§4.3）。
  `plan_green`/`posted(<kind>)`/`active_run`＝DB（RunStore・posting 台帳）から導出——`posted` は
  台帳×gh 実在の突合（台帳だけを信じない＝S1-4 対策）。`pr_open`＝参照 PR の導出（ADR 0031）。
- **trigger 種別**: `gh-state`（dispatcher 毎パス評価）／`run-internal`（driver が run 内で遷移）／`cadence`（時刻）。
- **注入（injection）**: 表の入力を dispatcher/driver が機械取得して prompt に埋める。**1 つでも取得
  失敗なら spawn しない**（fail-closed。「agent に探させて補う」禁止＝R1・#301 ナビ再発掘 37% の封じ）。
- **allowlist**: CC 語彙で例示・**列挙外は deny**。MCP connector は既定ゼロ（例外は 1.8 のみ）。
  WebFetch/WebSearch は全 routine で deny（外部注入面を作らない）。
- **出力**: 最終メッセージは envelope schema（§3.1）適合の JSON のみ。保証は Stop hook でなく §3.2 のチェーン。
- **escalation 三分岐を継承**（資産⑤ `classifyEscalation` の規約）: `context`（情報不足）→ bounded
  retry が吸収／`environment`（rebase 競合等）→ 修理起票／`decision`（判断が必要）→ `run:escalation` 投函。

### 1.1 plan-generate（plan 生成）

| 項目 | 定義 |
|---|---|
| trigger | gh-state: `open ∧ has(task) ∧ ¬has(needs-plan) ∧ ¬has(gov:hold) ∧ ¬has(run:escalation) ∧ ¬plan_green ∧ ¬active_run` |
| 注入 | issue 本文・**issue スレッド全 comment**（P3 false RED 対策）・再試行時は前回 plan-review の findings 全文（P2 対策）・変更対象領域の現状サマリ（selector が plan の scope 候補から機械生成）・`design/plan-format.md` 全文・`contracts/plan.schema.json` |
| allowlist | `Read` / `Grep` / `Glob` ＋ `Bash(git log:*, git diff:*, git show:*)`（read-only 検証用）。Edit/Write/gh/WebFetch なし。cwd = read-only checkout |
| skill | `plan`（§2.2-1） |
| envelope | `contracts/envelopes/plan.schema.json`（artifacts[0].body = plan 全文。**ファイル参照禁止**＝P1 transcript 死蔵対策） |

**指示文の全文案**:

> あなたは planner。対象 issue の実装計画（plan）を作る。必要な入力は本文下に注入済み——
> 再取得・再発掘はしない。注入に無い情報が判断に必須なら、envelope の escalate
> （class: context）に何が足りないかを書いて終わる。
>
> 手順は skills/plan に従う。要点:
> 1. 問題を座標付き（file / 事象 / 根拠）で 2〜5 行に特定する。
> 2. スケール判定: `contracts/plan.schema.json` の trivial 条件に合致すれば軽量形
>    （問題/修正方針/検証/見積りの 4 行〜）、それ以外は完全形 6 セクション。
> 3. 完全形では選択肢を 2 つ以上検討し却下理由を書く。契約（型・schema・API 境界・
>    artifact 形式）に触るなら **typedef / schema そのものを「契約」セクションに書く**。
>    implementer はそれを変更できない。
> 4. 方針は「何を・なぜ」まで。ファイル別の詳細手順は書かない（plan が implement を食わない）。
> 5. 見積りは正準 1 行形式: `見積り: diff ~<N> 行 / <M> ファイル・implement ~<T> 分`。
> 6. 設計原則（深いモジュール／同一情報の入口は 1 つ／型は plan が決める）に反する案は自分で却下する。
>
> ESCALATE（class: decision）: 要求の相互矛盾／scope を超える契約変更／裁定 comment と本文の食い違い。
>
> 出力: 最終メッセージは `contracts/envelopes/plan.schema.json` に適合する JSON のみ。
> plan 全文を artifacts[0].body に入れる。ファイルへの書き出し・参照記法は禁止。

### 1.2 plan-review（plan 審査）

| 項目 | 定義 |
|---|---|
| trigger | run-internal: plan envelope 受理直後（同 run 内で driver が遷移）。RED は findings を注入して plan-generate を最大 2 回再試行 |
| 注入 | plan 全文（envelope 由来）・issue スレッド全 comment・`design/plan-format.md`・`contracts/plan.schema.json`・（再審査時）前回 findings と plan の diff |
| allowlist | `Read` / `Grep` / `Glob`（repo 現物との照合用・read-only）。Bash なし・gh なし |
| skill | `plan-review`（§2.2-2） |
| envelope | `contracts/envelopes/plan-review.schema.json`（verdict: GREEN\|RED、findings[]: {section, what, why}） |

**指示文の全文案**:

> あなたは plan reviewer。注入された plan 全文を issue スレッドと plan 契約に照らして審査する。
> 書式適合（6 セクションの存在・見積り正準形）は機械検査済み——あなたは**判断の質**だけを見る。
>
> 観点(skills/plan-review):
> 1. PdM が読んで判断できるか。問題の座標が具体か・選択肢が実質か（ダミー対案でないか）・
>    方針が「何を・なぜ」で止まっているか（implement を食っていないか）。
> 2. 設計原則違反は RED: 複数の関数を呼ぶだけの薄い糊層の新設／同一情報の複数入口
>    （optional 引数で契約が切り替わる API）／implementer に型の設計判断を残す plan。
> 3. 見積り: 無宣言・scope に対して明白に過小は RED（差し戻し根拠は plan-format「運用」節）。
> 4. スレッドの裁定 comment と plan の矛盾は RED。該当 comment を findings に引用する。
>
> 迷ったら通す（false RED で時間を奪わない）。RED の findings は再試行する planner に
> そのまま注入される——「どのセクションの・何が・なぜ・どうすれば GREEN か」の形で書く。
>
> 出力: 最終メッセージは `contracts/envelopes/plan-review.schema.json` に適合する JSON のみ。
> plan 全文の再掲はしない（差分審査に必要な材料は機械が注入する）。

### 1.3 implement（実装）

| 項目 | 定義 |
|---|---|
| trigger | gh-state: `open ∧ has(task) ∧ plan_green ∧ (class=trivial ∨ approved) ∧ ¬has(gov:hold) ∧ ¬active_run ∧ ¬pr_open`。class は plan-review envelope の判定値（DB）から導出——**standard は承認必須がデフォルト（fail-closed）** |
| 注入 | 承認済み plan 全文・acceptance criteria・（差し戻し時）review findings 全文・対象 worktree のパス・変更対象領域の該当 rubric 一覧（selector 出力） |
| allowlist | worktree 内に限定した `Read` / `Grep` / `Glob` / `Edit` / `Write` ＋ `Bash(pnpm test:*, pnpm -C:*, git add:*, git commit:*, git rebase:*, git status:*, git diff:*, git log:*)`。**push なし・gh なし**（PR 作成は driver）。remote credential を worktree に置かない |
| skill | `implement`（§2.2-3。現行 keep） |
| envelope | `contracts/envelopes/implement.schema.json`（commit sha・変更ファイル一覧・plan の AC ⇄ 実装対応表・自己検証コマンドと実 exit code） |

**指示文の全文案**:

> あなたは implementer。注入された承認済み plan・acceptance criteria・（あれば）review
> findings **だけ**を対象に、この worktree の中で最小の互換変更を行う。scope の追加・
> 発明はしない。
>
> skills/implement に従う。要点:
> 1. 着手前に `git rebase main`。競合したら自力で契約を作らず ESCALATE（class: environment）。
> 2. plan の「契約」セクションの typedef / schema は変更禁止。変更が必要になったら実装せず
>    ESCALATE（class: decision。型 = 設計判断 = plan の管轄）。
> 3. 設計軸が未定義（契約・ロール割当・規約新設）なら最小変更を発明せず ESCALATE（class: decision）。
> 4. 1 commit にまとめる。staging は明示 `git add <paths>` のみ。`git add -A` / `.` 禁止。
> 5. 自己検証は実コマンドを実行し、実 exit code を envelope に記録する。未確認の GREEN を
>    報告しない。
> 6. push・PR 作成・gh 操作はあなたの仕事ではない（driver が行う）。
>
> 出力: 最終メッセージは `contracts/envelopes/implement.schema.json` に適合する JSON のみ。

### 1.4 verify（独立検証）※最小 7 への追加（実装 chain の一部）

| 項目 | 定義 |
|---|---|
| trigger | run-internal: implement envelope 受理後、driver が branch tip を rebase 済みにして起動 |
| 注入 | 変更パス一覧・selector が選定した検証コマンド列（scope×tier）・branch tip sha |
| allowlist | `Read` / `Grep` / `Glob` ＋ `Bash(<selector が列挙した検証コマンドのみ>, git status:*, git log:*, git diff:*)`。Edit/Write/git 変更/gh なし |
| skill | `verify`（§2.2-4。現行 keep・コマンド面のみ差し替え） |
| envelope | `contracts/envelopes/verify.schema.json`（check ごと GREEN/RED/INVALID＋evidence。**RED は診断しない**） |

指示文は現行 skills/verify の「入力/手順/出力」節をほぼ転用するため全文案は §2.2-4 に委ねる。
差分は 2 点のみ: (a) 単一入口が `pnpm preflight`（drop）でなく selector の出力（注入）になる、
(b) receipt 節を全廃（driver が envelope から記録する。Stop hook 廃止と同根）。
RED は run-internal で `test-triage`（1.9）へ。

### 1.5 land-review（着地 review）

| 項目 | 定義 |
|---|---|
| trigger | gh-state: `pr_open(driver 産) ∧ ¬posted(review, 当該 PR head sha)`。CHANGES 差し戻しは 2 周まで（現行 loops.md の値を継承）、以後 escalation |
| 注入 | `git diff main...HEAD` の branch diff 全文・plan 全文・該当 rubric（selector 選定・**JSON 全文注入**）・過去周回の findings 全文（**再出力させない**＝#302 二重課金の構造的封じ） |
| allowlist | `Read` / `Grep` / `Glob` ＋ `Bash(git diff:*, git log:*, git show:*)`。Edit/Write/gh/merge なし |
| skill | `review`（§2.2-5。現行 keep） |
| envelope | `contracts/envelopes/review.schema.json`（verdict: approve\|changes-needed、findings[]: {severity, file, line, what, why}）。approve 時の auto-merge arm は driver（credential 保有者）が行う |

**指示文の全文案**:

> あなたは land reviewer。注入された branch diff・plan・該当 rubric に照らし、
> **設計判断のレビューだけ**を行う。機械で測れる規範は verifier と CI が見る——再実行しない。
>
> 観点（skills/review）:
> 1. plan / 設計遵守: acceptance を満たすか。設計意図・周辺コードの慣習に沿うか。
> 2. 抜け: 未処理の分岐・エラー処理・境界条件、plan にあるのに実装されていない点、
>    挙動変更にテストが伴うか。
> 3. risk: 影響範囲・可逆性・レイヤ越境・将来機能への含み。
> 4. 注入された rubric の観点（例: harness/structural-guarantee-before-prompts）を diff に当てる。
>
> 指摘は severity（blocker/major/minor）・file:line・何が・なぜ（どの plan 項目・rubric・
> 明文原則に反するか）。それらに違反すると言えるものだけ major 以上（迷う指摘は通す）。
> 過去周回の findings は注入済み——解決済み指摘の再掲・全文の再出力はしない。
>
> 出力: 最終メッセージは `contracts/envelopes/review.schema.json` に適合する JSON のみ。
> 修正・merge・gh 操作はしない。

### 1.6 explain（教材生成・2 段）

| 項目 | 定義 |
|---|---|
| trigger | plan 段: gh-state `plan_green ∧ class=standard ∧ ¬approved ∧ ¬posted(explain-plan)`。PR 段: gh-state `pr_open(driver 産) ∧ posted(explain-plan) ∧ ¬posted(explain-pr)`（同一 Discussion へ追記＝#288）。**冪等の正は posting 台帳（DB）**——label・Discussion 検索での重複判定はしない（M1/M9、Discussion #294/#295 二重生成の封じ） |
| 注入 | plan 段: issue 本文・plan 全文・`contracts/explain-plan.json`。PR 段: branch diff・plan・plan 段教材本文・`contracts/explain-pr.json` |
| allowlist | `Read` / `Grep` / `Glob` ＋ `Bash(git log:*, git show:*)`（read-only）。gh なし（投稿は proxy） |
| skill | `explain`（§2.2-6。現行 explain-diff を 2 形態契約で再編） |
| envelope | `contracts/envelopes/explain.schema.json`（body: 教材全文 markdown・self_check[]: 契約項目ごとの pass/fail・target: {issue, discussion?}） |

**指示文の全文案**（plan 段。PR 段は「読者・節・禁則」を explain-pr.json に差し替え）:

> あなたは explainer。読者は「この task を Ready に入れるか判断する PdM」**のみ**。
> 実装者向け情報は PR 段の担当——ここに書かない。
>
> `contracts/explain-plan.json` の構造契約に従う（心がけではなく契約。各項目の自己点検
> 結果を envelope の self_check に列挙する）:
> 1. 冒頭に TL;DR 必須: この計画で何が起きるか／なぜこの task が必要か／PdM に何の判断を
>    求めるか——を数行で。
> 2. 長さ予算: 契約の字数上限以内（読了 3 分）。超過は自分で削ってから出す。
> 3. 図は意思決定に効くものだけ。増やす方向でなく、冗長な散文説明を削る方向。
> 4. 禁則: 既存文書の再叙述／出典の言い換え引用／「〜と読めるが未確認である」型ヘッジ／
>    原理・接続の解説節。
> 5. ADR との整合確認は内部検証にとどめ、**矛盾を発見した場合のみ**教材に書く。
>
> 出力: 最終メッセージは `contracts/envelopes/explain.schema.json` に適合する JSON のみ。
> body に教材全文を書く。`@file` 等の参照記法・ファイルパスによる間接指定は禁止
> （本文がそのまま投稿される）。設問を含む場合、選択肢の正解位置はあなたが決めない——
> ダミーを含む選択肢集合だけを構造化して返し、配置は機械が決める（#258 の決定的規則）。

### 1.7 watchdog（突合・補償）— **LLM なし・決定的スクリプト**

| 項目 | 定義 |
|---|---|
| trigger | cadence: 毎パス（dispatcher と同居 or 直後） |
| 実体 | 指示文なし。検査項目はデータ `contracts/watchdog-checks.json` に列挙し、決定的に実行する（prompt 依存ゼロ＝M2/M5 を LLM に任せない） |
| 権限 | DB read/write・gh **bot** credential（issues/labels/comments write。merge・admin なし）・posting proxy 呼び出し |

**検査項目表（watchdog-checks.json の中身 v0）**:

1. **3 点突合**（M2）: RunStore 起動記録 × live marker × outcome。起動記録があり live も
   outcome も無い run → dead 判定 → RunStore に記録＋対象 issue へ構造化 comment
   ＋`run:escalation`（原因非依存。信号ゼロの死を人間の質問より先に報じる＝#281 の封じ）。
2. **posting 補償**（M5/M9）: posting 台帳 ⇄ GitHub 実在の突合。台帳に「投稿済み」で実在
   しない → 再投稿（sha256 一致 comment があれば skip の冪等）。実在するが stub
   （本文長 < 契約 min・未展開 placeholder 検出）→ 補修投稿＋escalation 報告（#292/#295 の封じ）。
3. **escalation 終端補償**: 裁定 comment が付いたのに `run:escalation` が残る issue →
   label 除去（S1-3 の「永久 WAIT_PR」の封じ。逆向き——label 付与失敗の再付与——も行う）。
4. **gov:\* actor 監査**（§4.3）: 人間 allowlist 外の actor が付けた `gov:*` → 剥がす＋
   escalation 報告（承認シグナル汚染 S2-11 の構造的封じ）。
5. **投影 label 整合**: `run:*` label と導出状態のずれ → label を導出に合わせて修正
   （投影は機械の所有物。人間入力は gov:* と comment のみ）。
6. **stale 検査**（M7）: 常駐の LoopDefinition 版 vs origin/main、外部 id（盤面 option 等）の
   名前解決の再確認。ずれ → self-update 要求 or escalation（#263・#202 の封じ）。
7. **cross-machine 二重検査**（M1 残余）: 同一 issue に active run 2 件・同一対象への
   Discussion 2 本の検出 → 新しい方を close 候補として escalation（自動削除はしない）。
8. **切替検収 4 点**（keep 資産③・導入/切替時のみ）: (a) live marker 1 パス生存
   (b) runtime 応答 (c) 成果物の期限内出現 (d) outcome=success——4 点機械照合が GREEN に
   なるまで「切替完了」を宣言しない。

### 1.8 nightly-rubric（夜間 rubric 監査）

| 項目 | 定義 |
|---|---|
| trigger | cadence: nightly（1 日 1 回。dispatch は他 routine と同じ DB 一意性経由） |
| 注入 | 直近 24h の run 台帳サマリ（RunStore から機械集計）・rubric 発火/verdict 集計・main HEAD での judge 系 rubric 実行結果・posting 台帳の異常集計・rubric 48 本の index（id・origin・severity） |
| allowlist | `Read` / `Grep` / `Glob` ＋ `Bash(node <selector 後継>:*, git log:*)`（read-only 実行のみ）。**例外的に MCP `mcp__lathe__*` の read 系**（list_runs / get_run / query_findings）を許可——観測 DB への read-only 接地。書き込み系（submit_finding）は deny |
| skill | `meta-audit`＋`result-classification`（§2.2-7/8。現行 keep） |
| envelope | `contracts/envelopes/rubric-audit.schema.json`（findings[]・proposals[]: {kind: new\|revise\|retire, rubric_id?, origin, 根拠}）。投稿は proxy が報告 comment/Discussion として行い、**起票はしない**（提案止まり——rubric 改訂は監査役起草＋ゲート経由が現行統治。discipline.md の起票承認制を崩さない） |

**指示文の全文案**:

> あなたは rubric 監査係。read-only・提案のみ（起票・改訂・コード変更をしない）。
> 注入された集計と実行結果を材料に、規範（rubric 48 本）と実態の乖離を報告する。
>
> 1. gate-effectiveness: 直近 run の RED/GREEN 分布と実際の事故（escalation・rework・
>    revert）を突合し、効いていない rubric（違反が素通りした箇所）・false RED 多発の
>    rubric を挙げる。判定は result-classification の taxonomy で「何の誤りか」を必ず併記。
> 2. drift: skills の grounded_in 対象・contracts データ・playbook の実在と参照整合の破れ。
> 3. 配置規則監査: 教材の決定的配置規則（正解位置分布等）が集計上守られているか。
> 4. 提案: 新設/改訂/廃止を origin（どの事故・裁定に接地するか）付きで書く。origin の無い
>    提案はしない（rubric schema_v2 の origin 必須と同じ規律）。
>
> 出力: 最終メッセージは `contracts/envelopes/rubric-audit.schema.json` に適合する JSON のみ。

### 1.9 補助 routine（run-internal・短定義）

- **test-triage**: trigger = verify RED 直後（run-internal）。注入 = RED 一覧＋
  `design/test-failure-playbook.md` 全文＋当該 diff。allowlist = read-only（`Read`/`Grep`/`Glob`/
  `Bash(git log:*, git blame:*, git diff:*)`＋playbook 指示の再実行コマンドのみ）。skill =
  `test-triage`（現行 keep）。envelope = 既知（playbook ID＋対処結果）/新規（evidence＋仮説）の
  構造化分類。INVALID は IMPLEMENT に戻さず escalation（ADR 0022 継承）。
- **plan-decompose**（現行 plan-task 後継）: trigger = gh-state `open ∧ has(needs-plan) ∧
  ¬has(gov:hold) ∧ ¬active_run`。子 issue は envelope の children[] から **proxy が機械投函**
  （親承認済みの loop 内機械起票＝discipline.md 裁定を継承）。親 close も proxy。skill = `plan`。

---

## 2. skill 構成 v0

### 2.0 線引き原則（散文 vs データ）

ADR 0038「統治 context = 契約のデータ化」と現行 skills の実践（verify/test-triage が既に
「基準は rubric 側・台帳は playbook 側＝inline しない」を採る）を一般化する。

- **SKILL.md（散文）に置いてよいもの**: 変わらない手順・観点・判断の質・ESCALATE 条件・
  責務分離の宣言（read-only 等）。= **判断を託す場所**（rubric
  `harness/structural-guarantee-before-prompts` の origin と同じ区分）。
- **データ（JSON・contracts/）に置くもの**: 書式・schema・字数予算・禁則リスト・checklist・
  台帳・rubric 本体・envelope schema・注入契約。= **機械検証に使う正本**。SKILL.md からは
  パス参照のみ（inline 複製禁止——複製は drift 源）。
- **実在保証**: skill が参照するデータの実在は rubric（現行 `meta/verify-commands-exist`・
  `meta/triage-playbook-exists` の方式を keep）＋ CI（M13）で機械保証する。
- skill の**配送機構は runtime 非依存**: CC なら `.claude/skills/`、他 runtime なら dispatcher が
  SKILL.md 本文を prompt に inline 注入（cr-runtime 実測「codex は prompt inline で代替済み」。
  Skill 機構は必須でない——正本は repo の skills ディレクトリ 1 箇所）。

### 2.1 skill 一覧表

| skill | 状態 | 使う routine | 対応する keep 資産 |
|---|---|---|---|
| `plan` | 新設（plan-format を手順化） | plan-generate・plan-decompose | 資産④ plan 契約 6 セクション（原則の散文）＋ `contracts/plan.schema.json`（書式・スケール規則） |
| `plan-review` | 新設 | plan-review | 資産④の差し戻し基準（過小 RED・設計原則）＋ P2/P3 対策の観点 |
| `implement` | keep（現行ほぼ転用） | implement | worktree 単一 writer・main freshness・明示 add・ESCALATE 規約 |
| `verify` | keep（コマンド面のみ差し替え） | verify | 5 値報告・RED を診断しない・read-only 規律。receipt 節と preflight 節は削除 |
| `review` | keep（現行ほぼ転用） | land-review | 観点 3 点＋severity 規約＋「機械検査と重複しない」責務分離 |
| `test-triage` | keep | test-triage | playbook 参照手順・既知/新規の二分・INVALID 即 escalate |
| `explain` | 再編（現行 explain-diff を 2 形態契約に分割） | explain | 資産⑦ 教材 2 段化（#288 の 5 要件）＋ `contracts/explain-plan.json` / `explain-pr.json` |
| `meta-audit` | keep | nightly-rubric・outer の事後監査 | read-only 監査・固定 pipeline にしない |
| `result-classification` | keep | nightly-rubric・escalation 対応の判別 | taxonomy 参照＋判断の記録義務 |
| （凍結）lathe-ui | lathe 開発再開まで凍結 | — | 新基盤の routine からは参照しない |

escalation triage（資産⑤）は **skill にしない**——純関数 `classifyEscalation` をコード移送（判断でなく分類規約）。

### 2.2 各 SKILL.md の章立てと keep 資産の埋め込み先

1. **plan/SKILL.md** — 章立て: `目的と読者`（plan は PdM の判断材料）／`入力`（注入契約参照のみ）／
   `手順`（座標特定→スケール判定→選択肢→契約→検証→見積り）／`設計原則`（**plan-format.md の
   「設計原則」節の散文をここへ移送**——各原則の契機事故 1 行つき）／`ESCALATE 条件`／`出力`。
   **6 セクション定義・trivial/standard 判定・見積り正準形は `contracts/plan.schema.json` に置き、
   本文に表を複製しない。**
2. **plan-review/SKILL.md** — `責務`（判断の質のみ。書式は機械検査済み）／`観点`（1.2 の 4 点）／
   `RED findings の書き方`（再試行注入される前提の形式）／`false RED 回避`（迷ったら通す）。
   過小 RED の判定目安（scope 対比の閾値）はデータ側 `contracts/plan-review-criteria.json`。
3. **implement/SKILL.md** — 現行の章立てを keep: `main freshness`／`implementation`。追記 1 節:
   `credential 境界`（push・gh はあなたの仕事でない——M3 の宣言。実保証は allowlist）。
4. **verify/SKILL.md** — 現行から keep: `入力`／`worktree freshness 前提`／`手順`（単一入口を
   selector の出力コマンド列に差し替え）／`出力`（5 値・RED は診断しない）／`運用規範`（redirect
   禁止・cwd 固定・denied 即 escalate）。**削除**: receipt 節・preflight/run.mjs 固有記述。
5. **review/SKILL.md** — 現行から keep: `入力`／`freshness 前提`／`観点`（遵守・抜け・risk）／
   `出力`（severity 規約）／`不変の前提`（read-only・機械検査と重複しない）。追記: `過去周回
   findings は注入される——再掲しない`（#302 の運用面）。
6. **explain/SKILL.md** — 章立て: `読者定義`（plan 段= Ready 判断の PdM only／PR 段=実装理解）／
   `2 形態の分担`（#288 要件 1・2 の散文）／`生成手順`（内部検証としての ADR 整合確認を含む）／
   `自己点検`（self_check を envelope に出す義務）／`設問の作り方`（正解位置は機械が決める）。
   **字数予算・必須節・禁則 4 パターン・self_check 項目は `contracts/explain-plan.json` /
   `explain-pr.json` に置く**（#288 の教訓「形容詞注文は無効・契約は構造で」の実装形）。
7. **meta-audit/SKILL.md** — 現行 keep（tool マップ＋進め方。固定 pipeline 化しない）。
   tool マップを新 RunStore/posting 台帳の read 面に更新。
8. **result-classification/SKILL.md** — 現行 keep（taxonomy 参照・判断の記録義務。正本は
   edd-theory §結果分類のまま）。

### 2.3 contracts/ データ一覧（新設。統治 context の「契約のデータ化」実体）

| ファイル | 中身 | 由来 keep 資産 |
|---|---|---|
| `contracts/plan.schema.json` | 6 セクション定義・trivial/standard 判定条件・見積り正準形の regex | 資産④（plan-format.md。散文原則は skill 側に残し、ここは機械検査可能な部分） |
| `contracts/plan-review-criteria.json` | 過小見積り RED の目安・必須 findings 形式 | 資産④「運用」節 |
| `contracts/explain-plan.json` / `explain-pr.json` | 字数予算・必須節（TL;DR 等）・禁則 4 パターン・self_check 項目 | 資産⑦（#288 要件 1〜5） |
| `contracts/envelopes/*.schema.json` | routine ごとの出力 envelope（§3.1） | M4（新規） |
| `contracts/injection/*.json` | routine ごとの注入必須入力リスト（欠落時 spawn 拒否） | R1（#301） |
| `contracts/watchdog-checks.json` | §1.7 の検査項目・閾値 | M2/M5/M9・資産③検収 4 点 |
| `rubrics/**/rubric.json`（48 本） | そのまま移送（schema_v2・origin・checks 58・examples 込み）。**枠組み（run.mjs/select.mjs 376 行）は移送しない**——scope×tier の選定 I/F だけ後継 selector が再実装 | 資産⑥⑧ |
| `design/test-failure-playbook.md` | そのまま移送（成長する台帳。追記は監査役） | test-triage の参照先 |
| `routines/<name>.json` | §1 の routine 定義そのもの（版つき） | M7（新規） |

---

## 3. 出力契約 — Stop hook 無しの機械保証

### 3.1 envelope（構造化 verdict・成果物書式）

全 routine の最終メッセージは JSON 1 個（共通骨格＋routine 別 schema）:

```json
{
  "routine": "plan | plan-review | implement | verify | review | explain | rubric-audit",
  "issue": 123,
  "run_id": "<注入値をそのまま返す（取り違え検出用）>",
  "verdict": "<routine 別語彙: GREEN|RED / approve|changes-needed / done>",
  "summary": "1〜3 行",
  "artifacts": [{ "kind": "plan|explain-body|findings|...", "body": "<全文をここに>" }],
  "escalate": { "class": "context|environment|decision", "reason": "..." }
}
```

- 成果物は **body に全文**（ファイルパス・`@file`・「transcript を見よ」参照を schema レベルで
  禁止＝P1/F2 の封じ）。
- verdict 語彙は enum で schema 固定（散文 verdict の parse を廃止）。

### 3.2 検証チェーン（生成時の保証）

1. runtime の構造化出力機能が使える場合はそれを第一層にする（D1 未決のため runtime 別:
   自作/API 直なら response schema 強制、CC なら最終メッセージ抽出→ajv validate。**未確認**:
   CC headless の schema 強制出力の可否——D1 の判断材料に含める）。
2. **parse→validate 失敗 = UNPARSABLE**: validation エラー全文＋schema を注入して
   **bounded retry 最大 2 回**（現行 `runStageWithUnparsableRetry` の原則を keep。三分岐の
   `context` を出口前に吸収する、という規約も keep）。
3. 上限超過 → `decision` escalation（§1.0）。
4. Stop hook との差: 正常系は 1 回生成で終わる（hook 方式は完了済み出力の全文再生成を毎回
   強制し二重課金＝#302。本方式の再生成は**失敗時のみ・上限つき**）。

### 3.3 投稿と post-check（配信時の保証）

1. **render は決定的**: proxy（driver/orchestrator 側・credential 保有）が envelope から
   comment/Discussion 本文をテンプレート**関数**で組み立てる（LLM は組み立てに関与しない）。
   設問の選択肢配置など機械で決められる配置はここで決定的規則により確定（R4・#258）。
2. **投稿前**: posting 台帳（DB）に intent 行を書く（target・kind・sha256(body)）。
3. **投稿**: gh REST（GraphQL の label 系は Projects classic 廃止エラーの癖 Q5 があるため
   REST を既定に——keep 資産の癖台帳より）。
4. **投稿直後 post-check（M9）**: 返却 id を GET で再取得し、(a) 実在 (b) 本文長 ≥ 契約 min
   (c) 未展開 placeholder（`@file` 等の regex）不在 (d) 対象 issue/PR/Discussion id 一致
   (e) 教材は必須節見出しの存在——を機械照合。pass で台帳 status=confirmed。
5. **失敗時**: 例外・post-check fail とも台帳 status=failed＋エラー全文を記録して継続。現行「非致命
   continue」との違いは**台帳に必ず残る**こと。失敗の参照は台帳 id のみ指す（S1-3 の封じ）。
6. **stage 終端の定義**: 「envelope 受理＋台帳 confirmed」まで（M5）。confirmed 未達の run は
   done 扱いにしない（watchdog 補償対象として残る）。

### 3.4 watchdog 補償（事後の保証）

§1.7-2/3 のとおり: 毎パス、posting 台帳 ⇄ GitHub 実在を突合し、missing は sha256 冪等で再投稿・
stub は補修・label 遷移の失敗は再適用/除去。**3 層（生成時→配信時→事後）のどれが落ちても「正本に
成果物がある」状態へ収束する**——これが Stop hook（生成時 1 層・確率的）の置き換えである。

---

## 4. 統治 label 語彙 v0

### 4.1 namespace と語彙表（提案）

| label | 付与者（正） | 意味 | trigger での役割 |
|---|---|---|---|
| `task` | 人間 or 承認済み機械投函（proxy） | task の印（現行 task-request 後継。issue=task・TASK-N=#N は ADR 0031 keep） | 全実装系 routine の必要条件 |
| `needs-plan` | 起票者 | 分解型 task | plan-decompose の trigger |
| `gov:approve` | **人間のみ** | 実装解禁（現行 Ready 相当の承認入力） | implement の trigger（actor 検証つき＝§4.3） |
| `gov:hold` | **人間のみ** | dispatch 一時停止（故障に数えない＝ADR 0037 keep） | 全 gh-state trigger の除外条件 |
| `gov:p1` / `gov:p2` / `gov:p3` | **人間のみ** | 優先度（R8。「p1-high（label 未作成のため body 記載）」退避の解消） | dispatcher の候補ソート順 |
| `gov:require-approval` | **人間のみ** | trivial でも承認必須に強制（任意・上書き用） | implement trigger の追加条件 |
| `run:escalation` | **機械のみ**（proxy/watchdog） | 裁定待ち（PdM の attention 面） | escalation 対応 loop の入力・実装系 trigger の除外条件 |
| `run:explained-plan` / `run:explained-pr` | **機械のみ** | 教材投稿済みの**投影**（正は posting 台帳。現行 done-explain 後継） | 人間の可読性のみ。trigger は台帳を見る——label を冪等判定に使わない（M1） |
| `run:blocked` | **機械のみ** | blocked-by 未解消の投影 | 可読性のみ |

原則: **進行状態の label は作らない**——ADR 0031/M10（参照 PR open=In Progress／merge close=Done
の導出）を維持。label に持つのは (a) 人間の承認入力 `gov:*` (b) 導出不能な例外 `run:escalation` (c) 純投影のみ。

### 4.2 状態遷移図（label・承認・run の重ね書き）

```
[起票: 人間 or 承認済み機械投函]  label: task (+needs-plan / +gov:pN / +gov:require-approval)
        │
        ├─ has(needs-plan) ─► plan-decompose ─► 子 issue 投函(proxy)＋親 close
        ▼
   plan-generate → plan-review（run 内・label 遷移なし。状態は RunStore）
        │ GREEN                                   │ RED×3 / decision
        ├─ class=trivial ∧ ¬gov:require-approval ─┐│
        ▼                                         ▼▼
   explain(plan 段) 投稿                    run:escalation 付与(proxy)
        │ posted(explain-plan)                    │
        ▼                                         ▼
   ［人間: gov:approve 付与］◄── 裁定 comment ──［PdM: escalation を読む］
        │ approved（actor 検証 pass）              │ 裁定 comment 検出
        ▼                                         └► watchdog が run:escalation 除去
   implement → verify → (RED→test-triage→再試行) → driver が PR 作成(proxy)
        │ pr_open 導出 = In Progress → In Review（label なし・導出のみ）
        ▼
   explain(PR 段) 追記 → land-review → approve → proxy が auto-merge arm
        │ CI GREEN（PR+CI 単一着地ゲート・ADR 0026 keep）
        ▼
   merge → issue close ＝ Done（導出。close label なし）

横断: gov:hold は全遷移を停止（除外条件）。watchdog は毎パス
      「gov:* actor 監査／run:* 投影補正／escalation 終端補償」を重ねる。
```

### 4.3 権限分離の機械実装（PdM/監査役の label 操作 vs agent の label 操作）

prompt・運用規範に置かず、3 層の機械で分離する（M3 fail-closed）:

1. **credential 分離**: harness は専用 machine account / GitHub App の token（issues write=
   triage 相当のみ。merge は proxy の別 scope・admin なし）。inner 実行体（routine の agent）は
   **token を持たない**（allowlist に gh が無い——§1 の全 routine）。PdM・監査役は人間アカウント。
2. **actor 検証（承認の効力判定）**: dispatcher は `gov:*` の**存在**でなく、issue timeline の
   `labeled` イベントの **actor が人間 allowlist に含まれる最新イベント**を効力の根拠にする。
   bot が `gov:approve` を貼っても trigger は真にならない（存在≠承認）。承認シグナル汚染
   （S2-11・ADR 0034 §4 が自認した「行動規範のみ」の限界）の構造的封じ。
   **未確認**: timeline API の labeled イベント actor の網羅性（ページング・App actor の表現）——
   M12 の contract test 第 1 号とし、導入前に実測する。
3. **watchdog 補償**: allowlist 外 actor の `gov:*` は剥がして escalation 報告（§1.7-4）。
   人間が `run:*` を触った場合は導出から再計算して戻す（§1.7-5）——「人間の入力面は gov:* と
   裁定 comment のみ」を双方向に機械維持する。

### 4.4 D2（GitHub 依存度）未決との関係

本 v0 は「承認入力 = `gov:approve` label（actor 検証つき）」を正案として書いた。現行の
Projects 盤面 Ready 列（ADR 0035）を続ける裁定になった場合も、§1 の trigger 式は述語
`approved` の実装 adapter（label 版／Ready 列版／ADR 0038 の「意図を DB に書く」UI 版）を
差し替えるだけで成立する——**trigger 式・routine 定義は承認面の実装から独立**させてある。
盤面継続の場合、Ready 移動の actor 検証は Projects の item 変更イベントで同型に行う
（**未確認**: Projects v2 API での actor 取得可否——同じく contract test 対象）。

---

## 5. 未確認・推測の明細（本書内の設計提案が依存する仮定）

1. runtime（D1）未決——allowlist は CC 語彙の例示。CC headless の出力 schema 強制の可否は**未確認**（§3.2）。
2. timeline `labeled` の actor・Projects v2 の actor 取得は**未確認**（§4.3/4.4。M12 contract test の第 1 号）。
3. rubric selector（run.mjs/select.mjs 後継）の設計は scope 外——「scope×tier で rubric 集合と
   コマンド列を返す I/F」の存在だけを仮定（§1.4/1.5/1.8）。
4. 検収 4 点・教材 2 段化・escalation triage は基準/実装は接地済みだが**適用実績なし**（材料 §6-7）。
5. label 名（`gov:`/`run:`・`task`）は新規提案。既存 label（task-request 等）からの移行手順は含めない。
6. 差し戻し 2 周・plan 再試行 2 回・dispatch 上限等の数値は現行 loops.md 値の継承——新基盤で再測定対象。
