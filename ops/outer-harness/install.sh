#!/usr/bin/env bash
# outer harness install — repo root の対話セッション（監査役）専用の層を敷く。
# tracked .claude/ は inner 専用（#206・ADR 0036 世界）。outer 固有の統治 hook・
# 監査系 agent/skill は untracked で repo root にのみ存在する（worktree には行き渡らない）。
# 冪等。新しいマシン/クローンで 1 回実行する。
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .claude/hooks .claude/agents .claude/skills
cp -f ops/outer-harness/hooks/issue-create-guard.mjs .claude/hooks/
cp -f ops/outer-harness/agents/meta-auditor.md .claude/agents/
cp -Rf ops/outer-harness/skills/meta-audit .claude/skills/
cp -Rf ops/outer-harness/skills/result-classification .claude/skills/
if [ ! -f .claude/settings.local.json ]; then
  cp ops/outer-harness/settings.local.template.json .claude/settings.local.json
  echo "== settings.local.json を新設（issue-create-guard 配線）"
else
  if grep -q issue-create-guard .claude/settings.local.json; then
    echo "== settings.local.json 既存・issue-create-guard 配線あり OK"
  else
    node -e '
      const fs = require("node:fs");
      const p = ".claude/settings.local.json";
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      const t = JSON.parse(fs.readFileSync("ops/outer-harness/settings.local.template.json", "utf8"));
      d.hooks = d.hooks ?? {};
      d.hooks.PreToolUse = d.hooks.PreToolUse ?? [];
      d.hooks.PreToolUse.push(t.hooks.PreToolUse[0]);
      fs.writeFileSync(p, JSON.stringify(d, null, 2));
    '
    echo "== settings.local.json 既存 — issue-create-guard 配線を自動 merge した"
  fi
fi
echo "== outer harness 導入完了（対象: $(pwd)）"
