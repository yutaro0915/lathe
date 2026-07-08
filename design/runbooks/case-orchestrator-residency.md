# case 側 orchestrator 常駐ランブック (issue #236)

orchestrator を case（NixOS）の systemd user timer として導入し、1 パス完走と
lock 排他を実設置・自己検証した記録。

## 前提条件（#231 bootstrap 実測済み・引き継ぎ）

| 項目 | 状態 |
|------|------|
| SSH alias `case` | `~/.ssh/config` に登録済み（HostName 192.168.11.14 / User cherie / BatchMode=yes）|
| 鍵認証 | パスワードなし疎通確認済み |
| case 上 gh 認証 | yutaro0915 / Active |
| case 上 claude 認証 | `~/.config/claude-code/oauth-token`（chmod 600）配置済み |
| case 上 repo | `~/lathe`（origin = github.com/yutaro0915/lathe）|

## 導入手順（2026-07-08 実施）

### 1. case 上の repo を最新に同期する

```sh
ssh case 'cd ~/lathe && git pull'
```

### 2. pnpm を有効化する（初回のみ）

NixOS では pnpm が PATH にない。corepack で `~/.local/bin` に展開する。

```sh
ssh case '/nix/store/zvj0hl7rhh0ccr5vkcg3ijs3xm3sgyac-nodejs-24.16.0/bin/corepack \
  enable --install-directory ~/.local/bin'
```

> **注**: nix store hash は NixOS rebuild で変化する。`nix path-info nixpkgs#nodejs` で現 hash を確認すること。

PATH に `~/.local/bin` を含めて pnpm を使う:

```sh
export PATH="$HOME/.local/bin:/nix/store/…/bin:$HOME/.nix-profile/bin:$PATH"
pnpm --version   # → 11.10.0
```

### 3. 依存をインストールする

```sh
ssh case 'cd ~/lathe &&
  export PATH="$HOME/.local/bin:/nix/store/zvj0hl7rhh0ccr5vkcg3ijs3xm3sgyac-nodejs-24.16.0/bin:$HOME/.nix-profile/bin:$PATH" &&
  pnpm install --frozen-lockfile'
```

### 4. systemd unit を導入する（case-setup.sh）

```sh
ssh case 'cd ~/lathe &&
  export PATH="$HOME/.local/bin:/nix/store/zvj0hl7rhh0ccr5vkcg3ijs3xm3sgyac-nodejs-24.16.0/bin:$HOME/.nix-profile/bin:$PATH" &&
  bash ops/install/case-setup.sh'
```

**実出力（2026-07-08T03:05:38Z）**:

```
[case-setup] node パスを解決中...
[case-setup]   → /nix/store/zvj0hl7rhh0ccr5vkcg3ijs3xm3sgyac-nodejs-24.16.0/bin/node (v24.16.0)
[case-setup] login-shell PATH を取得中...
[case-setup]   → /home/cherie/.local/bin:/nix/store/…/bin:/run/wrappers/bin:…
[case-setup] ディレクトリを確認・作成...
[case-setup] service ファイルを生成中...
[case-setup]   → /home/cherie/.config/systemd/user/lathe-orchestrator.service
[case-setup] timer ファイルをコピー中...
[case-setup]   → /home/cherie/.config/systemd/user/lathe-orchestrator.timer
[case-setup] systemd user daemon をリロード...
[case-setup] timer を enable...
Created symlink '…/timers.target.wants/lathe-orchestrator.timer' → '…/lathe-orchestrator.timer'.
[case-setup] === インストール完了 ===
…
```

## 検証結果（2026-07-08 実施）

### systemd-analyze verify

```sh
systemd-analyze verify --user ~/.config/systemd/user/lathe-orchestrator.service
# → 出力なし（clean）
```

### timer 状態確認

```
● lathe-orchestrator.timer - Run Lathe Orchestrator every 5 minutes (#234)
     Loaded: loaded (…; enabled; preset: ignored)
     Active: active (waiting) since Wed 2026-07-08 03:05:38 UTC
    Trigger: Wed 2026-07-08 03:10:38 UTC; 4min 59s left
   Triggers: ● lathe-orchestrator.service
```

### orchestrator 手動 1 パス完走（2026-07-08T03:05:48Z）

```sh
ssh case 'cd ~/lathe &&
  export PATH="$HOME/.local/bin:/nix/store/…/bin:$HOME/.nix-profile/bin:$PATH" &&
  node scripts/orchestrator.mjs --max 5'
```

**出力**:

```
[orchestrator] pass start at 2026-07-08T03:05:48.198Z
[orchestrator] self-update: synced with origin/main
[orchestrator] WAIT_APPROVAL #141 — needs-review × 教材あり（done-explain）× 非 Ready — PdM の読む番
[orchestrator] WAIT_HOLD #235 — hold label — dispatch を一時停止（故障と数えない、ADR 0037）
[orchestrator] IMPLEMENT #236 — 無印 — plan review PASS は driver の run 内で強制（ADR 0035 §1）
[orchestrator] WAIT_HOLD #237 — hold label — dispatch を一時停止（故障と数えない、ADR 0037）
[orchestrator] WAIT_DEP #238 — blocked-by #235, #236, #237 が open
[orchestrator] WAIT_HOLD #252 — hold label — dispatch を一時停止（故障と数えない、ADR 0037）
[orchestrator] WAIT_APPROVAL #254 — needs-review × 教材あり（done-explain）× 非 Ready — PdM の読む番
[orchestrator] WAIT_APPROVAL #255 — needs-review × 教材あり（done-explain）× 非 Ready — PdM の読む番
[orchestrator] DISPATCH IMPLEMENT #236 — 無印 — …
[orchestrator] projection: #254 In progress → Approval
[orchestrator] projection: #255 In progress → Approval
[orchestrator] pass complete: dispatched=1 deferred=0 projected=2
```

- **lock**: パス中に `.lathe/orchestrator.lock`（PID 入り）を取得、pass complete 後に解放。
  完走後 `cat .lathe/orchestrator.lock` → `not present`（正常解放確認）。
- **live マーカー**: dispatch-runner が `live-implement-236.json` を書き込み → 完走後に削除。
  完走後 `.lathe/runs/` に `issue-236.json`（run 結果）と `outcomes.jsonl` が残留（live マーカーは消去済み）。
- **outcomes.jsonl**: `{"finishedAt":"…","class":"IMPLEMENT","kind":"issue","number":236,"outcome":"failure","exitCode":1}`
  （inner loop TASK_PLAN が case 側 claude 認証エラーで失敗。**orchestrator パス自体は GREEN**。後述）

### systemd 経由 1 パス確認（2026-07-08T03:08:06Z）

`systemctl --user start lathe-orchestrator.service` で即時起動し、
`~/.lathe/logs/orchestrator.log` に出力が記録されることを確認。

```
[orchestrator] pass start at 2026-07-08T03:08:06.254Z
[orchestrator] self-update: synced with origin/main
…
[orchestrator] DISPATCH EXPLAIN #236 — escalation × needs-review × 教材なし — 教材を先に生成
[orchestrator] pass complete: dispatched=1 deferred=0 projected=0
```

log ファイルへの書き込みが機能していること、および systemd `Type=oneshot` による
run-to-completion 動作を確認。

### lock 排他テスト（二重起動）

生存 PID（$$）でロックを手書きし、別インスタンスの挙動を確認:

```sh
echo "{\"pid\":$$,\"startedAt\":\"$(date -u +%FT%TZ)\"}" > .lathe/orchestrator.lock
node scripts/orchestrator.mjs --max 5
```

**出力**:

```
[orchestrator] pass start at 2026-07-08T03:06:50.884Z
[orchestrator] another orchestrator is running (pid=8034) — exiting (1 プロセス 1 パス)
```

- exit code: 0
- **2 プロセス同時起動で 2 個目が lock で exit** することを確認。

### --settings pin 確認

inner spawn の argv に `--settings <INNER_SETTINGS_PATH>` が乗っていることを確認:

```
scripts/inner-loop-backends.mjs:213:  '--settings', INNER_SETTINGS_PATH,
```

ここで `INNER_SETTINGS_PATH = join(REPO_ROOT, '.claude', 'settings.json')`
（`scripts/inner-loop-core.mjs:28`）。

issue-236.log（case side dispatch-runner）でも `spawning claude` が呼ばれており、
settings パスが渡されている（TASK_PLAN の失敗は認証エラーであり settings パスの問題ではない）。

## 既知の問題・後続対応

### case 側 inner loop の claude 認証（本 issue スコープ外）

dispatch-runner が inner-loop.mjs を起動し claude を呼ぶと
`Not logged in · Please run /login` で失敗する。

- `claude -p`（case-dispatch.mjs 経由）は認証済み（#231 実測）
- inner-loop が `claude -p` 以外で起動する場合、`CLAUDE_CODE_OAUTH_TOKEN` env が
  未設定になっている可能性がある
- **対処**: case 側 inner loop の実行環境で `CLAUDE_CODE_OAUTH_TOKEN` を注入する
  仕組みを別 issue で検討（本 issue 対象外）

## timer の停止・再起動

```sh
# 停止
systemctl --user stop lathe-orchestrator.timer lathe-orchestrator.service

# 無効化（自動起動を止める）
systemctl --user disable lathe-orchestrator.timer

# 再有効化
systemctl --user enable --now lathe-orchestrator.timer
```

## log 確認・rotate

- log: `~/lathe/.lathe/logs/orchestrator.log`
- rotate: 7 日超で `.prev` に退避（`orchestrator-logs.mjs` の `rotateAppendLog`）

## 関連

- 前提 bootstrap: `design/runbooks/case-remote-tasks.md`（#231 SSH 疎通・oauth-token 配置）
- 導入スクリプト: `ops/install/case-setup.sh`（#234 authoring）
- systemd unit テンプレート: `ops/systemd/lathe-orchestrator.{service,timer}`（#234）
- lock / live マーカー設計: `scripts/orchestrator.mjs`（#201）
- dispatch-runner: `scripts/dispatch-runner.mjs`（#201）
- 後続（case 正式退役・Mac launchd 停止）: issue #237
