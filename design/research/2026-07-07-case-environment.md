# case 環境事実（recon）

**目的**: plan#4（常駐機構）・plan#5（ingest 配線）の設計前提となる case マシンの環境事実を実測で記録する。
**規律**: 本ファイルは事実表のみ。結論・設計判断・推奨は書かない（役割境界：recon = 事実、設計判断は plan#4/#5 の ADR/design が担当）。
**実測日**: 2026-07-08（Mac → `ssh case` 経由で各コマンドを実行）。
**接続前提**: SSH alias `case`（LAN `192.168.11.14`、User cherie、鍵認証・BatchMode）。詳細は issue #231 コメント参照。

---

## 事実表

| 項目 | 値 | 確認コマンド | 確認日 |
|------|-----|------------|--------|
| OS / NixOS | NixOS 26.05 (Yarara)、BUILD_ID: 26.05.20260704.a50de1b、kernel: Linux 6.18.37 #1-NixOS x86_64 | `uname -a` / `nixos-version` / `cat /etc/os-release` | 2026-07-08 |
| init 系 | systemd 260 (260.2)。user systemd 稼働（`systemctl --user` 疎通）。enabled user unit: dbus-broker, podman.socket 等 | `systemctl --version` / `systemctl --user --version` / `systemctl --user list-unit-files --state=enabled` | 2026-07-08 |
| node | v24.16.0（nix store 内: `/nix/store/scl9b1j2vsl07pp54ahy455232ka7bz5-nodejs-slim-24.16.0/bin/node`）。デフォルト PATH には不在（`which node` = not found） | `/nix/store/.../node -v` / `nix run nixpkgs#nodejs -- -v` | 2026-07-08 |
| pnpm | 10.18.1（`~/lathe/package.json` の `packageManager` フィールド。corepack shim は nix store 内に存在）。デフォルト PATH には不在（`which pnpm` = not found） | `cat ~/lathe/package.json \| grep packageManager` / `find /nix -name pnpm -type f` | 2026-07-08 |
| gh 認証 | 済み。アカウント: yutaro0915、Active。`~/lathe` clone 実在、origin: github.com/yutaro0915/lathe。token scopes: gist/project/read:org/repo/workflow | `gh auth status` | 2026-07-08 |
| claude 認証 | 済み（claude 2.1.201）。OAuth token: `~/.config/claude-code/oauth-token`（chmod 600）。`CLAUDE_CODE_OAUTH_TOKEN=$(tr -d "\n" < ~/.config/claude-code/oauth-token) claude -p "reply with exactly: OK"` → OK 応答確認 | `CLAUDE_CODE_OAUTH_TOKEN=... claude -p "reply with exactly: OK"` / `claude --version` | 2026-07-08 |
| repo clone 場所 | `/home/cherie/lathe`（`~/lathe`）。origin: `github.com/yutaro0915/lathe` | `ls ~/lathe` / `gh auth status`（clone 実在確認） | 2026-07-08 |
| `~/.claude/projects` | 存在。`~/.claude/projects/` 配下: `-home-cherie` / `-home-cherie-lathe` / `-tmp-cc-smoke` | `ls ~/.claude/projects/` | 2026-07-08 |
| DB（Docker/Postgres） | Podman 5.8.2（`docker` alias）。コンテナ `lathe-pg`（postgres:16）が稼働中（Up、port 0.0.0.0:55432→5432）。user systemd の `podman.socket` が enabled | `docker --version` / `podman --version` / `docker ps` / `systemctl --user list-unit-files` | 2026-07-08 |
| 常時稼働性 | uptime: 1 day 2:20 以上（実測時点）。`systemctl --user` でユーザー session 常駐確認。電源設定・sleep policy の詳細は未確認 | `uptime` / `systemctl --user list-units --state=running` | 2026-07-08 |
