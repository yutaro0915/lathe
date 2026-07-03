#!/usr/bin/env node
// rubrics/_verifier-schema.mjs — verifier.json（named verifier）の必須要素を検証する（ADR 0020 前線 C）。
//   CLI:    node rubrics/_verifier-schema.mjs [verifiers-dir]  → 全 verifier.json を走査し違反を
//           `VIOLATION <id> <理由>` で出力（exit 0。判定は meta/verifier-schema の grep -c）。
//   module: import { validateVerifier } from './_verifier-schema.mjs'  → 負テスト用。
//
// 形式の正本: ADR 0020 §1（handoff §3 準拠＋lathe 追加の extract/source）。
//   kind=cmd:          run（1 run 1 回実行）+ produces（名前つきチャンネル。type=count|measure、
//                      means、値の取り出しは extract（出力を stdin に受ける）か source:"exit"）
//   kind=judge-runner: bindings（要求クラス→provider/model）+ error_tolerance + calibration
//                      （クラスごと）。prompt は持たない（rubric 側）。produces は verdict 型のみ。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

const KINDS = ['cmd', 'judge-runner'];
const CMD_CHANNEL_TYPES = ['count', 'measure'];

export function validateVerifier(v, id) {
  const out = [];
  const add = (msg) => out.push(msg);
  if (!v || typeof v !== 'object') { add('verifier が object でない'); return out; }
  if (v.id !== id) add(`id "${v.id}" がディレクトリ "${id}" と不一致`);
  if (!v.version) add('version 欠落');
  if (!KINDS.includes(v.kind)) add(`kind は ${KINDS.join('|')} 必須（現: ${v.kind}）`);
  if (!v.limits) add('limits 欠落（検査の限界の自己申告は必須）');

  if (v.kind === 'cmd') {
    if (!v.run || typeof v.run !== 'string') add('kind=cmd なら run 必須（1 run につき 1 回実行されるコマンド）');
    const channels = v.produces && typeof v.produces === 'object' ? Object.entries(v.produces) : [];
    if (channels.length === 0) add('produces は 1 チャンネル以上必須');
    for (const [name, ch] of channels) {
      if (!ch || typeof ch !== 'object') { add(`channel "${name}" が object でない`); continue; }
      if (!CMD_CHANNEL_TYPES.includes(ch.type)) add(`channel "${name}" の type は ${CMD_CHANNEL_TYPES.join('|')} 必須（現: ${ch.type}）`);
      if (!ch.means) add(`channel "${name}" の means 欠落`);
      const source = ch.source ?? 'output';
      if (source === 'exit') {
        if (ch.extract) add(`channel "${name}" は source:"exit" と extract を同時に持てない`);
      } else if (source === 'output') {
        if (!ch.extract) add(`channel "${name}" は extract 必須（source:"output" 既定。exit code を読むなら source:"exit"）`);
      } else {
        add(`channel "${name}" の source は output|exit のみ（現: ${source}）`);
      }
    }
  }

  if (v.kind === 'judge-runner') {
    const channels = v.produces && typeof v.produces === 'object' ? Object.entries(v.produces) : [];
    if (channels.length === 0) add('produces は 1 チャンネル以上必須');
    for (const [name, ch] of channels) {
      if (!ch || ch.type !== 'verdict') add(`judge-runner の channel "${name}" は type:"verdict" のみ`);
    }
    const bindings = v.bindings && typeof v.bindings === 'object' ? Object.entries(v.bindings) : [];
    if (bindings.length === 0) add('bindings は 1 クラス以上必須（要求クラス→provider/model）');
    for (const [cls, b] of bindings) {
      if (!b || typeof b !== 'object' || !b.provider) add(`class "${cls}" の provider 欠落`);
      if (b && typeof b === 'object' && !('model' in b)) add(`class "${cls}" の model キー欠落（provider 既定なら null を明示）`);
    }
    if (!v.error_tolerance) add('error_tolerance 欠落（誤り許容方針の書式）');
    if (!v.calibration || typeof v.calibration !== 'object') add('calibration 欠落（クラスごとの校正手順）');
    else for (const [cls] of bindings) {
      if (!(cls in v.calibration)) add(`calibration にクラス "${cls}" のエントリが無い（未整備なら空配列＋整備予定を明示）`);
    }
    if (v.run) add('judge-runner は run を持たない（実行は run.mjs の judge 経路。prompt は rubric 側）');
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const dir = process.argv[2] ?? join(basename('.') === '.' ? '.' : '.', 'verifiers');
  const root = existsSync(dir) ? dir : null;
  if (root) {
    for (const e of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const f = join(root, e.name, 'verifier.json');
      if (!existsSync(f)) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(f, 'utf8'));
      } catch (err) {
        console.log(`VIOLATION ${e.name} verifier.json が JSON として不正: ${err.message}`);
        continue;
      }
      for (const msg of validateVerifier(parsed, e.name)) console.log(`VIOLATION ${e.name} ${msg}`);
    }
  }
  process.exit(0);
}
