#!/usr/bin/env bash
# case-setup.sh — Lathe Orchestrator を case（NixOS）の systemd user unit として導入・検証する。
#
# 用途: ops/systemd/ の service/timer を ~/.config/systemd/user/ へ展開し、
#       node の nix store パスと login-shell PATH・REPO_ROOT・LOG_DIR を解決して
#       {{PLACEHOLDER}} を置換する。冪等（2 回実行しても差分が生じない）。
#
# 実行: bash ops/install/case-setup.sh
#   --check のみ: bash ops/install/case-setup.sh --check  （インストールせず現状確認のみ）
#
# 依存: NixOS + systemd user session、nix コマンド
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

# ── login-shell PATH 取得 ─────────────────────────────────────────────────
# NixOS user systemd は login-shell PATH を継がない。
# plan §4: recon は完全 PATH 文字列を未記録のため guess をコミットせず、
#           install 時に login-shell の $PATH を capture して {{LOGIN_PATH}} を置換する。
resolve_login_path() {
  # bash -l で login-shell を起動し PATH を取得
  local login_path
  login_path=$(bash -lc 'echo "$PATH"' 2>/dev/null) || login_path=""
  if [[ -z "$login_path" ]]; then
    # fallback: 現在の PATH
    warn "login-shell PATH の取得に失敗しました。現在の PATH を使用します。"
    login_path="$PATH"
  fi
  echo "$login_path"
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
  node_bin=$(resolve_node 2>/dev/null || echo "NOT_FOUND")
  log "node: ${node_bin}"
  if [[ "$node_bin" != "NOT_FOUND" ]]; then
    log "  version: $("$node_bin" --version 2>/dev/null || echo '?')"
  fi
  log "REPO_ROOT: ${REPO_ROOT}"
  log "LOGIN_PATH: $(resolve_login_path)"
}

# ── 依存 self-check ──────────────────────────────────────────────────────
# 実測 2026-07-08（issue #282）: claude 認証・pnpm 欠品が case で実弾を止めた。
# 応急処置（case ローカル導入）で凌ぐのではなく、導入前に機械で検出して FAIL させる。
# ENV_FILE は ops/systemd/lathe-orchestrator.service の EnvironmentFile= と対応。
ENV_FILE="${HOME}/.config/lathe-cf/env"

self_check() {
  local failed=false

  if command -v node >/dev/null 2>&1 || nix path-info nixpkgs#nodejs >/dev/null 2>&1 \
      || nix path-info nixpkgs#nodejs_24 >/dev/null 2>&1; then
    log "self-check: node OK"
  else
    warn "self-check: node が見つかりません（PATH にも nix store にも解決不可）"
    failed=true
  fi

  if command -v pnpm >/dev/null 2>&1; then
    log "self-check: pnpm OK ($(pnpm --version 2>/dev/null || echo '?'))"
  else
    warn "self-check: pnpm が見つかりません（corepack enable --install-directory ~/.local/bin を実行してください）"
    failed=true
  fi

  if ! command -v claude >/dev/null 2>&1; then
    warn "self-check: claude コマンドが見つかりません"
    failed=true
  elif claude -p "reply with exactly: OK" >/dev/null 2>&1; then
    log "self-check: claude 認証 OK（claude -p 疎通確認）"
  else
    warn "self-check: claude -p 疎通に失敗しました（認証切れの可能性。CLAUDE_CODE_OAUTH_TOKEN を確認してください）"
    failed=true
  fi

  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    log "self-check: gh 認証 OK"
  else
    warn "self-check: gh 認証が確認できません（gh auth login を実行してください）"
    failed=true
  fi

  if [[ -f "${ENV_FILE}" ]]; then
    log "self-check: EnvironmentFile OK (${ENV_FILE})"
  else
    warn "self-check: EnvironmentFile が見つかりません（${ENV_FILE}）。unit の EnvironmentFile= と対応する秘匿値ファイルを配置してください"
    failed=true
  fi

  if $failed; then
    return 1
  fi
  log "self-check: すべて OK"
  return 0
}

# ── main（実インストール本体。--check / source 時は実行しない）───────────────
main() {
if $CHECK_ONLY; then
  check_status
  exit 0
fi

self_check || die "self-check FAILED — 依存が不足しています。導入を中止します。"

# ── node 解決 ────────────────────────────────────────────────────────────
log "node パスを解決中..."
NODE=$(resolve_node)
log "  → ${NODE} ($(${NODE} --version))"

# ── login-shell PATH 取得 ─────────────────────────────────────────────────
log "login-shell PATH を取得中..."
LOGIN_PATH=$(resolve_login_path)
log "  → ${LOGIN_PATH}"

# ── ディレクトリ作成 ──────────────────────────────────────────────────────
log "ディレクトリを確認・作成..."
mkdir -p "${UNIT_DEST_DIR}" "${LOG_DIR}"

# ── service ファイル生成（{{PLACEHOLDER}} を解決済みの値で置換）──────────────
# 置換対象:
#   {{NODE_BIN}}   = nix store パスで解決した node 絶対パス
#   {{REPO_ROOT}}  = スクリプト位置 ../.. から動的解決したリポジトリルート
#   {{LOG_DIR}}    = ${REPO_ROOT}/.lathe/logs
#   {{LOGIN_PATH}} = login-shell から capture した PATH 文字列
SRC_SERVICE="${UNIT_SRC_DIR}/${UNIT_SERVICE}"
DEST_SERVICE="${UNIT_DEST_DIR}/${UNIT_SERVICE}"

log "service ファイルを生成中..."
[[ -f "$SRC_SERVICE" ]] || die "テンプレートが見つかりません: ${SRC_SERVICE}"
sed \
  -e "s|{{NODE_BIN}}|${NODE}|g" \
  -e "s|{{REPO_ROOT}}|${REPO_ROOT}|g" \
  -e "s|{{LOG_DIR}}|${LOG_DIR}|g" \
  -e "s|{{LOGIN_PATH}}|${LOGIN_PATH}|g" \
  "${SRC_SERVICE}" > "${DEST_SERVICE}"
log "  → ${DEST_SERVICE}"

# ── timer ファイルをコピー ────────────────────────────────────────────────
SRC_TIMER="${UNIT_SRC_DIR}/${UNIT_TIMER}"
DEST_TIMER="${UNIT_DEST_DIR}/${UNIT_TIMER}"

log "timer ファイルをコピー中..."
[[ -f "$SRC_TIMER" ]] || die "timer ファイルが見つかりません: ${SRC_TIMER}"
cp "${SRC_TIMER}" "${DEST_TIMER}"
log "  → ${DEST_TIMER}"

# ── systemd daemon-reload + enable + start ────────────────────────────────
log "systemd user daemon をリロード..."
systemctl --user daemon-reload

log "timer を enable..."
# 冪等: enable --now は既に enabled でも安全（enable は冪等）
systemctl --user enable --now "${UNIT_TIMER}"

log "=== インストール完了 ==="
log "timer status:"
systemctl --user status "${UNIT_TIMER}" --no-pager -l 2>/dev/null | head -12 || true
log ""
log "初回パスは OnActiveSec=5min の到来後（timer 有効化から 5 分後）。"
log "即時 1 パスが必要な場合:"
log "  systemctl --user start ${UNIT_SERVICE}"
log "  または: node ${REPO_ROOT}/scripts/orchestrator.mjs --max 5"
log "ログ: ${LOG_DIR}/orchestrator.log"
log "確認: systemctl --user list-timers ${UNIT_TIMER}"
}

# source 時（テストからの関数読み込み等）は main を実行しない。
# 直接実行時のみ本体を走らせる（BASH_SOURCE == 0 判定、bash 標準イディオム）。
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
