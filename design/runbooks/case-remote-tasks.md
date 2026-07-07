# case リモートタスク受け渡しランブック (issue #231)

SSH 越しに Mac から case 上の Claude Code へタスクを渡し、case 側で完結させる手順。

## 前提条件（bootstrap 実測済み・2026-07-08）

| 項目 | 状態 |
|------|------|
| SSH alias `case` | `~/.ssh/config` に登録済み（HostName 192.168.11.14 / User cherie / BatchMode=yes）|
| 鍵認証 | パスワードなし疎通確認済み |
| case 上 gh 認証 | yutaro0915 / Active |
| case 上 claude 認証 | `~/.config/claude-code/oauth-token`（chmod 600）配置済み |
| case 上 repo | `~/lathe`（origin = github.com/yutaro0915/lathe）|
| 疎通確認コマンド | `ssh case 'cd ~/lathe && CLAUDE_CODE_OAUTH_TOKEN=$(tr -d "\n" < ~/.config/claude-code/oauth-token) claude -p "reply with exactly: OK"'` → `OK` |

> **注意**: `192.168.11.14` は DHCP 配布のため可変。接続不能時は `~/.ssh/config` の HostName を現 IP に更新する。  
> tailscale 経路（100.72.249.34）は現在 Mac→case が不達。LAN 接続を使用する。

## task 受け渡し手順

### 1. タスク本文を用意する

```sh
cat > /tmp/task-231.txt <<'EOF'
gh issue view #231 を読んで、issue に記載された plan の通り実装してください。
EOF
```

### 2. case-dispatch.mjs で dispatch する

```sh
node scripts/case-dispatch.mjs \
  --issue 231 \
  --task-file /tmp/task-231.txt
```

`--repo-dir` を省略すると `~/lathe` がデフォルト。カスタム repo パスの場合:

```sh
node scripts/case-dispatch.mjs \
  --issue 231 \
  --task-file /tmp/task-231.txt \
  --repo-dir /home/cherie/custom-repo
```

### 3. 出力確認

- case 上の claude が標準出力/標準エラーに応答を返す
- exit code 0 = 正常完了
- exit code 非 0 = エラー（ログを確認）

## 最小権限の考え方

`dispatchToCase()` は `allowedTools` を必須引数とする（既定値なし）。  
呼び出し側が常に明示することで権限の散逸を防ぐ設計（`.claude/skills/explain-diff/SETUP.md §6` と同型）。

CLI（`case-dispatch.mjs`）使用時のデフォルト:

```
Read, Grep, Glob, Write, Edit, Bash(git:*), Bash(gh:*), Bash(node:*), Bash(pnpm:*)
```

より狭いタスク（例: 読み取り専用調査）では `allowedTools` を明示的に絞ること。

## プログラムから呼び出す場合

```js
import { dispatchToCase } from './scripts/case-dispatch.mjs';

const { exitCode, log } = await dispatchToCase({
  issue: 231,
  taskPrompt: 'gh issue view #231 を読み、実装してください。',
  allowedTools: ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash(gh:*)', 'Bash(git:*)'],
  repoDir: '/home/cherie/lathe',
});
console.log('exit:', exitCode, 'log:', log);
```

## トラブルシューティング

| 症状 | 確認事項 |
|------|----------|
| `ssh: connect to host case port 22: Connection refused` | `ssh case echo ok` で疎通確認。LAN 接続・IP 変更確認 |
| `claude: command not found` | case 側 PATH 確認。`which claude` on case |
| `Invalid OAuth token` | case の `~/.config/claude-code/oauth-token` を更新 |
| `gh: command not found` | case 側 gh CLI インストール確認 |
| allowedTools 関連エラー | `dispatchToCase` に渡す `allowedTools` が空でないか確認 |

## 関連

- 実装: `scripts/case-dispatch.mjs`
- テスト: `scripts/case-dispatch.test.mjs`
- 参照 issue: #231（SSH 越し case task 受け渡し機構）
- 後続タスク: case 側 plan#3（recon）・plan#6
