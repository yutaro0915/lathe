#!/usr/bin/env bash
# case-setup.test.sh — case-setup.sh の self_check FAIL 分岐を検証する（issue #282）。
#
# repo に bash 用の test runner は無いため、本ファイルは pnpm test（node --test）の
# 対象外。手動 / CI で `bash ops/install/case-setup.test.sh` として直接実行する
# （実装検証は本 issue の「検証」節: install self-check の FAIL 分岐 unit）。
#
# 手法: case-setup.sh を source して self_check() だけを取り出し（BASH_SOURCE guard に
# より main() は走らない）、依存が揃った基準環境からひとつずつ欠落させて
# 非ゼロ exit（FAIL）になることを確認する。
# stub コマンドの PATH を STUB_BIN のみに絞るため、stub 自体の shebang は
# `env bash`（PATH 依存）ではなく解決済み絶対パスの bash を直書きする。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASH_ABS="$(command -v bash)"
FAILED=0

pass() { echo "[PASS] $*"; }
fail() { echo "[FAIL] $*"; FAILED=1; }

write_stub() {
  # write_stub <path> <body...>
  local path="$1"; shift
  { printf '#!%s\n' "${BASH_ABS}"; printf '%s\n' "$@"; } > "${path}"
  chmod +x "${path}"
}

# ── 基準環境（全依存が揃っている状態）を stub で構築 ─────────────────────────
STUB_BIN="$(mktemp -d)"
STUB_HOME="$(mktemp -d)"
NO_PNPM_BIN="$(mktemp -d)"
AUTH_FAIL_BIN="$(mktemp -d)"
EMPTY_HOME="$(mktemp -d)"
cleanup() { rm -rf "${STUB_BIN}" "${STUB_HOME}" "${NO_PNPM_BIN}" "${AUTH_FAIL_BIN}" "${EMPTY_HOME}"; }
trap cleanup EXIT

write_stub "${STUB_BIN}/node" 'echo "v24.16.0"'
write_stub "${STUB_BIN}/pnpm" 'echo "11.10.0"'
write_stub "${STUB_BIN}/claude" 'echo "OK"' 'exit 0'
write_stub "${STUB_BIN}/gh" 'exit 0'

mkdir -p "${STUB_HOME}/.config/lathe-cf"
touch "${STUB_HOME}/.config/lathe-cf/env"

# case-setup.sh を source（main は BASH_SOURCE guard により実行されない）
# shellcheck source=./case-setup.sh
source "${SCRIPT_DIR}/case-setup.sh" --check

run_self_check() {
  local bin_dir="$1" home_dir="$2"
  (
    export PATH="${bin_dir}"
    export HOME="${home_dir}"
    ENV_FILE="${home_dir}/.config/lathe-cf/env"
    self_check
  )
}

# ── 1. 基準環境では self_check が成功する（対照） ────────────────────────────
if run_self_check "${STUB_BIN}" "${STUB_HOME}" >/dev/null 2>&1; then
  pass "self_check: 全依存が揃っていれば成功する"
else
  fail "self_check: 全依存が揃っているのに失敗した（テスト基盤の不備）"
fi

# ── 2. pnpm 欠品で FAIL する ────────────────────────────────────────────────
write_stub "${NO_PNPM_BIN}/node" 'echo "v24.16.0"'
write_stub "${NO_PNPM_BIN}/claude" 'echo "OK"' 'exit 0'
write_stub "${NO_PNPM_BIN}/gh" 'exit 0'
if run_self_check "${NO_PNPM_BIN}" "${STUB_HOME}" >/dev/null 2>&1; then
  fail "self_check: pnpm 欠品でも成功してしまった（欠落を検出できていない）"
else
  pass "self_check: pnpm 欠品で FAIL する"
fi

# ── 3. claude 認証エラー（claude -p 疎通失敗）で FAIL する ──────────────────
write_stub "${AUTH_FAIL_BIN}/node" 'echo "v24.16.0"'
write_stub "${AUTH_FAIL_BIN}/pnpm" 'echo "11.10.0"'
write_stub "${AUTH_FAIL_BIN}/gh" 'exit 0'
write_stub "${AUTH_FAIL_BIN}/claude" 'echo "Not logged in · Please run /login" >&2' 'exit 1'
if run_self_check "${AUTH_FAIL_BIN}" "${STUB_HOME}" >/dev/null 2>&1; then
  fail "self_check: claude -p 疎通失敗でも成功してしまった"
else
  pass "self_check: claude -p 疎通失敗（未認証）で FAIL する"
fi

# ── 4. EnvironmentFile 欠落で FAIL する ─────────────────────────────────────
if run_self_check "${STUB_BIN}" "${EMPTY_HOME}" >/dev/null 2>&1; then
  fail "self_check: EnvironmentFile 欠落でも成功してしまった"
else
  pass "self_check: EnvironmentFile 欠落で FAIL する"
fi

if [[ "${FAILED}" -eq 0 ]]; then
  echo "=== case-setup.test.sh: 全 assertion PASS ==="
  exit 0
else
  echo "=== case-setup.test.sh: FAIL あり ===" >&2
  exit 1
fi
