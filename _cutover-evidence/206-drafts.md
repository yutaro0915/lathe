### 子 issue ドラフト 1

Title: inner spawn に inner-settings を明示 pin（cwd 非依存で outer 層を拾わせない）
Blocked-by: A（監査役・INNER_SETTINGS_PATH を確定する未起票の親）
Touches: scripts/inner-loop-backends.mjs, scripts/inner-loop-stage-runner.mjs, scripts/orchestrator.mjs

1. **問題** — inner agent が受け取る settings は cwd 依存（worktree の `.claude/settings.json` を暗黙 load）。driver が想定外 cwd（例：repo root で誤起動）で spawn すると outer 層（統治 hook）を拾いうる。設計注記 §belt&braces #3「spawn に `--settings` で inner settings を明示 pin（cwd 非依存の保証）」の実装。座標：`scripts/inner-loop-backends.mjs::buildClaudeArgs`（現状 `--settings` 無し）・`orchestrator.mjs` の driver/EXPLAIN spawn。
2. **選択肢** — (1) 現状の cwd 依存暗黙 load 継続：却下＝cwd 非依存の保証が型的に無い。(2) 全 spawn argv に `--settings <inner path>` を明示付与：採用＝cwd に依らず inner harness を pin。(3) 環境変数で切替：却下＝flag より暗黙で漏れ検知が効かない。
3. **方針** — inner settings path を**単一定数として 1 箇所で定義**し、`buildClaudeArgs`・codex spawn・`orchestrator.mjs` の claude spawn・driver spawn がすべてその 1 入口を参照する（薄い糊層を新設せず、同一情報の入口を 1 つに保つ）。#201 の orchestrator spawn 設計と統合する（新しい実行経路を作らず既存 spawn 仕様へ argv を足す）。
4. **契約** — `buildClaudeArgs(stage, prompt, resumeSessionId)` の戻り argv に `--settings <INNER_SETTINGS_PATH>` を含める。**`INNER_SETTINGS_PATH` の値は A が確定する**（inner 純化後の tracked settings ファイルのパス）。この定数の identity と `--settings` が settings.local の merge を抑止するか否かは A の移設結果に依存するため、A 未確定のまま本 issue の契約は閉じない（＝Blocked-by A）。型を変えたくなったら ESCALATE。
5. **検証** — unit：全 spawn ビルダの argv に `--settings <INNER_SETTINGS_PATH>` が入ることを assert（`inner-loop-backends.test.mjs`・`orchestrator.test.mjs`）。統合は子 issue D が担う。

### 子 issue ドラフト 2

Title: 物理分離の機械検証 — inner worktree に統治 hook が掛からず repo root には掛かる
Blocked-by: A（監査役・未起票）, plan#1
Touches: scripts/

1. **問題** — 設計の効き（「worktree checkout には tracked .claude/ しか含まれない → inner は統治 hook を物理的に受け取れない」「repo root の outer だけが local 層を重ねる」）を回帰で担保しないと、将来の設定改変で silent に破れる。**加えて実測で反証を発見**：`.claude/worktrees/agent-a45116b314fc4237e/.claude/settings.local.json` が実在し、何かが worktree 内に `settings.local.json` を書いている疑いがある。設計前提が既に破れていないかを機械で潰す必要がある。
2. **選択肢** — (1) 目視確認のみ：却下＝回帰にならない。(2) 機械テストで (a) inner spawn の実効 settings に統治 hook が無い、(b) worktree checkout に統治 `settings.local.json` が同梱されない、(c) repo root では issue-create-guard が発火する、を照合：採用。(3) e2e で実 claude を起動して確認：却下＝重すぎ・非決定的。scripts/ の pure 検証で足りる。
3. **方針** — `scripts/` に検証スクリプト／test を新設。git 管理境界（`git ls-files` で `.claude/settings.local.json` が untracked であること）・worktree 生成物の実測（stray `settings.local.json` の不在確認と、在る場合の生成元特定＝driver か手動か）・spawn argv（plan#1 の pin）を機械照合する。実 hook 発火の断定は input 注入で issue-create-guard.mjs の判定関数を単体駆動する形に留める（forbidden path の**編集はせず参照検証のみ**）。
4. **契約** — 契約面（型・schema）には触れない検証専用スクリプト。AC：(a) untracked 境界照合が GREEN、(b) worktree に統治 `settings.local.json` が無い（在れば生成元を issue 化）、(c) repo root で issue-create-guard 判定が ask を返す。
5. **検証** — 新 test を `pnpm test`（unit tier）に載せる。A の移設が済むまで (a)(c) は RED になりうる（統治 hook がまだ settings.json 側にある間）ため、**A 着地後に投函・GREEN 確認**する。

### 子 issue ドラフト 3

Title: 経緯追随 — 2026-07-02 の意図的保留の解除を agent-workflow.md に記録
Blocked-by: A（監査役・未起票）, B（監査役・未起票）
Touches: design/agent-workflow.md

- **問題** — `design/agent-workflow.md` §「保留（意図的な deferral・2026-07-02）」は、解除トリガー (a) hooks 管理が面倒になった時 / (b) 役割 .md に provider 別分岐が必要な時 / (c) 第 3 provider を足す時、を明記している。2026-07-07 に (a) が #206 で発火し、inner/outer harness の物理分離で解消したため、保留節を現行化しないと台帳が古いままになる。
- **修正方針**（trivial・軽量形）— 保留節に「解除：2026-07-07 #206 にて (a) hooks 管理の破綻が発火。tracked=inner／untracked=outer の物理分離（A・B）で解消。制約『inner/outer harness 分離を壊さない』は充足」を追記（既存記述は消さず注記追加）。**保留節が記述する分離（A・B）が実際に着地してから**投函・記録する（未着地状態を「解消済み」と書かない）。
- **検証** — doc-only。`pnpm preflight --quick` 相当のみ。機械 gate 対象外（散文追随）。

---

## PdM への確認事項

- (Q1) A・B を監査役セッションへ routing する方針で合意いただけますか（本 issue の load-bearing な核心・forbidden path）。
- (Q2) B の価値判断（meta-audit 等監査系を inner harness から除外するか）は監査役裁量に委ねますか、PdM が先に方針を示しますか。
- (Q3) A 確定後、C→D→E の順で planner が投函する前提でよいですか（C/D/E の Blocked-by が未起票の A/B を指すため、今は投函保留・ドラフトのみ）。
- (Q4) D で発見した worktree 内 `settings.local.json` 実在（設計前提への反証）は、本線に取り込みますか、別 issue で先に生成元を潰しますか。
