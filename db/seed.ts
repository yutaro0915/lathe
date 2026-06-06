// db/seed.ts — populate data/lathe.db with realistic Phase 1 data.
//
//   pnpm -C /Users/cherie/LLMWiki/projects/lathe seed
//
// Deletes any existing data/lathe.db (+ -wal/-shm), opens a fresh database,
// executes db/schema.sql, then inserts a richly-detailed primary session
// (the "Lathe rebuild from scratch" run) plus five lighter sessions for the
// left-hand list. Attribution rows reference real transcript_events ids so the
// screen-B "Linked Events" join resolves. Prints a one-line row-count summary.
//
// node:sqlite prints an ExperimentalWarning at runtime — harmless, not an error.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'lathe.db');
const SCHEMA_PATH = path.join(ROOT, 'db', 'schema.sql');

// ---- reset -----------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  const p = DB_PATH + suffix;
  if (fs.existsSync(p)) fs.rmSync(p);
}

const db = new DatabaseSync(DB_PATH);
db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// ---- prepared statements ---------------------------------------------------

const insSession = db.prepare(
  `INSERT INTO sessions
     (id, project, title, runner, model, status, started_at, ended_at, duration_ms,
      turn_count, tool_count, edit_count, bash_count, subagent_count, token_usage,
      cost_usd, summary, seq)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
const insEvent = db.prepare(
  `INSERT INTO transcript_events
     (id, session_id, seq, ts, type, actor, title, body, file_path, command,
      exit_code, duration_ms, token_usage, subagent, meta)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);
const insChangedFile = db.prepare(
  `INSERT INTO changed_files
     (id, session_id, path, status, additions, deletions, language, seq)
   VALUES (?,?,?,?,?,?,?,?)`
);
const insHunk = db.prepare(
  `INSERT INTO diff_hunks (id, file_id, seq, header, content) VALUES (?,?,?,?,?)`
);
const insAttribution = db.prepare(
  `INSERT INTO attributions (id, hunk_id, event_id, confidence, method, note)
   VALUES (?,?,?,?,?,?)`
);
const insEventFile = db.prepare(
  `INSERT INTO event_files (event_id, path, role) VALUES (?,?,?)`
);
const insAnnotation = db.prepare(
  `INSERT INTO annotations (session_id, at_seq, kind, note) VALUES (?,?,?,?)`
);

const counters = {
  sessions: 0,
  events: 0,
  changed_files: 0,
  hunks: 0,
  attributions: 0,
  event_files: 0,
  annotations: 0,
};

// ---- typed event spec ------------------------------------------------------

type EventSpec = {
  type: string;
  actor: string;
  ts: string;
  title: string;
  body?: string | null;
  filePath?: string | null;
  command?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  tokenUsage?: number | null;
  subagent?: string | null;
  meta?: string | null;
  files?: { path: string; role: 'read' | 'edit' | 'write' }[];
};

// =========================================================================
// PRIMARY SESSION — ses_2026-06-04_lathe-rebuild (seq = 1)
// =========================================================================

const PRIMARY = 'ses_2026-06-04_lathe-rebuild';

insSession.run(
  PRIMARY,
  'LLMWiki / lathe',
  'Lathe rebuild from scratch',
  'claude-code',
  'claude-opus-4-8',
  'done',
  '2026-06-04 09:12:00',
  '2026-06-04 10:46:30',
  5670000,
  48,
  126,
  23,
  31,
  4,
  1243000,
  12.4,
  'Phase 1 viewer: transcript ingest + git diff attribution の足場',
  1
);
counters.sessions++;

// The primary timeline. Event ids are evt_0001..evt_00NN (seq-aligned).
const primaryEvents: EventSpec[] = [
  {
    type: 'user_message',
    actor: 'user',
    ts: '09:12:00',
    title: 'Lathe を一から立て直したい',
    body:
      'Lathe Phase 1 をゼロから組み直したい。Next.js (App Router, TS) + SQLite で、' +
      'トランスクリプト表示と git 差分の帰属を見られる土台を作って。まずデータ基盤とアプリの殻から。',
    tokenUsage: 320,
  },
  {
    type: 'assistant_message',
    actor: 'assistant',
    ts: '09:12:48',
    title: '計画: schema → db 層 → seed → 殻 → 2画面',
    body:
      '了解。順番に進めます。\n' +
      '1) db/schema.sql で sessions / transcript_events / changed_files / diff_hunks / attributions を定義\n' +
      '2) lib/db.ts (node:sqlite の lazy singleton, snake_case→camelCase)\n' +
      '3) db/seed.ts でリアルな Phase 1 データ投入\n' +
      '4) app/layout.tsx の白テーマ殻 + globals.css\n' +
      '5) セッションビューアと git 差分・帰属の2画面',
    durationMs: 7400,
    tokenUsage: 1820,
  },
  {
    type: 'file_read',
    actor: 'assistant',
    ts: '09:13:30',
    title: 'package.json を確認',
    filePath: 'package.json',
    body: 'next ^15.5.4 / react ^19 / tsx ^4.19。scripts に seed が無いので追加が要る。',
    durationMs: 420,
    files: [{ path: 'package.json', role: 'read' }],
  },
  {
    type: 'file_write',
    actor: 'assistant',
    ts: '09:14:12',
    title: 'package.json に seed スクリプトを追加',
    filePath: 'package.json',
    body: '"seed": "tsx db/seed.ts" を scripts に追加。better-sqlite3 ではなく node:sqlite を使う。',
    durationMs: 980,
    tokenUsage: 640,
    files: [{ path: 'package.json', role: 'write' }],
  },
  {
    type: 'bash',
    actor: 'assistant',
    ts: '09:15:02',
    title: 'pnpm install',
    command: 'pnpm install',
    body:
      'Lockfile is up to date, resolution step is skipped\n' +
      'Packages: +312\nProgress: resolved 312, reused 312, downloaded 0, added 312, done\nDone in 4.1s',
    exitCode: 0,
    durationMs: 4180,
    files: [{ path: 'package.json', role: 'read' }],
  },
  {
    type: 'file_write',
    actor: 'assistant',
    ts: '09:17:40',
    title: 'db/schema.sql を作成',
    filePath: 'db/schema.sql',
    body:
      '7 テーブル: sessions, transcript_events, changed_files, diff_hunks, attributions, ' +
      'event_files, annotations。後続フェーズ(finding 等)はあえて作らない。',
    durationMs: 2600,
    tokenUsage: 3120,
    files: [{ path: 'db/schema.sql', role: 'write' }],
  },
  {
    type: 'file_write',
    actor: 'assistant',
    ts: '09:21:18',
    title: 'lib/db.ts を作成',
    filePath: 'lib/db.ts',
    body:
      'DatabaseSync の lazy singleton。getPrimarySession / listSessions / getEvents / ' +
      'getChangedFiles / getHunks / getAttributionsForHunk / getLinkedEventsForFile などを export。',
    durationMs: 3300,
    tokenUsage: 4210,
    files: [
      { path: 'lib/types.ts', role: 'read' },
      { path: 'lib/db.ts', role: 'write' },
    ],
  },
  {
    type: 'file_write',
    actor: 'assistant',
    ts: '09:25:55',
    title: 'db/seed.ts を作成',
    filePath: 'db/seed.ts',
    body: 'primary セッション + 軽量な 5 セッション。attribution は実 event id を参照させる。',
    durationMs: 4100,
    tokenUsage: 5380,
    files: [{ path: 'db/seed.ts', role: 'write' }],
  },
  {
    type: 'bash',
    actor: 'assistant',
    ts: '09:27:10',
    title: 'pnpm seed',
    command: 'pnpm seed',
    body:
      '(node:48211) ExperimentalWarning: SQLite is an experimental feature\n' +
      '[seed] sessions=6 events=37 changed_files=6 hunks=9 attributions=9 event_files=10 annotations=6',
    exitCode: 0,
    durationMs: 1260,
  },
  {
    type: 'assistant_message',
    actor: 'assistant',
    ts: '09:28:05',
    title: 'データ基盤 OK。次は UI の殻',
    body: 'seed が通った。app/layout.tsx と globals.css で白テーマの IDE 風シェルを組む。',
    durationMs: 5200,
    tokenUsage: 1410,
  },
  {
    type: 'file_edit',
    actor: 'assistant',
    ts: '09:31:42',
    title: 'app/page.tsx をセッションビューアに',
    filePath: 'app/page.tsx',
    body: 'サイドバー(セッション一覧) | タイムライン | 詳細 aside + minimap の3カラム。',
    durationMs: 2900,
    tokenUsage: 3680,
    files: [{ path: 'app/page.tsx', role: 'edit' }],
  },
  {
    type: 'subagent',
    actor: 'timeline-builder',
    ts: '09:36:20',
    title: 'サブエージェント: timeline-builder を起動',
    body:
      'components/timeline.tsx と components/event-detail.tsx を別コンテキストで構築。' +
      'イベント種別ごとのアイコン・バッジ・行レイアウトを担当。',
    durationMs: 61000,
    tokenUsage: 28400,
    subagent: 'timeline-builder',
  },
  {
    type: 'file_write',
    actor: 'timeline-builder',
    ts: '09:38:02',
    title: 'components/timeline.tsx を作成',
    filePath: 'components/timeline.tsx',
    body: 'event-row グリッド(seq | 時刻 | アイコン | 本文 | meta)。nested で subagent をインデント。',
    durationMs: 7200,
    tokenUsage: 6100,
    subagent: 'timeline-builder',
    files: [{ path: 'components/timeline.tsx', role: 'write' }],
  },
  {
    type: 'file_write',
    actor: 'timeline-builder',
    ts: '09:41:30',
    title: 'components/event-detail.tsx を作成',
    filePath: 'components/event-detail.tsx',
    body: '選択イベントの kv 表示 + linked-files + コードブロック。',
    durationMs: 5400,
    tokenUsage: 4900,
    subagent: 'timeline-builder',
    files: [{ path: 'components/event-detail.tsx', role: 'write' }],
  },
  {
    type: 'bash',
    actor: 'timeline-builder',
    ts: '09:43:10',
    title: 'tsc --noEmit (timeline 周りの型チェック)',
    command: 'pnpm tsc --noEmit',
    body: '型エラーなし。timeline-builder 完了、メインに復帰。',
    exitCode: 0,
    durationMs: 9800,
    subagent: 'timeline-builder',
  },
  {
    type: 'assistant_message',
    actor: 'assistant',
    ts: '09:46:00',
    title: 'タイムライン部品が揃った。ビルド確認',
    body: 'timeline-builder が components を作成。一度ビルドして配線を確認する。',
    durationMs: 3100,
    tokenUsage: 1180,
  },
  {
    type: 'bash',
    actor: 'assistant',
    ts: '09:47:25',
    title: 'pnpm build (失敗)',
    command: 'pnpm build',
    body:
      './lib/db.ts:262:7\nType error: Argument of type \'string | undefined\' is not ' +
      "assignable to parameter of type 'string'.\n  Type 'undefined' is not assignable to " +
      "type 'string'.\n  260 |   const row = getDb()\n  261 |     .prepare('SELECT * FROM " +
      "sessions WHERE id = ?')\n> 262 |     .get(id)\n      |       ^",
    exitCode: 1,
    durationMs: 16700,
  },
  {
    type: 'error',
    actor: 'assistant',
    ts: '09:47:42',
    title: 'TS2345: getSession の id が string | undefined',
    body:
      'getLinkedEventsForFile の戻り型と getSession の引数で undefined が混入。' +
      'node:sqlite の .get() は undefined を返し得るので呼び出し側のガードが必要。',
    meta: '{"code":"TS2345","file":"lib/db.ts","line":262}',
  },
  {
    type: 'file_edit',
    actor: 'assistant',
    ts: '09:50:18',
    title: 'lib/db.ts を修正 (undefined ガード)',
    filePath: 'lib/db.ts',
    body:
      '.get() の結果を `as unknown as Row | undefined` でキャストし、' +
      'undefined を明示的に分岐。getLinkedEventsForFile は event_id IS NOT NULL で絞る。',
    durationMs: 3400,
    tokenUsage: 2960,
    files: [{ path: 'lib/db.ts', role: 'edit' }],
  },
  {
    type: 'bash',
    actor: 'assistant',
    ts: '09:53:40',
    title: 'pnpm build (成功)',
    command: 'pnpm build',
    body:
      '▲ Next.js 15.5.4\n  Creating an optimized production build ...\n' +
      ' ✓ Compiled successfully\n  Linting and checking validity of types ...\n' +
      ' ✓ Generating static pages (4/4)\n  Route (app)            Size   First Load JS\n' +
      '  ○ /                  1.2 kB        96 kB\n  ○ /diff              1.1 kB        96 kB',
    exitCode: 0,
    durationMs: 22300,
  },
  {
    type: 'test',
    actor: 'assistant',
    ts: '09:55:30',
    title: 'pnpm test (db 層のスモーク)',
    command: 'pnpm test',
    body:
      'db smoke: getPrimarySession() returns seq=1  ✓\n' +
      'db smoke: getLinkedEventsForFile resolves events  ✓\n' +
      '2 passed (0 failed)',
    exitCode: 0,
    durationMs: 3900,
    tokenUsage: 410,
  },
  {
    type: 'skill',
    actor: 'assistant',
    ts: '09:58:10',
    title: 'skill: html-effectiveness で詳細パネルを点検',
    body: '詳細 aside の情報密度をスキルのガイドラインで確認。kv + linked-files の階層を調整。',
    durationMs: 5200,
    tokenUsage: 2100,
    meta: '{"skill":"html-effectiveness"}',
  },
  {
    type: 'todo',
    actor: 'assistant',
    ts: '10:01:00',
    title: 'TODO: 残タスクを整理',
    body:
      '[x] schema / db 層 / seed\n[x] レイアウト殻\n[x] タイムライン\n' +
      '[ ] git 差分画面の帰属トラック\n[ ] minimap の playhead 同期',
    meta: '{"open":2,"done":3}',
  },
  {
    type: 'file_edit',
    actor: 'assistant',
    ts: '10:05:30',
    title: 'app/diff/page.tsx を git 差分画面に',
    filePath: 'app/diff/page.tsx',
    body: 'ファイルツリー | 差分本体 | 帰属 aside。hunk ごとに confidence を色分け。',
    durationMs: 3600,
    tokenUsage: 4020,
    files: [{ path: 'app/diff/page.tsx', role: 'edit' }],
  },
  {
    type: 'file_edit',
    actor: 'assistant',
    ts: '10:09:14',
    title: 'app/globals.css に diff/attribution スタイル追加',
    filePath: 'app/globals.css',
    body: 'diff-line(add/del) と attr-track / hunk-coverage / minimap-tick を追加。',
    durationMs: 4200,
    tokenUsage: 3550,
    files: [{ path: 'app/globals.css', role: 'edit' }],
  },
  {
    type: 'bash',
    actor: 'assistant',
    ts: '10:13:50',
    title: 'prettier で globals.css を整形',
    command: 'pnpm prettier --write app/globals.css',
    body: 'app/globals.css 210ms\n1 file changed (フォーマットのみ、論理変更なし)',
    exitCode: 0,
    durationMs: 980,
    files: [{ path: 'app/globals.css', role: 'write' }],
  },
  {
    type: 'commit',
    actor: 'assistant',
    ts: '10:21:05',
    title: 'feat(phase1): session viewer + transcript ingest',
    body:
      '[main 4f1c8ad] feat(phase1): session viewer + transcript ingest\n' +
      ' 8 files changed, 642 insertions(+), 22 deletions(-)\n' +
      ' create mode 100644 db/schema.sql\n create mode 100644 lib/db.ts\n' +
      ' create mode 100644 components/timeline.tsx',
    durationMs: 1400,
    meta: '{"hash":"4f1c8ad","branch":"main","files":8,"insertions":642,"deletions":22}',
  },
  {
    type: 'file_edit',
    actor: 'assistant',
    ts: '10:28:40',
    title: 'components/timeline.tsx を微調整',
    filePath: 'components/timeline.tsx',
    body: 'minimap の playhead を選択イベントの seq に同期。空状態のコピーを追加。',
    durationMs: 2700,
    tokenUsage: 1880,
    files: [{ path: 'components/timeline.tsx', role: 'edit' }],
  },
  {
    type: 'file_edit',
    actor: 'assistant',
    ts: '10:33:12',
    title: 'lib/db.ts に countEventsByType を追加',
    filePath: 'lib/db.ts',
    body: 'メトリクス帯のイベント種別カウント用に集計クエリを追加。',
    durationMs: 1900,
    tokenUsage: 1320,
    files: [{ path: 'lib/db.ts', role: 'edit' }],
  },
  {
    type: 'bash',
    actor: 'assistant',
    ts: '10:38:55',
    title: 'pnpm build (再確認)',
    command: 'pnpm build',
    body: ' ✓ Compiled successfully\n ✓ Generating static pages (4/4)',
    exitCode: 0,
    durationMs: 19800,
  },
  {
    type: 'assistant_message',
    actor: 'assistant',
    ts: '10:46:30',
    title: '完了: Phase 1 の土台が立った',
    body:
      'データ基盤 + 殻 + 2画面が動作。schema/db層/seed と layout・timeline・diff を実装。' +
      'ビルド・スモークテストとも green。次フェーズの finding / fixture_run は未着手のまま据え置き。',
    durationMs: 6800,
    tokenUsage: 2240,
  },
];

// Insert primary events with seq-aligned ids; remember ids we need for
// attribution wiring.
const evtId = (seq: number) => `evt_${String(seq).padStart(4, '0')}`;
const idByTitleKey: Record<string, string> = {};

primaryEvents.forEach((e, i) => {
  const seq = i + 1;
  const id = evtId(seq);
  insEvent.run(
    id,
    PRIMARY,
    seq,
    e.ts,
    e.type,
    e.actor,
    e.title,
    e.body ?? null,
    e.filePath ?? null,
    e.command ?? null,
    e.exitCode ?? null,
    e.durationMs ?? null,
    e.tokenUsage ?? null,
    e.subagent ?? null,
    e.meta ?? null
  );
  counters.events++;
  idByTitleKey[e.title] = id;
  if (e.files) {
    for (const f of e.files) {
      insEventFile.run(id, f.path, f.role);
      counters.event_files++;
    }
  }
});

// Convenience handles to the events attribution will reference.
const EVT_SCHEMA_WRITE = idByTitleKey['db/schema.sql を作成'];
const EVT_DB_WRITE = idByTitleKey['lib/db.ts を作成'];
const EVT_PAGE_EDIT = idByTitleKey['app/page.tsx をセッションビューアに'];
const EVT_TIMELINE_WRITE = idByTitleKey['components/timeline.tsx を作成'];
const EVT_INSTALL_BASH = idByTitleKey['pnpm install'];
const EVT_PRETTIER_BASH = idByTitleKey['prettier で globals.css を整形'];
const EVT_GLOBALS_EDIT = idByTitleKey['app/globals.css に diff/attribution スタイル追加'];

// ---- changed files (session diff, screen B) -------------------------------

type FileSpec = {
  id: string;
  path: string;
  status: string;
  additions: number;
  deletions: number;
  language: string;
  hunks: {
    id: string;
    header: string;
    content: string;
    attr: {
      eventId: string | null;
      confidence: 'high' | 'medium' | 'unattributed';
      method: 'edit_event' | 'shell_inferred' | 'external' | 'dirty_worktree';
      note?: string | null;
    };
  }[];
};

const changedFiles: FileSpec[] = [
  {
    id: 'chf_001',
    path: 'db/schema.sql',
    status: 'added',
    additions: 92,
    deletions: 0,
    language: 'sql',
    hunks: [
      {
        id: 'hnk_001',
        header: '@@ -0,0 +1,38 @@ CREATE TABLE sessions',
        content:
          '+PRAGMA foreign_keys = ON;\n' +
          '+\n' +
          '+CREATE TABLE IF NOT EXISTS sessions (\n' +
          '+  id             TEXT PRIMARY KEY,\n' +
          '+  project        TEXT NOT NULL,\n' +
          '+  title          TEXT NOT NULL,\n' +
          '+  runner         TEXT NOT NULL,\n' +
          '+  model          TEXT,\n' +
          '+  status         TEXT NOT NULL,\n' +
          '+  started_at     TEXT NOT NULL,\n' +
          '+  ended_at       TEXT,\n' +
          '+  duration_ms    INTEGER,\n' +
          '+  seq            INTEGER NOT NULL DEFAULT 0\n' +
          '+);',
        attr: { eventId: EVT_SCHEMA_WRITE, confidence: 'high', method: 'edit_event' },
      },
      {
        id: 'hnk_002',
        header: '@@ -0,0 +39,54 @@ CREATE TABLE attributions',
        content:
          '+CREATE TABLE IF NOT EXISTS attributions (\n' +
          '+  id          TEXT PRIMARY KEY,\n' +
          '+  hunk_id     TEXT NOT NULL REFERENCES diff_hunks(id),\n' +
          '+  event_id    TEXT REFERENCES transcript_events(id),\n' +
          '+  confidence  TEXT NOT NULL,\n' +
          '+  method      TEXT NOT NULL,\n' +
          '+  note        TEXT\n' +
          '+);',
        attr: { eventId: EVT_SCHEMA_WRITE, confidence: 'high', method: 'edit_event' },
      },
    ],
  },
  {
    id: 'chf_002',
    path: 'lib/db.ts',
    status: 'added',
    additions: 138,
    deletions: 0,
    language: 'typescript',
    hunks: [
      {
        id: 'hnk_003',
        header: '@@ -0,0 +1,18 @@ import { DatabaseSync }',
        content:
          "+import { DatabaseSync } from 'node:sqlite';\n" +
          "+import path from 'node:path';\n" +
          "+import type { Session, TranscriptEvent } from './types';\n" +
          '+\n' +
          '+let _db: DatabaseSync | undefined;\n' +
          '+\n' +
          '+export function getDb(): DatabaseSync {\n' +
          '+  if (!_db) {\n' +
          "+    const p = path.join(process.cwd(), 'data', 'lathe.db');\n" +
          '+    _db = new DatabaseSync(p);\n' +
          '+  }\n' +
          '+  return _db;\n' +
          '+}',
        attr: { eventId: EVT_DB_WRITE, confidence: 'high', method: 'edit_event' },
      },
      {
        id: 'hnk_004',
        header: '@@ -0,0 +19,22 @@ export function listSessions',
        content:
          '+export function listSessions(): Session[] {\n' +
          '+  const rows = getDb()\n' +
          "+    .prepare('SELECT * FROM sessions ORDER BY seq ASC')\n" +
          '+    .all() as unknown as SessionRow[];\n' +
          '+  return rows.map(toSession);\n' +
          '+}',
        attr: { eventId: EVT_DB_WRITE, confidence: 'high', method: 'edit_event' },
      },
    ],
  },
  {
    id: 'chf_003',
    path: 'app/page.tsx',
    status: 'modified',
    additions: 74,
    deletions: 9,
    language: 'tsx',
    hunks: [
      {
        id: 'hnk_005',
        header: '@@ -1,9 +1,28 @@ export default function SessionViewer',
        content:
          '-export default function VibeScene() {\n' +
          '-  const archive = getActiveArchive();\n' +
          '-  return <main className="scene">building…</main>;\n' +
          '-}\n' +
          "+import { getPrimarySession, getEvents } from '@/lib/db';\n" +
          '+\n' +
          '+export default function SessionViewer() {\n' +
          '+  const session = getPrimarySession();\n' +
          '+  const events = getEvents(session.id);\n' +
          '+  return (\n' +
          '+    <div className="layout3">\n' +
          '+      <Sidebar />\n' +
          '+      <Timeline events={events} />\n' +
          '+      <Detail />\n' +
          '+    </div>\n' +
          '+  );\n' +
          '+}',
        attr: { eventId: EVT_PAGE_EDIT, confidence: 'high', method: 'edit_event' },
      },
    ],
  },
  {
    id: 'chf_004',
    path: 'components/timeline.tsx',
    status: 'added',
    additions: 121,
    deletions: 0,
    language: 'tsx',
    hunks: [
      {
        id: 'hnk_006',
        header: '@@ -0,0 +1,24 @@ export function Timeline',
        content:
          "+import type { TranscriptEvent } from '@/lib/types';\n" +
          '+\n' +
          '+export function Timeline({ events }: { events: TranscriptEvent[] }) {\n' +
          '+  return (\n' +
          '+    <div className="timeline">\n' +
          '+      {events.map((e) => (\n' +
          '+        <div key={e.id} className="event-row">\n' +
          '+          <span className="event-seq">{e.seq}</span>\n' +
          '+          <span className="event-gutter">{e.ts}</span>\n' +
          '+          <span className={`event-icon ${e.type}`} />\n' +
          '+          <div className="event-main">{e.title}</div>\n' +
          '+        </div>\n' +
          '+      ))}\n' +
          '+    </div>\n' +
          '+  );\n' +
          '+}',
        attr: { eventId: EVT_TIMELINE_WRITE, confidence: 'high', method: 'edit_event' },
      },
    ],
  },
  {
    id: 'chf_005',
    path: 'package.json',
    status: 'modified',
    additions: 7,
    deletions: 1,
    language: 'json',
    hunks: [
      {
        id: 'hnk_007',
        header: '@@ -6,7 +6,13 @@   "scripts": {',
        content:
          '   "scripts": {\n' +
          '     "dev": "next dev",\n' +
          '     "build": "next build",\n' +
          '-    "start": "next start"\n' +
          '+    "start": "next start",\n' +
          '+    "seed": "tsx db/seed.ts"\n' +
          '   },',
        attr: {
          eventId: EVT_INSTALL_BASH,
          confidence: 'medium',
          method: 'shell_inferred',
          note: 'pnpm install 実行時に package manager がフィールド順を正規化した可能性',
        },
      },
    ],
  },
  {
    id: 'chf_006',
    path: 'app/globals.css',
    status: 'modified',
    additions: 210,
    deletions: 12,
    language: 'css',
    hunks: [
      {
        id: 'hnk_008',
        header: '@@ -120,12 +120,98 @@ .diff-line',
        content:
          '+.diff-line{display:grid;grid-template-columns:44px 44px 16px 1fr;white-space:pre;}\n' +
          '+.diff-line.add{background:var(--add-bg);}\n' +
          '+.diff-line.add .ltext{color:var(--add-text);}\n' +
          '+.diff-line.del{background:var(--del-bg);}\n' +
          '+.diff-line.del .ltext{color:var(--del-text);}\n' +
          '+.attr-track{position:relative;display:flex;align-items:center;height:56px;}\n' +
          '+.hunk-coverage{padding:12px 14px;border-top:1px solid var(--border);}',
        attr: { eventId: EVT_GLOBALS_EDIT, confidence: 'high', method: 'edit_event' },
      },
      {
        id: 'hnk_009',
        header: '@@ -228,12 +314,8 @@ ::-webkit-scrollbar',
        content:
          ' ::-webkit-scrollbar{width:11px;height:11px;}\n' +
          '-::-webkit-scrollbar-thumb{background:#ccc;border-radius:5px;}\n' +
          '-::-webkit-scrollbar-thumb:hover{background:#bbb;}\n' +
          '-.legacy-navy{background:#0b1f3a;color:#dfe7f5;}\n' +
          '-.legacy-navy .panel{background:#10294a;}\n' +
          '+::-webkit-scrollbar-thumb{background:#d7dbe0;border-radius:6px;border:3px solid transparent;background-clip:padding-box;}\n' +
          '+::-webkit-scrollbar-thumb:hover{background:#c2c8d0;background-clip:padding-box;}',
        attr: {
          eventId: null,
          confidence: 'unattributed',
          method: 'dirty_worktree',
          note: '既存の未コミット変更。エージェントに帰属できない',
        },
      },
    ],
  },
];

for (const f of changedFiles) {
  insChangedFile.run(
    f.id,
    PRIMARY,
    f.path,
    f.status,
    f.additions,
    f.deletions,
    f.language,
    changedFiles.indexOf(f) + 1
  );
  counters.changed_files++;
  f.hunks.forEach((h, hi) => {
    insHunk.run(h.id, f.id, hi + 1, h.header, h.content);
    counters.hunks++;
    insAttribution.run(
      `att_${h.id.slice(4)}`,
      h.id,
      h.attr.eventId,
      h.attr.confidence,
      h.attr.method,
      h.attr.note ?? null
    );
    counters.attributions++;
  });
}

// touch the prettier bash event so it isn't dangling in the story (already
// referenced narratively); keep EVT_PRETTIER_BASH referenced to avoid unused.
void EVT_PRETTIER_BASH;

// ---- annotations (minimap markers) ----------------------------------------

// Positions align with the error / failing build / test / commit events.
const SEQ_ERROR = primaryEvents.findIndex((e) => e.type === 'error') + 1;
const SEQ_BUILD_FAIL =
  primaryEvents.findIndex((e) => e.title === 'pnpm build (失敗)') + 1;
const SEQ_BUILD_OK =
  primaryEvents.findIndex((e) => e.title === 'pnpm build (成功)') + 1;
const SEQ_TEST = primaryEvents.findIndex((e) => e.type === 'test') + 1;
const SEQ_COMMIT = primaryEvents.findIndex((e) => e.type === 'commit') + 1;
const SEQ_GLOBALS =
  primaryEvents.findIndex(
    (e) => e.title === 'app/globals.css に diff/attribution スタイル追加'
  ) + 1;

const annotationSpecs: { atSeq: number; kind: string; note: string }[] = [
  { atSeq: SEQ_BUILD_FAIL, kind: 'error', note: 'pnpm build 失敗 (TS2345 in lib/db.ts)' },
  { atSeq: SEQ_ERROR, kind: 'error', note: 'getSession の id が string | undefined' },
  { atSeq: SEQ_BUILD_OK, kind: 'note', note: 'ビルド復旧。型ガード追加後に green' },
  { atSeq: SEQ_TEST, kind: 'test', note: 'db スモークテスト 2 passed' },
  { atSeq: SEQ_GLOBALS, kind: 'edit', note: 'globals.css に diff/attribution スタイル追加' },
  { atSeq: SEQ_COMMIT, kind: 'commit', note: 'feat(phase1): session viewer + transcript ingest' },
];

for (const a of annotationSpecs) {
  insAnnotation.run(PRIMARY, a.atSeq, a.kind, a.note);
  counters.annotations++;
}

// =========================================================================
// OTHER SESSIONS (left list, seq 2..6) — lighter data
// =========================================================================

type OtherSession = {
  id: string;
  title: string;
  runner: string;
  model: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  seq: number;
  turnCount: number;
  toolCount: number;
  editCount: number;
  bashCount: number;
  subagentCount: number;
  tokenUsage: number;
  costUsd: number;
  summary: string;
  events?: EventSpec[];
};

const otherSessions: OtherSession[] = [
  {
    id: 'ses_2026-06-03_run-owner-refactor',
    title: 'Run owner refactor',
    runner: 'codex',
    model: 'gpt-5-codex',
    status: 'done',
    startedAt: '2026-06-03 14:20:00',
    endedAt: '2026-06-03 15:08:40',
    durationMs: 2920000,
    seq: 2,
    turnCount: 22,
    toolCount: 58,
    editCount: 14,
    bashCount: 11,
    subagentCount: 0,
    tokenUsage: 486000,
    costUsd: 3.9,
    summary: 'status.md の current_owner 切り替えロジックを整理',
    events: [
      {
        type: 'user_message',
        actor: 'user',
        ts: '14:20:00',
        title: 'run owner の受け渡しを直したい',
        body: 'single-writer rule を破る競合が出る。current_owner の遷移を整理して。',
        tokenUsage: 210,
      },
      {
        type: 'file_edit',
        actor: 'assistant',
        ts: '14:34:12',
        title: 'lib/owner.ts を改修',
        filePath: 'lib/owner.ts',
        body: 'claude/codex/none の遷移を state machine に。',
        durationMs: 2600,
        tokenUsage: 3100,
        files: [{ path: 'lib/owner.ts', role: 'edit' }],
      },
      {
        type: 'bash',
        actor: 'assistant',
        ts: '15:02:30',
        title: 'pnpm test',
        command: 'pnpm test',
        body: '8 passed (0 failed)',
        exitCode: 0,
        durationMs: 4200,
      },
    ],
  },
  {
    id: 'ses_2026-06-03_narrow-scheme-update',
    title: 'Narrow scheme update',
    runner: 'claude-code',
    model: 'claude-opus-4-8',
    status: 'done',
    startedAt: '2026-06-03 09:05:00',
    endedAt: '2026-06-03 09:41:18',
    durationMs: 2178000,
    seq: 3,
    turnCount: 16,
    toolCount: 39,
    editCount: 8,
    bashCount: 6,
    subagentCount: 1,
    tokenUsage: 372000,
    costUsd: 3.2,
    summary: 'attributions の method enum を狭めて検証を追加',
    events: [
      {
        type: 'user_message',
        actor: 'user',
        ts: '09:05:00',
        title: 'method の取り得る値を絞りたい',
        body: 'attribution.method を 4 値に固定して、seed 側でも検証したい。',
        tokenUsage: 180,
      },
      {
        type: 'file_edit',
        actor: 'assistant',
        ts: '09:22:40',
        title: 'lib/types.ts の AttributionMethod を更新',
        filePath: 'lib/types.ts',
        body: "edit_event | shell_inferred | external | dirty_worktree に固定。",
        durationMs: 1800,
        tokenUsage: 1240,
        files: [{ path: 'lib/types.ts', role: 'edit' }],
      },
    ],
  },
  {
    id: 'ses_2026-06-02_docs-readme-polish',
    title: 'Docs & README polish',
    runner: 'cursor',
    model: 'claude-3.7-sonnet',
    status: 'done',
    startedAt: '2026-06-02 16:40:00',
    endedAt: '2026-06-02 17:12:05',
    durationMs: 1925000,
    seq: 4,
    turnCount: 12,
    toolCount: 21,
    editCount: 6,
    bashCount: 2,
    subagentCount: 0,
    tokenUsage: 210000,
    costUsd: 1.8,
    summary: 'README の機能構成節を Phase 1 に合わせて整理',
    events: [
      {
        type: 'file_edit',
        actor: 'assistant',
        ts: '16:52:18',
        title: 'README.md を更新',
        filePath: 'README.md',
        body: '機能 1(トランスクリプト表示・分析)の説明を加筆。',
        durationMs: 2100,
        tokenUsage: 1620,
        files: [{ path: 'README.md', role: 'edit' }],
      },
    ],
  },
  {
    id: 'ses_2026-06-02_ui-palette-tweak',
    title: 'UI palette tweak',
    runner: 'claude-code',
    model: 'claude-opus-4-8',
    status: 'failed',
    startedAt: '2026-06-02 11:15:00',
    endedAt: '2026-06-02 11:33:42',
    durationMs: 1122000,
    seq: 5,
    turnCount: 9,
    toolCount: 18,
    editCount: 4,
    bashCount: 5,
    subagentCount: 0,
    tokenUsage: 168000,
    costUsd: 1.5,
    summary: 'パレット調整中にビルドが赤のまま終了',
    events: [
      {
        type: 'file_edit',
        actor: 'assistant',
        ts: '11:20:30',
        title: 'globals.css のトークンを調整',
        filePath: 'app/globals.css',
        body: 'accent と add/del のコントラストを上げる試み。',
        durationMs: 1500,
        tokenUsage: 980,
        files: [{ path: 'app/globals.css', role: 'edit' }],
      },
      {
        type: 'bash',
        actor: 'assistant',
        ts: '11:33:20',
        title: 'pnpm build (失敗)',
        command: 'pnpm build',
        body: "Syntax error: Unclosed block in app/globals.css (line 142)",
        exitCode: 1,
        durationMs: 14200,
      },
    ],
  },
  {
    id: 'ses_2026-06-01_phase1-viewer-spike',
    title: 'Phase 1 — viewer spike',
    runner: 'claude-code',
    model: 'claude-opus-4-8',
    status: 'done',
    startedAt: '2026-06-01 13:02:00',
    endedAt: '2026-06-01 14:18:50',
    durationMs: 4610000,
    seq: 6,
    turnCount: 28,
    toolCount: 64,
    editCount: 12,
    bashCount: 9,
    subagentCount: 2,
    tokenUsage: 640000,
    costUsd: 6.1,
    summary: 'ビューアの素案。後の本実装(seq=1)の下敷きになった',
    events: [
      {
        type: 'user_message',
        actor: 'user',
        ts: '13:02:00',
        title: 'まず素案でいいので形にして',
        body: 'タイムラインと差分の見え方を素案で確認したい。',
        tokenUsage: 160,
      },
      {
        type: 'assistant_message',
        actor: 'assistant',
        ts: '13:04:20',
        title: '素案の構成を提案',
        body: '3カラム + 下部 minimap で進める。データはモックで。',
        durationMs: 4100,
        tokenUsage: 1340,
      },
      {
        type: 'commit',
        actor: 'assistant',
        ts: '14:15:10',
        title: 'chore(spike): viewer skeleton',
        body: '[main 9ab12cd] chore(spike): viewer skeleton\n 5 files changed, 318 insertions(+)',
        durationMs: 1200,
        meta: '{"hash":"9ab12cd"}',
      },
    ],
  },
];

for (const s of otherSessions) {
  insSession.run(
    s.id,
    'LLMWiki / lathe',
    s.title,
    s.runner,
    s.model,
    s.status,
    s.startedAt,
    s.endedAt,
    s.durationMs,
    s.turnCount,
    s.toolCount,
    s.editCount,
    s.bashCount,
    s.subagentCount,
    s.tokenUsage,
    s.costUsd,
    s.summary,
    s.seq
  );
  counters.sessions++;

  if (s.events) {
    s.events.forEach((e, i) => {
      const seq = i + 1;
      const id = `evt_${s.seq}_${String(seq).padStart(3, '0')}`;
      insEvent.run(
        id,
        s.id,
        seq,
        e.ts,
        e.type,
        e.actor,
        e.title,
        e.body ?? null,
        e.filePath ?? null,
        e.command ?? null,
        e.exitCode ?? null,
        e.durationMs ?? null,
        e.tokenUsage ?? null,
        e.subagent ?? null,
        e.meta ?? null
      );
      counters.events++;
      if (e.files) {
        for (const f of e.files) {
          insEventFile.run(id, f.path, f.role);
          counters.event_files++;
        }
      }
    });
  }
}

// ---- summary ---------------------------------------------------------------

console.log(
  `[seed] sessions=${counters.sessions} events=${counters.events} ` +
    `changed_files=${counters.changed_files} hunks=${counters.hunks} ` +
    `attributions=${counters.attributions} event_files=${counters.event_files} ` +
    `annotations=${counters.annotations}`
);

db.close();
