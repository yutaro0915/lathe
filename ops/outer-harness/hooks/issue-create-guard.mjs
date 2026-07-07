#!/usr/bin/env node
// issue-create-guard — issue 起票コマンドを検出したら、必ずユーザー確認を要求する。
//
// 背景（2026-07-07 PdM 指示）: 監査役が PdM の明示承認なく issue を起票する違反が
// 2 度発生した（#190・#193）。「起票は PdM の明示承認のもとでのみ」を行動規範でなく
// 機械で担保する。permissionDecision=ask により対話セッションでは確認プロンプトが
// ユーザーに飛び、headless（claude -p の agent）では ask は自動拒否となる。
//
// スコープ（2026-07-07 PdM 恒久裁定・#201 comment）: 本ゲートの対象は **loop 外の起票**
// （outer が会話からユーザー意図を issue 化する場合）のみ。loop 内の機械起票——承認済み
// plan からの FILE_CHILDREN・escalation の issue 化・orchestrator の投函（いずれも driver の
// spawnSync 直呼び＝hook の外）——は親の承認で正当化済みで、個別承認は不要。planner が
// in-loop filing のために ASK_PDM で止まる必要も無い。
//
// 検出対象:
//   - gh issue create …
//   - gh api（POST）… repos/<o>/<r>/issues 終端（comment/label の /issues/<n>/… は対象外）
//   - GraphQL createIssue mutation
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * issue 起票コマンドの検出と確認要求。純関数（副作用なし）。
 * @param {{ tool_input?: { command?: string } }} input  PreToolUse hook payload
 * @returns {{ decision: 'ask', reason: string } | null}  ask = 確認要求 / null = 素通し
 */
export function decideIssueCreate(input) {
  const cmd = String(input?.tool_input?.command ?? '');
  const isGhIssueCreate = /\bgh\s+issue\s+create\b/.test(cmd);
  const isRestCreate =
    /\bgh\s+api\b/.test(cmd) &&
    /(-X\s*POST|--method[=\s]*POST)/.test(cmd) &&
    /repos\/[^\s/'"]+\/[^\s/'"]+\/issues(?=['"\s]|$)/.test(cmd);
  const isGraphqlCreate = /createIssue\s*\(/.test(cmd);
  if (!(isGhIssueCreate || isRestCreate || isGraphqlCreate)) return null;
  return {
    decision: 'ask',
    reason:
      'issue 起票の確認: ユーザー（PdM）の明確な承認をこの起票について得ましたか？' +
      '承認のない起票は禁止です（2026-07-07 PdM 指示・違反実績 #190/#193）。',
  };
}

// スクリプト本体（stdin → JSON stdout）— import 時は実行しない（top-level I/O を guard）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let input = {};
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exit(0);
  }
  const result = decideIssueCreate(input);
  if (!result) process.exit(0);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: result.decision,
        permissionDecisionReason: result.reason,
      },
    }),
  );
  process.exit(0);
}
