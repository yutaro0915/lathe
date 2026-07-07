#!/usr/bin/env bash
# case-setup.sh — Lathe Orchestrator を case（NixOS）の systemd user unit として導入・検証する。
#
# 用途: ops/systemd/ の service/timer を ~/.config/systemd/user/ へ展開し、
#       node の nix store パスを解決して @@NODE@@ プレースホルダを置換する。
#       冪等（2 回実行しても差分が生じない）。
#
# 実行: bash ops/install/case-setup.sh
#   --check のみ: bash ops/install/case-setup.sh --check  （インストールせず現状確認のみ）
#
# 依存: NixOS + systemd user session、nix コマンド、gh 認証済み
# 実設置: plan#6（recon 結果に基づき人間が判断して実行）
set -euo pipefail

# ── 定数 ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
UNIT_SRC_DIR="${REPO_ROOT}/ops/systemd"
UNIT_DEST_DIR="${HOME}/.config/systemd/user"
UNIT_SERVICE="lathe-orchestrator.service"
UNIT_TIMER="lathe-orchestrator.timer"
LOG_DIR="${REPO_ROOT}/.lathe/logs"
ENV_FILE="${HOME}/.config/lathe/env"
OAUTH_TOKEN_FILE="${HOME}/.config/claude-code/oauth-token"

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=true
fi

# ── ヘルパー ───────────────────────────────────────────────────────────────
log()  { echo "[case-setup] $*"; }
warn() { echo "[case-setup][WARN] $*" >&2; }
die()  { echo "[case-setup][ERROR] $*" >&2; exit 1; }

# ── node パス解決 ─────────────────────────────────────────────────────────
# NixOS では node がデフォルト PATH に存在しない（実測: 2026-07-07-case-environment.md）。
# nix path-info で現 nixpkgs の store パスを取得し絶対パスを確定する。
# nix-store hash は nixpkgs 更新ごとに変化するため、直書きせずここで解決する。
resolve_node() {
  local node_bin
  # 1. PATH にあれば優先（nix profile install nixpkgs#nodejs 済みの環境）
  if node_bin=$(command -v node 2>/dev/null) && [[ -x "$node_bin" ]]; then
    echo "$node_bin"
    return 0
  fi
  # 2. nix path-info で store パスを取得（ネットワーク不要・ローカルキャッシュから解決）
  local store
  store=$(nix path-info nixpkgs#nodejs 2>/dev/null) \
    || store=$(nix path-info nixpkgs#nodejs_24 2>/dev/null) \
    || die "node の nix store パスを解決できませんでした。\n  試行: nix path-info nixpkgs#nodejs\n  代替: nix profile install nixpkgs#nodejs を実行してから再試行してください。"
  node_bin="${store}/bin/node"
  [[ -x "$node_bin" ]] || die "解決した node が実行可能ファイルではありません: ${node_bin}"
  echo "$node_bin"
}

# ── --check モード ────────────────────────────────────────────────────────
check_status() {
  log "=== 現状確認 ==="
  log "timer:   $(systemctl --user is-active ${UNIT_TIMER} 2>/dev/null || echo inactive)"
  log "service: $(systemctl --user is-active ${UNIT_SERVICE} 2>/dev/null || echo inactive)"
  if systemctl --user is-enabled "${UNIT_TIMER}" >/dev/null 2>&1; then
    log "timer enabled: yes"
    systemctl --user list-timers "${UNIT_TIMER}" --no-pager 2>/dev/null || true
  else
    log "timer enabled: no"
  fi
  log "log dir: ${LOG_DIR} $([ -d "${LOG_DIR}" ] && echo '(存在)' || echo '(未作成)')"
  log "env file: ${ENV_FILE} $([ -f "${ENV_FILE}" ] && echo '(存在)' || echo '(未作成)')"
  node_bin=$(resolve_node 2>/dev/null || echo "NOT_FOUND")
  log "node: ${node_bin}"
  if [[ "$node_bin" != "NOT_FOUND" ]]; then
    log "  version: $("$node_bin" --version 2>/dev/null || echo '?')"
  fi
}

if $CHECK_ONLY; then
  check_status
  exit 0
fi

# ── node 解決 ────────────────────────────────────────────────────────────
log "node パスを解決中..."
NODE=$(resolve_node)
log "  → ${NODE} ($(${NODE} --version))"

# ── ディレクトリ作成 ──────────────────────────────────────────────────────
log "ディレクトリを確認・作成..."
mkdir -p "${UNIT_DEST_DIR}" "${LOG_DIR}" "${HOME}/.config/lathe"

# ── service ファイル生成（@@NODE@@ を解決済みパスで置換）────────────────────
SRC_SERVICE="${UNIT_SRC_DIR}/${UNIT_SERVICE}"
DEST_SERVICE="${UNIT_DEST_DIR}/${UNIT_SERVICE}"

log "service ファイルを生成中..."
[[ -f "$SRC_SERVICE" ]] || die "テンプレートが見つかりません: ${SRC_SERVICE}"
sed "s|@@NODE@@|${NODE}|g" "${SRC_SERVICE}" > "${DEST_SERVICE}"
log "  → ${DEST_SERVICE}"

# ── timer ファイルをコピー ────────────────────────────────────────────────
SRC_TIMER="${UNIT_SRC_DIR}/${UNIT_TIMER}"
DEST_TIMER="${UNIT_DEST_DIR}/${UNIT_TIMER}"

log "timer ファイルをコピー中..."
[[ -f "$SRC_TIMER" ]] || die "timer ファイルが見つかりません: ${SRC_TIMER}"
cp "${SRC_TIMER}" "${DEST_TIMER}"
log "  → ${DEST_TIMER}"

# ── 環境変数ファイル生成（claude OAuth token）────────────────────────────
# case では Keychain が無いため token をファイルから読み環境変数ファイルへ書く。
# EnvironmentFile= で service から参照される（service ファイルのコメント参照）。
log "環境変数ファイルを確認・生成中..."
if [[ -f "${OAUTH_TOKEN_FILE}" ]]; then
  TOKEN=$(tr -d '\n' < "${OAUTH_TOKEN_FILE}")
  # 冪等: 既に同じ内容なら上書きしない
  EXPECTED="CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}"
  if [[ -f "${ENV_FILE}" ]] && grep -qF "$EXPECTED" "${ENV_FILE}" 2>/dev/null; then
    log "  env file は最新です（スキップ）"
  else
    chmod 700 "${HOME}/.config/lathe"
    printf '%s\n' "CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}" > "${ENV_FILE}"
    chmod 600 "${ENV_FILE}"
    log "  → ${ENV_FILE} を生成しました"
  fi
else
  warn "OAuth token ファイルが見つかりません: ${OAUTH_TOKEN_FILE}"
  warn "  claude 認証なしで orchestrator が実行されます。"
  warn "  手動で ${ENV_FILE} に CLAUDE_CODE_OAUTH_TOKEN=<token> を設定してください。"
fi

# ── systemd daemon-reload + enable + start ────────────────────────────────
log "systemd user daemon をリロード..."
systemctl --user daemon-reload

log "timer を enable..."
# 冪等: is-enabled なら skip せず enable --now で再確認（enable は冪等）
systemctl --user enable --now "${UNIT_TIMER}"

log "=== インストール完了 ==="
log "timer status:"
systemctl --user status "${UNIT_TIMER}" --no-pager -l 2>/dev/null | head -12 || true
log ""
log "次パスは 1 分後の OnBootSec または OnUnitActiveSec の到来時。"
log "即時 1 パスが必要な場合（RefuseManualStart=yes のため systemctl start は不可）:"
log "  node ${REPO_ROOT}/scripts/orchestrator.mjs --max 5"
log "ログ: ${LOG_DIR}/orchestrator.log"
log "確認: systemctl --user list-timers ${UNIT_TIMER}"
