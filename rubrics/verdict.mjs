#!/usr/bin/env node
// rubrics/verdict.mjs — run validity の分類・集約層（run.mjs の前段・純関数、ADR 0022 前線2）。
//   module: import { classifyCheck, aggregate } from './verdict.mjs'（負テスト対象＝eval run-validity-v1 criterion 6）
//
// 設計（ADR 0022）:
//   5 値 = pass / fail / warn / invalid / not-run。
//   classifyCheck: procedureFailure が最優先（harness 帰属の invalid）。次に ok の真偽と severity で分類。
//     ok=true → pass。ok=false かつ severity=blocker → fail。ok=false かつ severity=major|minor → warn。
//     ok=false かつ severity 無し（v1 rubric）→ fail（現状維持既定、ADR §3 の等価性要請）。
//   aggregate: fail か invalid が 1 つでもあれば stop=true。warn のみ・not-run は stop に寄与しない。

// classifyCheck({ ok, severity, procedureFailure }) → 'pass'|'fail'|'warn'|'invalid'
//   ok: boolean（evalExpect の真偽）
//   severity: 'blocker'|'major'|'minor'|undefined（rubric check の severity。v1 rubric は undefined）
//   procedureFailure: { kind: string, detail: string } | null|undefined
//     kind は ADR §2 の invalid 検知 5 類のいずれか（verifier-resolution / missing-channel / extract-failure /
//     judge-verdict-missing / judge-binding-resolution 等、呼び出し側が付与する識別子）。
export function classifyCheck({ ok, severity, procedureFailure } = {}) {
  if (procedureFailure) return 'invalid';
  if (ok) return 'pass';
  if (severity === 'major' || severity === 'minor') return 'warn';
  return 'fail'; // severity === 'blocker' もここに含む。severity 無し（v1）は現状維持既定で fail。
}

// aggregate(verdicts) → { stop: boolean, counts: {pass,fail,warn,invalid,notRun} }
//   verdicts: ('pass'|'fail'|'warn'|'invalid'|'not-run')[]
export function aggregate(verdicts = []) {
  const counts = { pass: 0, fail: 0, warn: 0, invalid: 0, notRun: 0 };
  for (const v of verdicts) {
    if (v === 'pass') counts.pass++;
    else if (v === 'fail') counts.fail++;
    else if (v === 'warn') counts.warn++;
    else if (v === 'invalid') counts.invalid++;
    else if (v === 'not-run') counts.notRun++;
  }
  return { stop: counts.fail > 0 || counts.invalid > 0, counts };
}
