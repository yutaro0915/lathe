#!/usr/bin/env node
// ui-skill-guard — PreToolUse(Edit|Write)
// UI ファイル（design-system / components の tsx/ts/css）を編集する時、lathe-ui skill の手順と
// 対応する機械 gate を必ず context へ注入する。「UI を行う際は skill を使わせ・DS を守らせる」
// 運用層（dev harness）の hook。DS governance P5。
import { readFileSync } from "node:fs";

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  process.exit(0);
}
let data;
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0);
}

const fp = data?.tool_input?.file_path || "";
const isUI =
  /(^|\/)apps\/web\/design-system\/|(^|\/)apps\/web\/components\//.test(fp) &&
  /\.(tsx?|css)$/.test(fp);
// stories / contracts / 生成物 はガイド対象だが過剰提示を避け、編集の主対象（component/css）に限定しない
// ＝ UI 配下なら一律提示（軽い注入）。
if (!isUI) process.exit(0);

const msg = [
  "【lathe-ui】UI を編集します。`.claude/skills/lathe-ui/SKILL.md` の手順に従ってください:",
  "① 既存 primitive を再利用（`@/design-system/components`）。無ければ ds に足す。feature 内に手書きしない。",
  "② 値は token から取る（生 px / 生 hex 禁止。spacing は `--sp-*` の 4px グリッド、色は `var(--token)`）。",
  "③ feature 同士の内部 import 禁止（再利用は ds か top-level 公開層＝共有部品・feature entry 経由）。",
  "④ primitive を足したら `contracts/<C>.contract.json` と `<C>.stories.tsx` も同時に足し、`pnpm gen:design` で DESIGN.md を再生成。",
  "違反は merge gate が停止: no-raw-primitives / spacing-from-token / token-consistency / ds-reuse-not-reimplement / feature-internals-private / contract-coverage / story-coverage / design-md-drift / dep-alias-resolution。",
].join("\n");

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: msg,
    },
  }),
);
process.exit(0);
