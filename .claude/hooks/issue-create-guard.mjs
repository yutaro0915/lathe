#!/usr/bin/env node
// issue-create-guard — issue 起票コマンドを検出したら、必ずユーザー確認を要求する。
//
// 背景（2026-07-07 PdM 指示）: 監査役が PdM の明示承認なく issue を起票する違反が
// 2 度発生した（#190・#193）。「起票は PdM の明示承認のもとでのみ」を行動規範でなく
// 機械で担保する。permissionDecision=ask により対話セッションでは確認プロンプトが
// ユーザーに飛び、headless（claude -p の agent）では ask は自動拒否となる——
// つまり agent は構造的に issue を起票できない（起票の機械経路は driver の
// spawnSync 直呼びのみで、それは hook の外＝設計どおり）。
//
// 検出対象:
//   - gh issue create …
//   - gh api（POST）… repos/<o>/<r>/issues 終端（comment/label の /issues/<n>/… は対象外）
//   - GraphQL createIssue mutation
import process from 'node:process';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let input = {};
try {
  input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  process.exit(0);
}
const cmd = String(input?.tool_input?.command ?? '');

const isGhIssueCreate = /\bgh\s+issue\s+create\b/.test(cmd);
const isRestCreate =
  /\bgh\s+api\b/.test(cmd) &&
  /(-X\s*POST|--method[=\s]*POST)/.test(cmd) &&
  /repos\/[^\s/'"]+\/[^\s/'"]+\/issues(?=['"\s]|$)/.test(cmd);
const isGraphqlCreate = /createIssue\s*\(/.test(cmd);

if (!(isGhIssueCreate || isRestCreate || isGraphqlCreate)) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason:
        'issue 起票の確認: ユーザー（PdM）の明確な承認をこの起票について得ましたか？' +
        '承認のない起票は禁止です（2026-07-07 PdM 指示・違反実績 #190/#193）。',
    },
  }),
);
process.exit(0);
