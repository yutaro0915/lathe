調査結果を接地に、issue #171 の plan を作成しました。以下が成果物です。

---

## 接地サマリ（調査で確定した現状）

- **常駐は 1 プロセスのみ**: `scripts/orchestrator.mjs`（launchd `ops/launchd/com.lathe.orchestrator.plist`・`StartInterval 300`・Mac 稼働中）。driver(`inner-loop.mjs`)・review engine(`review-engine.mjs`)・explain(`claude -p`) は**毎パス spawn**（`orchestrator.mjs` 行 206-219）。
- **排他は単一マシン前提**: `.lathe/orchestrator.lock`（PID・行 54,90-118）＋ `.lathe/runs/live-*.json` live マーカー（PID 生存確認・行 160-169）。**いずれもローカル FS 上のファイル**＝別マシンの orchestrator とは共有されない。導出 status（参照 PR open=In Progress・ADR 0031 §2）は cross-machine でも効くが、spawn〜PR 生成の間に race window が残る。
- **ingest は同一 FS 前提（(X) 経路・ADR 0001）**: `notify.ts` は `os.homedir()` 基準の allowlist（`apps/web/scripts/ingest/notify.ts` L80-95）で **transcript 実体をローカル FS から read**（L168-175）。`discover-dirs.ts` も `path.join(os.homedir(), '.claude','projects')`（L99-100）。DB は `postgres://…@localhost:55432/lathe`（`lib/postgres.ts` L11）。**push content 変種は ADR 0004 で MVP 外として明示保留**。
- **hold は未実装**: `blocked-by #N` は `parseBlockedBy`（`inner-loop-core.mjs` 行 231-244）で処理されるが、明示 hold/blocked label は無い。
- **SSH 最小権限起動の precedent**: `.claude/skills/explain-diff/SETUP.md §6` の `claude -p … --allowedTools …` 形。`#224`（inner spawn へ `--settings <INNER_SETTINGS_PATH>` を明示 pin）は**実装中**＝case 側 orchestrator が inner を spawn する前提に効く。
- **旧 body 依存の読み替え**: 本文の `#116/#128/#117` は #201 以前の部品構成。PdM 最新裁定（13:26:57Z）で orchestrator は既に稼働＝これらは実質 superseded。移設の実効ブロッカーは **#224**（settings pin）。この読み替えの当否は下段 ASK_PDM D3 で確認します。

以下、子 issue 群（トポロジカル順）。plan#5 の契約は下段 **D1**、plan#7 の設計は **D2** の PdM 裁定に依存します。

---

Title: SSH 越し case task 受け渡し機構（Mac 側・最小権限 claude 起動形）
Blocked-by: none
Touches: scripts/case-dispatch.mjs, design/runbooks/case-remote-tasks.md

### 問題
case 実機の導入・構築は Mac から直接行わず、SSH で case 上の Claude Code に task を渡して case 側で完結させる（PdM 裁定 13:47:06Z）。その受け渡し機構が repo に無い。以降の case 側タスク（recon・orchestrator 導入）はこの機構を土台にする。

### 選択肢
- (A) 素の `ssh case '…'` を各所に手書き — 却下: 最小権限指定が散逸し再現不能。
- (B) `scripts/case-dispatch.mjs` に集約（採用）— 起動形・allowedTools・repo/issue 読み込みを 1 入口に。SETUP.md §6 と同型で min-permission を型で表現。

### 方針
1 入口 CLI。task 本文と対象 issue 番号を受け、case 上で `cd <repo> && claude -p "<task>"` を最小権限で起動する。case 側 claude は `gh` で対象 issue を読み実装まで完結する。到達性（ssh alias `case`・鍵）は環境事実（ASK_PDM）。

```
ASCII:
  Mac: case-dispatch.mjs --issue <n> --task-file <path>
        └─ ssh case 'cd $REPO && claude -p "$TASK" --allowedTools <SET> [--settings <path>]'
                                   └─ case 上 claude が gh で #n を読み実装
```

### 契約
```ts
// scripts/case-dispatch.mjs の公開シグネチャ（呼び忘れで権限が緩む設計にしない＝allowedTools は必須・既定は最小）
function dispatchToCase(opts: {
  issue: number;                 // 対象 issue（case 側が gh view する）
  taskPrompt: string;            // claude -p に渡す本文
  allowedTools: string[];        // 必須。空は不可。SETUP.md §6 と同型の最小集合
  repoDir: string;               // case 上の repo 絶対パス（recon で確定した値）
}): Promise<{ exitCode: number; log: string }>;
```
allowedTools は optional にしない（opt-in で権限が広がる API を作らない）。既定値は与えず呼び出し側に明示させる。

### 検証
- unit: `dispatchToCase` が組み立てる argv に allowedTools が必ず含まれ、欠落時は throw することを assert。
- 実 artifact 照合: `scripts/case-dispatch.mjs --issue <本 issue> --task-file <hello>` で case 上 claude が起動しログを返すことを 1 回実行確認（到達性確認後）。
- gate: `pnpm preflight --fast`。

---

Title: 実装 hold 機能（orchestrator が hold label の issue を dispatch しない）
Blocked-by: none
Touches: scripts/orchestrator-classify.mjs, design/loops.md, adr/0036-hold-label.md

### 問題
特定 issue を driver/queue に拾わせない明示的 hold が無い（現状は `blocked-by #N` 依存解決のみ・`parseBlockedBy` 行 231-244）。PdM 追加構想 2 点目の要求。

### 選択肢
- (A) issue を close して退避 — 却下: 導出 status を汚す（Done と混ざる）。
- (B) 新 label `hold` を classify が WAIT_HOLD として skip（採用）— `escalation` の WAIT_ESCALATION と同型で最小差分。機械が読む入力が 1 つ増えるため ADR で記録（Ready＝ADR 0035 と同じ扱い）。

### 方針
`orchestrator-classify.mjs`（行 78-124）の判定順で、`task-request` 確認直後・`escalation` と同層に `hold` 判定を追加。`hold` があれば `WAIT_HOLD`（故障に数えない・dispatch しない）。既存 `blocked-by #N` はそのまま。label 台帳（`design/loops.md` 行 30-38）に `hold` を追記。ADR 0036 で「機械が読む入力に `hold` を追加」を記録。

### 契約
- label 名 = `hold`（機械可読入力・実装者は変更不可。変えるなら ESCALATE）。
- classify 分類子に `WAIT_HOLD` を追加。既存 decision enum の互換を壊さない（追加のみ）。

### 検証
- unit: `orchestrator-classify` に `hold` label 付き fixture を与え `WAIT_HOLD` を返す／breaker に数えないことを assert。
- gate: `pnpm preflight --fast`。

---

Title: case 環境事実の recon タスク（case 側 claude 実行・SSH 経由）
Blocked-by: plan#1
Touches: design/research/2026-07-07-case-environment.md

### 問題
systemd unit・導入 script・ingest 配線の契約は case の環境事実（OS/init 系・node/pnpm/gh/claude の導入と認証・repo clone・`~/.claude` の場所・Docker/Postgres）に依存する。plan は case に到達できないため、recon タスクを case 側で実行して事実を確定する。

### 選択肢
- (A) PdM に全事実を質問 — 却下: 多くは case 上で機械的に確認できる（質問は bootstrap 3 点＝ASK_PDM に絞る）。
- (B) recon タスクを case 側 claude に実行させ結果を repo に記録（採用）。

### 方針
plan#1 の機構で read 系最小権限 task を送り、case 上で `uname`/`systemctl --version`/`node -v`/`pnpm -v`/`gh auth status`/`claude` 認証確認/clone 場所/`~/.claude/projects` 有無/Docker・Postgres 状況/常時稼働性を収集し、`design/research/2026-07-07-case-environment.md` に事実表として記録する（結論・設計判断は書かない＝事実のみ）。

### 契約
記録ファイルは事実表（項目・値・確認コマンド）のみ。後続 issue（plan#4/#5）はここを座標として参照する。

### 検証
- 実 artifact 照合: 記録ファイルに 10 項目（OS/init/node/pnpm/gh/claude/repo/`~/.claude`/DB/常時稼働）が埋まっていること。
- gate: なし（ドキュメントのみ）。lint 通過。

---

Title: case 向け systemd unit ＋ 導入/検証 script（Mac 側 repo 成果物）
Blocked-by: plan#3
Touches: ops/systemd/lathe-orchestrator.service, ops/systemd/lathe-orchestrator.timer, ops/install/case-setup.sh

### 問題
launchd plist（`ops/launchd/com.lathe.orchestrator.plist`）は macOS 専用で case（systemd 想定）に流用不可。5 分間隔・WorkingDirectory・PATH・stdout/stderr・node 絶対パスの等価物を systemd で表現する必要がある。

### 選択肢
- (A) `Type=oneshot service + timer(OnUnitActiveSec=5min)`（採用）— launchd `StartInterval 300` の素直な等価。1 パス 1 プロセスを timer が保証し、既存の lock と二重防止が整合。
- (B) 常駐 daemon 内部で 5 分 sleep loop — 却下: crash/再起動時の復帰が timer より弱く、既存「1 パス完了が終端」設計（loops.md 行 17）と乖離。

### 方針
plan#3 で確定した init 系・PATH・repo 絶対パス・node パスを埋めて `.service`＋`.timer` を生成。`case-setup.sh` は冪等な導入/検証 script（`systemctl --user enable --now`・1 パス手動起動・ログ確認まで）。実際の case への設置は plan#6 が SSH 経由で実行する（本 issue は repo 成果物の authoring）。

### 契約
- service の実行コマンド・WorkingDirectory・PATH・ログ先は plan#3 記録の環境事実に一致させる（推測値を埋めない）。
- 5 分間隔・単一インスタンスの不変条件を timer + `RefuseManualStart` 等で担保。

### 検証
- 静的: `systemd-analyze verify ops/systemd/lathe-orchestrator.*`（case 側 plan#6 で実行）。
- `case-setup.sh` は `bash -n` 構文検査＋冪等性（2 回実行で差分なし）を plan#6 で確認。
- gate: `pnpm preflight --fast`。

---

Title: ingest 所在確定と case-local ingest 配線（サーバ常駐 lathe・(X) 経路維持）
Blocked-by: plan#3
Touches: apps/web/scripts/ingest/notify.ts, apps/web/scripts/ingest/usecase/discover-dirs.ts, design/observation-ingest.md

### 問題
orchestrator が case に移ると transcript は case の `~/.claude/projects` に落ちる。現 ingest は `os.homedir()` 基準で **ingest プロセスと同一 FS** を前提（notify.ts L80-95,168-175 / discover-dirs.ts L99-100）。集約後の ingest 所在を確定し配線する（本 issue の本丸）。**本 issue の採用案は ASK_PDM D1 の裁定に従う**。

### 選択肢（explains 3.3 の中立整理に対応）
- (a) **サーバ常駐**: lathe(web+Postgres) を case で動かし、case-local transcript を (X) でそのまま read（推奨）— 同一 FS 前提が case 内で成立し最小差分。`LATHE_NOTIFY_ALLOWED_ROOTS`/homedir が case を指すだけ。
- (b) 手元同期: case→Mac へ transcript を rsync し Mac で ingest — 却下寄り: 同期の脆さ・二重真実。
- (c) push 変種: transcript 中身を push（ADR 0004 保留）— Mac 併用時の Mac→case 経路に必要。契約（notify payload）を変えるため**別 issue（plan#8）に分離**。

### 方針（D1=(a) 採用を前提）
lathe を case 常駐にし、case-local ingest を (X) のまま使う。`os.homedir()`/`LATHE_NOTIFY_ALLOWED_ROOTS` が case の `~/.claude` を指す構成にし、DB は case の Postgres（`DATABASE_URL`）。**notify payload schema は変更しない**（path-based 維持）。Mac 側で開発したときの transcript を case lathe へ届ける経路は plan#8 に切り出す。

### 契約
- notify payload・route の型は不変（`Authorization: Bearer` + `{session_id, transcript_path, cwd, project_id, event}`）。本 issue では契約変更なし＝環境変数と allowlist の解決先のみ調整。契約を変えたくなったら実装せず ESCALATE。

### 検証
- integration: `DATABASE_URL=…@localhost:55433/lathe pnpm -C apps/web run verify:incremental`（scratch DB）で case-local path の transcript が ingest されることを確認。
- 実 artifact 照合: case 上で 1 セッション分の JSONL が DB に反映されること（plan#6 と併せて）。
- gate: `pnpm preflight --fast`。

---

Title: case 側 orchestrator 常駐の導入・自己検証（case 側 claude 実行・SSH 経由）
Blocked-by: plan#4, #224
Touches: design/runbooks/case-orchestrator-residency.md

### 問題
authoring 済みの systemd unit / install script（plan#4）を case に実設置し、orchestrator が case で 1 パス完走することを自己検証する。inner spawn が case のローカル outer 層を拾わないため #224（`--settings` pin）着地が前提。

### 選択肢
- (A) Mac から scp/ssh で手動設置 — 却下: PdM 裁定（SSH task 方式）に反する。
- (B) plan#1 機構で case 側 claude に導入 task を渡し、case 上で clone/依存/enable/1 パス起動/ログ確認まで完結（採用）。

### 方針
plan#1 で導入 task を送信。case 上で repo clone（無ければ）・`pnpm install --frozen-lockfile`・`systemctl --user enable --now`・手動 1 パス起動・`.lathe/logs/orchestrator.log` 確認・`.lathe/orchestrator.lock` の PID 排他動作確認を行い、結果を runbook に記録する。認証（claude/gh）は環境事実（ASK_PDM で確認済み前提）。

### 契約
- 常駐後も「1 パス完了が終端・escalation は breaker に数えない」（loops.md 行 17）を保つ。
- inner spawn の argv に `--settings <INNER_SETTINGS_PATH>` が乗る（#224）ことを起動ログで確認。

### 検証
- 実 artifact 照合: case で orchestrator 1 パスが GREEN 完走し、live マーカー生成→削除と lock 取得/解放がログに残ること。
- 二重起動テスト: 2 プロセス同時起動で 2 個目が lock で `exit` すること。

---

Title: Mac 併用時の二重着手排他（orchestrator 単一常駐の明文化＋ guard）
Blocked-by: plan#6
Touches: scripts/orchestrator.mjs, design/loops.md, design/runbooks/case-orchestrator-residency.md

### 問題
Mac と case の両拠点で loop が回ると、lock/live マーカーはローカル FS 上（`.lathe/orchestrator.lock`・`.lathe/runs/live-*.json`）で cross-machine 共有されず、同一 task の二重 spawn が起こりうる。**採用方針は ASK_PDM D2 の裁定に従う**。

### 選択肢
- (A) **自律 orchestrator は case 単一常駐**（推奨）: Mac は対話開発のみ（自律 loop を回さない）。Mac のローカル開発は PR/branch を作り、case orchestrator は導出 status（参照 PR open=In Progress・ADR 0031 §2）でそれを In Progress と見なし二重 spawn しない。追加で「別インスタンス起動を拒否する guard」を明文化。
- (B) cross-machine 分散 lock（共有ロック）— 却下寄り: 常駐一元化の方針に反し、実装コスト大。D2 で PdM が Mac 自律 loop を要ると裁定した場合のみ再検討。

### 方針（D2=(A) 前提）
`design/loops.md` に「自律 orchestrator は case 単一常駐・Mac は対話開発のみ」を明記。`orchestrator.mjs` に「本ホストが常駐ホストか」を判別する guard（例: 環境変数/hostname allowlist）を追加し、非常駐ホストでの自律起動を拒否 or 警告する。導出 status で足りる範囲・残る race window（spawn〜PR 生成）を runbook に明記。

### 契約
- 既存 lock/live マーカーの意味は不変（追加の guard のみ）。導出 status の定義（ADR 0031 §2）を変更しない。

### 検証
- unit: 非常駐ホスト判定時に自律起動が拒否/警告されることを assert。
- gate: `pnpm preflight --fast`。

---

Title: Mac→case transcript の push-content ingest 変種（設計・needs-plan）
Blocked-by: plan#5
Touches: apps/web/scripts/ingest/notify.ts, apps/web/app/api/ingest/notify/route.ts, adr/0037-push-content-ingest.md

### 問題
plan#5(a) で lathe は case 常駐だが、Mac 上で開発したときの transcript は Mac の FS にあり、case lathe は (X) の path-based read で読めない（FS 非共有）。ADR 0004 で保留された「中身/artifact を push する変種」が Mac 併用の観測に必要。契約（notify payload）に触るため独立 needs-plan とする。

### 修正方針（軽量・needs-plan）
本 issue は PLAN 段で notify payload の型拡張（path → content/artifact）を設計・PdM 承認してから実装する。#171 コア（実行集約）を止めないため優先度は低。#171 本体の完了条件には含めない。

### 検証
- 本 issue の PLAN で AC と契約（payload typedef）を確定してから implement。ここでは着地させない。

---

Title: case 集約運用 handbook / runbook 整備
Blocked-by: plan#5, plan#6, plan#7
Touches: design/runbooks/case-orchestrator-residency.md, README.md

### 問題
集約後の運用（起動/停止・ログ確認・認証更新・ingest 確認・Mac 併用時の作法・hold の使い方）が散在すると再現・引き継ぎができない。

### 修正方針（軽量）
plan#4-#7 の成果を 1 本の runbook に集約（systemd 操作・ログ・認証更新周期・ingest 健全性確認・排他の作法・hold label 運用）。README から導線を張る。

### 検証
- runbook の各手順が plan#4-#7 の実 artifact（unit 名・ログパス・env 名）と一致すること（機械照合）。
- lint 通過。

---

Rejected: @claude 応答（GitHub Actions）の case 移設 — PdM 裁定 13:26:57Z で「GitHub 側で稼働中・case 移設の対象外」と明示。
Rejected: driver / review engine / explain runner を個別に常駐化 — 旧世界の部品構成。現在は orchestrator が毎パス spawn する仕事（`orchestrator.mjs` 行 206-219）であり、常駐対象は orchestrator 1 点のみ（PdM 13:26:57Z）。
Rejected: launchd plist を case で流用 — macOS 専用。case は systemd 想定（PdM 13:24:00Z）＝ plan#4 で systemd 版を新規作成。

---

## PdM 判断が必要な事項（正常終端・ASK_PDM）

**D1（本丸・ingest 所在／phasing）**: plan#5 の契約が依存します。
- 推奨: **(a) lathe(web+Postgres) を case 常駐＋case-local ingest（(X) 維持・payload 契約変更なし）**を #171 コアとし、Mac→case の **push-content 変種(c) は plan#8 に分離（低優先・#171 完了条件外）**。
- 確認: この phasing で良いか（=Mac 併用時の観測を当面は「後追い」で許容するか）。

**D2（Mac 併用の排他）**: plan#7 の設計が依存します。
- 推奨: **自律 orchestrator は case 単一常駐、Mac は対話開発のみ**（導出 status＋case-local lock で足り、cross-machine 分散 lock は作らない）。
- 確認: Mac で**自律 loop を回す需要があるか**。あるなら分散 lock（重い）を別途起票する必要があります。

**D3（旧 body 依存の読み替え）**:
- 本文の `#116/#128/#117` は #201 以前の構成で、PdM 13:26:57Z の「orchestrator は既に稼働」に照らすと superseded と読めます。実効ブロッカーを **#224（settings pin・実装中）のみ**として良いか確認をお願いします。

**bootstrap 環境事実（plan#1/#3 の起動に最低限必要・これだけは recon 前に確認が要る）**:
1. ssh alias `case` は到達可能か（鍵・user・port／Tailscale か公開ポート 0 か）。
2. case に claude CLI が認証済みか（サブスク・`setup-token` か `login` か）。
3. case に gh CLI が認証済みか（対象 repo への権限）。

上記 3 点が確認できれば、それ以外の環境事実（OS/init 系・node/pnpm/corepack・codex 要否・repo clone 場所・`~/.claude` の位置・Docker/Postgres・常時稼働性）は **plan#3 の recon タスクが case 上で機械的に確定**します（PdM への質問不要）。

VERDICT: ASK_PDM