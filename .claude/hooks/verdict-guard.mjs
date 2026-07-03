#!/usr/bin/env node
// verdict-guard.mjs — headless inner-loop stage の Stop hook（暫定、2026-07-03 PdM 裁可）
//
// 発火条件: env LATHE_STAGE がある claude 子セッションのみ（driver が stage 名を付与する。
// 対話セッションには影響しない）。最終 assistant メッセージが `VERDICT: <TOKEN>` で
// 終わっていない停止をブロックし、残作業の完遂と最終フォーマット出力を促す。
//
// 保証範囲は「形式」のみ（verdict の有無）。実質＝作業完了の保証は役割契約・evidence・
// receipt ゲート・merge gate の層が担う。1 回ブロック後（stop_hook_active）は素通しし、
// それでも verdict が無ければ driver の unparsable 自動再試行（#56）が backstop になる。
// 置き場・管理は harness 改善体制が整った時点で再訪する（暫定運用）。

import { readFileSync } from 'node:fs';

const stage = process.env.LATHE_STAGE;
if (!stage) process.exit(0);

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
if (input.stop_hook_active) process.exit(0);

const transcriptPath = input.transcript_path;
if (!transcriptPath) process.exit(0);

let lastAssistantText = '';
try {
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue;
    const text = entry.message.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (text.trim()) lastAssistantText = text;
  }
} catch {
  process.exit(0);
}

const lastLine = (lastAssistantText.trim().split('\n').pop() ?? '').trim();
if (/^VERDICT:\s*[A-Z_]+$/.test(lastLine)) process.exit(0);

const verifyClause = stage === 'VERIFY' ? '全 check の GREEN/RED と evidence を含む' : '';
console.log(
  JSON.stringify({
    decision: 'block',
    reason:
      `あなたのタスク（stage: ${stage}）はまだ完了していません。` +
      '残りの作業を最後まで実行してから終了してください。' +
      '作業を完了せずに VERDICT だけを出力することは禁止です。' +
      `完了後、${verifyClause}最終フォーマットを出力し、最終行を「VERDICT: <TOKEN>」にしてください。`,
  }),
);
process.exit(0);
