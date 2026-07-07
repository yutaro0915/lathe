# case 常駐方式の比較（NixOS）

**作成**: issue #234（plan#4）  
**目的**: lathe orchestrator を case（NixOS 26.05）で 5 分間隔常駐させる 2 案を比較し、本 authoring の方針とリスクを記録する。  
**規律**: 方式選択・設置の最終判断は plan#6（recon 後の実設置）が担う。本文書は選択肢と根拠の記録。

---

## 前提（plan#3 実測値）

| 項目 | 値 |
|------|----|
| OS | NixOS 26.05 (Yarara), systemd 260 |
| init 系 | systemd user session 稼働（`systemctl --user` 疎通） |
| node | v24.16.0（nix store 内、デフォルト PATH 外） |
| repo | `/home/cherie/lathe` |
| claude auth | `~/.config/claude-code/oauth-token`（OAuth token ファイル） |

出典: `design/research/2026-07-07-case-environment.md`

---

## 方式 A（採用）: systemd user unit + home（portable unit）

### 概要
repo が `ops/systemd/lathe-orchestrator.{service,timer}` を提供し、`case-setup.sh` が `~/.config/systemd/user/` へ展開・有効化する。nix-config（別 repo）に変更を加えない。

### 採用理由
- **repo が自己完結**: nix-config を持たない環境（他マシン・CI）でも同じ手順で動く
- **systemd user unit は NixOS でも標準サポート**: `podman.socket` 等が既に user unit で稼働（実測確認）
- **実設置コスト最小**: `bash ops/install/case-setup.sh` 1 コマンドで完了、git pull で更新される
- **launchd との等価性**: macOS plist の 5 構成要素（間隔・ExecStart・WorkingDir・PATH・ログ）を systemd で 1:1 対応

### 構成

```
ops/
├── systemd/
│   ├── lathe-orchestrator.service   # Type=oneshot、@@NODE@@ プレースホルダ付き
│   └── lathe-orchestrator.timer     # OnUnitActiveSec=5min
└── install/
    └── case-setup.sh                # node パス解決・展開・enable（冪等）
```

### 単一インスタンス保証
- `Type=oneshot`: service が exit するまで次 timer 発火は pending → 並列起動不可
- `RefuseManualStart=yes`: timer 外の `systemctl --user start` を機械的に拒否
- orchestrator.mjs の lock（`.lathe/orchestrator.lock`）: 多重起動の最終防壁（mac と共通）

### NixOS 固有の課題と対策

| 課題 | 対策 |
|------|------|
| node がデフォルト PATH 外 | case-setup.sh が `nix path-info` で store パスを解決し ExecStart に埋め込む |
| nix store hash が rebuild ごとに変化 | case-setup.sh が都度解決するため unit ファイル自体は hash を持たない |
| claude OAuth token（Keychain 非在） | case-setup.sh が `~/.config/claude-code/oauth-token` から `~/.config/lathe/env` を生成し `EnvironmentFile=` で注入 |
| loginctl lingering 非設定時の user session 終了 | case-setup.sh は lingering 設定を確認・警告（plan#6 で実測して対処） |

### 限界
- NixOS upgrade 後に nix store パスが変化した場合、`case-setup.sh` の再実行が必要
- user service は GUI session に依存しないが、`loginctl enable-linger` が有効でないと再起動後にユーザー session が起動しない可能性あり（plan#6 で実設置時に確認）

---

## 方式 B（不採用）: nix-config flake 宣言追加

### 概要
`github.com/yutaro0915/nix-config`（別 repo、lathe scope 外）の flake に `systemd.user.services.lathe-orchestrator` を NixOS module として宣言し、`nixos-rebuild switch` で有効化する。

### NixOS 純度上の優位性
- NixOS の推奨方式: 設定を宣言的に管理、rollback 可能
- `systemctl enable` 不要（`nixos-rebuild` が自動的に link）
- nix store パスを nix が解決するため hash の手動解決が不要

### 不採用理由
- **別 repo・scope 外**: nix-config は lathe repo とは独立した管理単位。lathe の PR が nix-config の変更を要求すると cross-repo 依存が生まれる
- **デプロイ摩擦増加**: lathe の orchestrator 更新が nix-config の `nixos-rebuild switch` を必要とする（CI/CD の複雑化）
- **他環境への非移植性**: nix-config を持たない macOS・他マシンで同手順が使えない

### 移行トリガー（ESCALATE 条件）
plan#6 の実設置で以下が判明した場合は ESCALATE し、方式 B（nix-config 統合）を PdM 裁定に委ねる:
1. `loginctl enable-linger` が禁止されており user session 常駐が不可能
2. NixOS セキュリティポリシーが `~/.config/systemd/user/` への unit ファイル配置を拒否
3. nixos-rebuild の強制適用により手動 unit が毎回消去される

---

## 方式 C（却下）: 常駐 daemon + sleep loop

`setInterval` または `while sleep 300; do ...; done` による自前ループ。

### 却下理由
- crash 時の自動復旧が弱い（systemd の restart 設定が複雑化）
- 「1 パス = 1 プロセス、完了が終端」設計と乖離（プロセスが常駐し続ける）
- 子プロセスの孤立リスク（orchestrator が crash しても sleep プロセスが残る）
- launchd `StartInterval` の語義（完了後 N 秒後）を再現するには `OnUnitActiveSec` が最も自然

---

## 決定

**方式 A（systemd user unit + portable unit）を採用**。

- repo 自己完結・他環境移植性・実設置コストの観点で優位
- NixOS 純度の trade-off は許容可能（方式 B への移行トリガーを明示）
- 実設置は plan#6 が担い、linger 等の実測依存事項はその場で確認・対処

---

## 関連

- issue #233: case 環境事実（plan#3 recon）
- issue #234: 本 authoring（plan#4）
- plan#6: case 実設置（本文書の方式 A を前提）
- `ops/systemd/lathe-orchestrator.service` / `.timer`
- `ops/install/case-setup.sh`
