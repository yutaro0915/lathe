# GitHub 連携 不具合台帳（実測・2026-07-08）

対象 repo: `yutaro0915/lathe`（読み取りのみで作成。書き込み・コメントは一切行っていない）。
根拠の記法: issue/PR/Discussion 番号・ファイルパス:行・コマンド出力。確認できなかった項目は「未確認」と明記。

---

## 1. Discussion の重複・増殖の機械照合

### 1.1 全量列挙（gh api graphql・createdAt 昇順）

`gh api graphql --paginate`（repository.discussions、number/createdAt/category/closed/body 長）で全 **26 件**を取得。
内訳: category **Explain 25 件・General 1 件（#251）**。closed=true は 7 件（#154/#159/#164/#172/#174/#181/#196、いずれも 07-07 前半までの初期分）。

### 1.2 確定した重複・破損（機械照合の結果）

| 種別 | Discussion | 対象 issue | 事実 |
|---|---|---|---|
| **重複生成** | **#294 と #295** | issue #281 | 同一 issue の解説が **8 秒差で 2 本**生成（#294 = 2026-07-08T05:40:16Z・本文 17,710 字／#295 = 05:40:24Z・**本文 64 字**）。両方 open のまま |
| **破損 stub** | **#295** | issue #281 | 本文が literal の `@explains/2026-07-08-issue281-dispatch-silent-death-detection.md` のみ（`@file` が展開されず文字列のまま投稿） |
| **破損 stub** | **#292** | issue #288 | 本文 59 字 = `@explains/2026-07-08-issue288-two-stage-explain-material.md` のみ。**#288 の教材 Discussion はこの壊れた 1 本だけ**＝PdM 承認ゲートの読み物が実質存在しない |
| **重複未遂** | #276 | issue #236 | 2 回目の explain run が「投稿直前に既存 #276 に気づき二重投稿を回避」（`.lathe/runs/explain-236.log:63,75`）。**機械 guard でなく agent の自主チェックで回避**＝#281 では回避されず #295 が生まれた |

explains/ 正本（23 ファイル）⇄ Explain Discussion（25 本）の突合: 差分 2 本 = #295（重複 stub）と #303（issue #301 教材、正本ファイルは未 merge）。#292 は正本ファイルなしの stub。

### 1.3 増殖の機構（一次証拠つき）

- **同一 issue への EXPLAIN 二重 dispatch の実測**: Mac の `.lathe/logs/orchestrator.log:1770-1791` — `DISPATCH EXPLAIN #236` が **03:09:29 と 03:14:32 の連続パスで 2 回**発火。`.lathe/runs/outcomes.jsonl` に `EXPLAIN #236 success` が 2 件（03:17:50 / 03:20:11）。1 回目の走行中に live marker が実行中と判定されず（issue #281 がまさに「dispatch 即死検知 — 起動記録×live marker×outcome の突合」を起票）、evidence（done-explain label／explains/ 正本の merge）が付く前の窓で classify が再発火した。
- **classify の判定式**: `scripts/orchestrator-classify.mjs:129-134` — EXPLAIN = needs-review × done-explain label なし × explains/ 正本なし。**「生成完了」の証拠が GitHub に着地するまで毎パス再発火する**構造。
- **evidence が着地しない既知 edge**: `scripts/orchestrator-explain.mjs:13-14` — skill の label 遷移は「**needs-explain が無いと done-explain も付かない**」edge を持つ（2026-07-07 実測）。加えて `gh issue/pr edit`（GraphQL）が label 付与で失敗する（§2）。
- **対処の履歴**: commit `eca8247`（PR #209、2026-07-07 19:54 JST）「教材 dispatch 完走後処理 — explains/ 自動 PR・done-explain 冪等付与・**重複生成防止**」で 2 層 guard（label または explains/ 正本）＋REST 冪等付与＋repair を追加。**しかし #294/#295 の重複はその後（07-08 05:40 UTC）に発生**＝窓は塞がり切っていない。07-08 は case 常駐（#236、Discussion #276）と Mac launchd が併存した時期で、cross-machine の排他は issue #237（open・hold）が計画中。

### 1.4 「無限に生成」への照合結果

現存する重複は #294/#295 の 1 組（＋#236 の未遂 1 件、stub #292）。「無限」は現存 Discussion 上では確認できないが、**再発火条件（evidence 未着地×毎 5 分パス×guard なしの窓）は log で実証済み**であり、evidence 付与が失敗し続ければパスごとに 1 本ずつ増殖する構造は現存する。削除済み Discussion の有無は API から確認不能（未確認）。

---

## 2. label 貼付失敗の痕跡（grep 集計）

### 2.1 run ログの実測

`grep -rniE "could not add|warning.*label" .lathe/runs/*.log`:

- `issue-229.log:43` — `[inner-loop] warning: could not add escalation label to issue #229 (continuing)`
- `issue-229.log:44` — `[inner-loop] warning: could not post escalation report comment on issue #229 (continuing)`

該当は 2026-07-07T14:30 の LAND_REVIEW escalation。**今日時点の issue #229 は labels=[task-request] のみ・escalation report comment 不在**（gh issue view 229 で照合）＝失敗は自己修復されず恒久化。しかも終了メッセージは「see the escalation report comment on issue #229」と**存在しない comment を指す**（`issue-229.log:45`）。

### 2.2 原因系と構造的傍証

- **付与経路が失敗しやすい API を使用**: `scripts/inner-loop-escalation.mjs:84` は `gh issue edit --add-label` を使う。一方 `scripts/orchestrator-explain.mjs:136-138` は「**GraphQL 系（gh issue/pr edit）は Projects classic 廃止エラーで失敗する（2026-07-07 実測）ため REST を使う**」と明記して REST POST に移行済み。escalation 側は未移行。
- **失敗が常態である傍証**: done-explain には失敗窓の自己修復関数 `needsDoneExplainRepair`（`orchestrator-explain.mjs:151-`「完走後処理の label POST が失敗した窓の自己修復」）が実装されている。
- **label 遷移の設計 edge**: `orchestrator-explain.mjs:13-14` — needs-explain が付いていない issue には skill が done-explain を付けない（2026-07-07 実測）。orchestrator 起点の explain は needs-explain を経由しないため、この edge を毎回踏む。
- **優先度 label の不在**: AGENTS.md は「needs-plan/escalation/**優先度=label**」と規定するが、`gh label list` に priority 系 label は存在しない（実在: needs-plan/task-request/needs-explain/done-explain/needs-review/escalation/hold ＋ GitHub 既定 9 種のみ）。issue #98・#102 は本文冒頭に「**p1-high（label 未作成のため body 記載）**」と退避している。

---

## 3. 既知の gh 仕様癖の台帳（実際に踏んだもの）

| # | 癖 | 実例（一次証拠） | 対処 |
|---|---|---|---|
| Q1 | **auto-merge は branch protection（required checks）が無いと arm 不可**。checks の無い PR は即「clean status」になり `enablePullRequestAutoMerge` が GraphQL エラー | issue #94 本文（2026-07-05、TASK-20 = PR #93 の MERGE 段 escalation で実証） | checks 待ち→直接 merge の fallback（#94）。現在は PASS 時のみ arm（`inner-loop-land.mjs:274`） |
| Q2 | **PR 作成直後の `gh pr checks --watch` は「no checks reported」で非ゼロ終了**し、CI が実際は pass でも merge 拒否（false negative） | issue #98 本文（2026-07-05、TASK-23 = #97 で実証） | checks 出現までポーリングしてから watch（#98） |
| Q3 | **`gh pr merge --delete-branch` は worktree が checkout 中の branch を消せず、PR 自体は merge 成功でも非ゼロ**→偽陰性 escalation | issue #102 本文（2026-07-05、TASK-24 = #101 で実証。エラー: `cannot delete branch 'inner/task-N' used by worktree`） | `--delete-branch` を撤去（#102） |
| Q4 | **Projects V2 の盤面列再構築で Status option id が全再生成**され、id 直書きの Ready 検出・投影が silent に死ぬ | issue #202（hotfix、2026-07-07 incident）・commit `afc67c1`／恒久対処 `0c05d73`。`scripts/inner-loop-projects.mjs:8-13` に incident 記載 | option id を毎パス名前解決（#201 分解 5）、失敗時は投影 skip（非致命） |
| Q5 | **`gh issue edit` / `gh pr edit` の label 操作が「Projects classic 廃止」の GraphQL エラーで失敗**（2026-07-07 実測） | `scripts/orchestrator-explain.mjs:136-138`・`orchestrator-explain.test.mjs:122`・`.claude/skills/explain-diff/SKILL.md:92-93` | REST `POST /repos/…/issues/N/labels` へ移行（冪等・既付与でも 200）。escalation 経路は未移行（§2.2） |
| Q6 | **claude-code-action が `discussion_comment` イベントを拒否** | commit `90c3a93`／`e63ad07`「fix(runner): claude-discussions を CLI 直接実行に — action が discussion_comment を拒否するため（実測）」（2026-07-07） | workflow 内で CLI 直接実行（`.github/workflows/claude-discussions.yml`） |
| Q7 | **Discussion 本文の `@file` は展開されず literal 文字列のまま投稿される**（`gh api -f` は `@` 展開しない。`-F` のみ展開） | Discussion #292・#295 の本文が `@explains/….md` そのもの（§1.2） | 未対処（stub 2 本が現存） |
| Q8 | **service token の UUID/client_id 混同** | repo（scripts/adr/design/docs/ops/apps）と issue/PR の横断検索（`client_id` / `service token` / `UUID`）で一次証拠なし | **未確認**（本 repo では踏んだ痕跡を発見できず） |

補足（癖ではないが関連障害）: dispatch の silent death（起動 log はあるが marker/outcome が残らない）は issue #281 が起票済み。stage の API エラー（接続系）での dead-driver は issue #254（open）。

---

## 4. 「GitHub を盤面・状態導出・着地ゲートに使う」設計の脆弱点（実測からの帰納）

1. **導出状態の証拠着地ラグが再実行の窓になる**（ADR 0031「状態は保存せず gh から導出」の裏面）。「教材あり」の証拠 = label 付与＋explains/ 正本の PR merge であり、生成完了から証拠着地まで数分〜CI 時間の窓が空く。その間 classify は毎 5 分パスで同じ仕事を再発火する。実測: EXPLAIN #236 二重 dispatch（orchestrator.log:1770-1791）→ Discussion #294/#295 の実重複。dedup 強化（eca8247）後も再発した。
2. **書き込み失敗が「非致命 continue」で握りつぶされ、導出の前提（label が真実を写す）が壊れたまま系が進む**。escalation label＋comment の両方が失敗した #229 では、queue の SKIP_ESCALATION も PdM への signal も成立せず、エラーメッセージは存在しない comment を指した。冪等 repair は done-explain にしかない。
3. **GitHub 側の識別子・API 挙動を「安定契約」と仮定した箇所が全て壊れた**。option id は人間の盤面操作（列再構築）で全再生成され（#202）、gh の GraphQL 経路は deprecation で突然死し（Q5）、auto-merge は branch protection という repo 設定に暗黙依存する（Q1）。各個は名前解決・REST 化・fallback で塞いだが、**外部仕様変化を検知する面（contract test）が無く、毎回 silent 障害→実測→hotfix の順**になっている。
4. **着地ゲート（PR＋CI＋auto-merge）が evidence 経路と直列結合している**。explains/ 正本は自動 PR の merge 後にしか file evidence にならないため、CI の遅延・auto-merge の癖（Q1/Q2）がそのまま重複生成リスクに転化する。ゲートの信頼性問題が観測（dedup）の問題に波及する構造。
5. **投稿内容の検証層が無い**。GitHub は body を検証しないため、`@file` 未展開の stub（#292/#295）がそのまま「教材 Discussion」として盤面上の承認材料になる。承認ゲートの入力（PdM が読む読み物）の実在・可読性を機械照合する post-check が無く、#288 は壊れた教材のまま needs-review に載っている。

---

## 付録: 検証に使った主なコマンド

- Discussion 全量: `gh api graphql --paginate -f query='… discussions(first:100) { nodes { number title createdAt closed category{name} body } } …'`
- label 失敗 grep: `grep -rniE "could not add|warning.*label" .lathe/runs/*.log`
- 二重 dispatch: `grep -n "EXPLAIN #236" .lathe/logs/orchestrator.log` / `grep EXPLAIN .lathe/runs/outcomes.jsonl`
- 癖の一次証拠: `gh issue view 94 / 98 / 102 / 202 / 229 / 237 / 281 / 288`、`git show -s eca8247 afc67c1 0c05d73 90c3a93`
- label 実在: `gh label list --limit 50`
