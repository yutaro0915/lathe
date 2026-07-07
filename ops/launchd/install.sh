#!/usr/bin/env bash
# com.lathe.orchestrator を LaunchAgents へ導入する（冪等・再実行可）。
# 用意するだけ — 実行するかは人間の判断（README.md 参照）。
set -euo pipefail

LABEL="com.lathe.orchestrator"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SRC="${SCRIPT_DIR}/${LABEL}.plist"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

plutil -lint "${SRC}"
mkdir -p "${HOME}/Library/LaunchAgents" "${REPO_ROOT}/.lathe/logs"

# copy を採用（symlink は launchd が owner/permission 検査で拒否する環境があるため）
cp "${SRC}" "${DEST}"
chmod 644 "${DEST}"

# 冪等: 既 load なら一度 bootout（未 load での失敗は無視）→ bootstrap（新式）
launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "${DOMAIN}" "${DEST}"
launchctl enable "${DOMAIN}/${LABEL}"

echo "== installed: ${DEST}"
# head だと pipefail × SIGPIPE で誤 fail し得るため sed（全読み）で先頭のみ表示
launchctl print "${DOMAIN}/${LABEL}" | sed -n '1,12p'
echo "== 次パスは最大 5 分後（即時 1 パス: launchctl kickstart ${DOMAIN}/${LABEL}）"
echo "== log: ${REPO_ROOT}/.lathe/logs/orchestrator.log"
