#!/usr/bin/env bash
# com.lathe.orchestrator を解除する（冪等・状態表示つき）。
set -euo pipefail

LABEL="com.lathe.orchestrator"
DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}/${LABEL}"
  echo "== booted out: ${DOMAIN}/${LABEL}"
else
  echo "== not loaded: ${DOMAIN}/${LABEL}"
fi

if [[ -f "${DEST}" ]]; then
  rm "${DEST}"
  echo "== removed: ${DEST}"
else
  echo "== no plist: ${DEST}"
fi

echo "== done（log は .lathe/logs/ に残る。実行中の子プロセスは止めない）"
