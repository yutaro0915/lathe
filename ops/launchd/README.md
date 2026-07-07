# launchd 常駐 — com.lathe.orchestrator（#201 分解 14）

orchestrator（`node scripts/orchestrator.mjs --max 5`）を 5 分間隔（StartInterval 300）で無人実行する LaunchAgent。常駐せず 1 パスで exit・二重起動は lock（`.lathe/orchestrator.lock`）が防ぐ。plist の絶対パスはこの Mac 固有（実測 2026-07-07）。

## 導入

    bash ops/launchd/install.sh   # plist を ~/Library/LaunchAgents/ へ copy して bootstrap（冪等）

## 確認

    launchctl print gui/$(id -u)/com.lathe.orchestrator      # state・last exit status
    launchctl kickstart gui/$(id -u)/com.lathe.orchestrator  # 待たずに即時 1 パス

## ログ・停止したい時

`.lathe/logs/orchestrator.log`（追記・各パス冒頭に `pass start at <ISO>` 行・7 日超で `.prev` へ rotate 1 世代）。dispatch された子の log は `.lathe/runs/*.log`。

    bash ops/launchd/uninstall.sh   # bootout ＋ plist 削除（完全解除）

一時停止のみなら `launchctl bootout gui/$(id -u)/com.lathe.orchestrator`（再開は install.sh 再実行）。
