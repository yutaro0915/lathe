// app/page.tsx — Screen A: session viewer (white / IDE theme, Phase 1).
//
// RSC. The .app shell + .appbar are rendered by app/layout.tsx; this page
// renders the bands that sit *below* the appbar and above the column floor:
//   Band 2 .metrics  ·  Band 3 .tabs  ·  Band 4 .layout3 (sidebar | timeline | aside)
//   plus the bottom .minimap under the timeline column.
// Everything is driven by data/lathe.db via lib/db (no hardcoded content where
// the DB has it). node:sqlite logs an ExperimentalWarning at runtime — harmless.

export const dynamic = 'force-dynamic';

import {
  getPrimarySession,
  listSessions,
  getEvents,
  countEventsByType,
  getEvent,
  getEventFiles,
  getAnnotations,
} from '@/lib/db';
import type {
  Session,
  TranscriptEvent,
  EventType,
  AnnotationKind,
  Runner,
} from '@/lib/types';

// ---- small formatting helpers ---------------------------------------------

function humanizeDuration(ms: number | null): string {
  if (ms == null) return '—';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function durLabel(ms: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

// "12.4K" style compaction for big token counts in chips.
function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(c: number | null): string {
  if (c == null) return '—';
  return `$${c.toFixed(2)}`;
}

// "2026-06-04 09:12:00" -> { date:"Jun 4", time:"09:12" }
function parseStamp(s: string): { date: string; time: string } {
  const [datePart, timePart = ''] = s.split(' ');
  const [, mo, da] = datePart.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const moName = months[Number(mo) - 1] ?? mo;
  const date = `${moName} ${Number(da)}`;
  const time = timePart.slice(0, 5);
  return { date, time };
}

const RUNNER_LABEL: Record<Runner, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

// Single-character glyph per event type for the colored .event-icon square.
const TYPE_GLYPH: Record<EventType, string> = {
  user_message: '◍',
  assistant_message: '✦',
  file_read: '◎',
  file_edit: '✎',
  file_write: '✚',
  bash: '›_',
  subagent: '⌥',
  skill: '★',
  commit: '⎇',
  test: '✓',
  error: '!',
  todo: '☐',
};

// Short human label per type (for the .event-type-badge pill).
const TYPE_LABEL: Record<EventType, string> = {
  user_message: 'User',
  assistant_message: 'Assistant',
  file_read: 'Read',
  file_edit: 'Edit',
  file_write: 'Write',
  bash: 'Bash',
  subagent: 'Sub-agent',
  skill: 'Skill',
  commit: 'Commit',
  test: 'Test',
  error: 'Error',
  todo: 'Todo',
};

// Map an event type onto a minimap "kind" class (legend buckets).
function minimapKind(t: EventType): string {
  switch (t) {
    case 'user_message':
    case 'assistant_message':
      return 'message';
    case 'bash':
    case 'test':
      return 'tool';
    case 'file_read':
    case 'file_edit':
    case 'file_write':
      return 'file';
    case 'skill':
      return 'skill';
    case 'subagent':
      return 'subagent';
    case 'commit':
      return 'git';
    case 'error':
      return 'error';
    default:
      return 'tool';
  }
}

// ---- tiny JSON renderer for the Run JSON panel (.json-* spans) -------------

function JsonView({ value }: { value: Record<string, unknown> }): React.ReactNode {
  const entries = Object.entries(value);
  const out: React.ReactNode[] = [];
  out.push(
    <span key="open" className="json-punct">
      {'{\n'}
    </span>
  );
  entries.forEach(([k, v], i) => {
    const comma = i < entries.length - 1 ? ',' : '';
    let valNode: React.ReactNode;
    if (v === null) valNode = <span className="json-num">null</span>;
    else if (typeof v === 'number' || typeof v === 'boolean')
      valNode = <span className="json-num">{String(v)}</span>;
    else valNode = <span className="json-str">{JSON.stringify(String(v))}</span>;
    out.push(
      <span key={`r${i}`}>
        {'  '}
        <span className="json-key">{JSON.stringify(k)}</span>
        <span className="json-punct">: </span>
        {valNode}
        <span className="json-punct">{comma}</span>
        {'\n'}
      </span>
    );
  });
  out.push(
    <span key="close" className="json-punct">
      {'}'}
    </span>
  );
  return <>{out}</>;
}

// ============================================================================

export default function SessionViewerPage(): React.ReactNode {
  // ---- data ---------------------------------------------------------------
  const primary: Session = getPrimarySession();
  const sessions: Session[] = listSessions();
  const events: TranscriptEvent[] = getEvents(primary.id);
  const typeCounts: Record<string, number> = countEventsByType(primary.id);
  const annotations = getAnnotations(primary.id);

  // Representative selected event: the failing build (bash, exit != 0) is the
  // most informative — command + non-zero exit + error body, and it anchors the
  // annotation/minimap story. Fall back gracefully when absent.
  const selectedSeed =
    events.find((e) => e.type === 'bash' && e.exitCode != null && e.exitCode !== 0) ??
    events.find((e) => e.type === 'bash') ??
    events.find((e) => e.type === 'file_edit') ??
    events[0];
  const selected: TranscriptEvent | undefined = selectedSeed
    ? getEvent(selectedSeed.id)
    : undefined;
  const selectedFiles = selected ? getEventFiles(selected.id) : [];

  // Commit range for the metrics band (derived, mono display only).
  const hashSrc = primary.id.replace(/[^a-z0-9]/g, '');
  const startCommit = (hashSrc.slice(0, 7) + 'a1b2c3d').slice(0, 7);
  const endCommit = (hashSrc.slice(-7) + 'd4e5f6a').slice(0, 7);

  // Token in/out split (illustrative ~65/35) for the metric .sub line.
  const tokIn = Math.round(primary.tokenUsage * 0.65);
  const tokOut = primary.tokenUsage - tokIn;

  // Sidebar filter toggles — driven by countEventsByType.
  const filterTypes: EventType[] = [
    'user_message',
    'assistant_message',
    'file_read',
    'file_edit',
    'file_write',
    'bash',
    'subagent',
    'skill',
    'commit',
    'test',
    'error',
    'todo',
  ];

  // Minimap axis ticks: first/last event timestamps.
  const firstTs = events[0]?.ts.slice(0, 5) ?? '';
  const lastTs = events[events.length - 1]?.ts.slice(0, 5) ?? '';

  // Selected event's detail metadata. Event ts is time-only (HH:MM:SS); the
  // calendar date lives on the session, so pair the session date with the
  // event's own clock time for the detail "Time" row.
  const selType = (selected?.type ?? 'bash') as EventType;
  const sessionDate = parseStamp(primary.startedAt).date;
  const selTime = selected ? selected.ts.slice(0, 8) : '';
  const selStatusClass =
    selected?.exitCode == null ? 'neutral' : selected.exitCode === 0 ? 'success' : 'failed';
  const selStatusText =
    selected?.exitCode == null ? 'Done' : selected.exitCode === 0 ? 'Success' : 'Failed';

  // Small JSON object describing the selected event for the Run JSON panel.
  const runJson: Record<string, unknown> = selected
    ? {
        id: selected.id,
        seq: selected.seq,
        type: selected.type,
        actor: selected.actor,
        ts: selected.ts,
        command: selected.command,
        exit_code: selected.exitCode,
        duration_ms: selected.durationMs,
      }
    : {};

  return (
    <>
      {/* ===================== Band 2 — metrics ===================== */}
      <div className="metrics">
        <div className="metric metric-branch">
          <span className="label">Branch</span>
          <span className="value mono">
            <span aria-hidden>⎇</span> main
          </span>
        </div>
        <span className="metric-sep" />

        <div className="metric metric-commit">
          <span className="label">Commit</span>
          <span className="value mono">
            {startCommit} → {endCommit}
            <span className="icon-btn" title="Copy commit range" aria-label="Copy">
              ⧉
            </span>
          </span>
        </div>
        <span className="metric-sep" />

        <div className="metric">
          <span className="label">Model</span>
          <span className="value">
            <span className={`runner-dot ${primary.runner}`} />
            {primary.model ?? '—'}
          </span>
        </div>
        <span className="metric-sep" />

        <div className="metric">
          <span className="label">Duration</span>
          <span className="value">{humanizeDuration(primary.durationMs)}</span>
        </div>
        <span className="metric-sep" />

        <div className="metric">
          <span className="label">Turns</span>
          <span className="value">{primary.turnCount}</span>
        </div>
        <span className="metric-sep" />

        <div className="metric">
          <span className="label">Tools</span>
          <span className="value">{primary.toolCount}</span>
        </div>
        <span className="metric-sep" />

        <div className="metric">
          <span className="label">Edits</span>
          <span className="value">{primary.editCount}</span>
        </div>
        <span className="metric-sep" />

        <div className="metric">
          <span className="label">Tokens</span>
          <span className="value">
            {fmtInt(primary.tokenUsage)}
            <span className="sub">
              ({fmtTok(tokIn)} in / {fmtTok(tokOut)} out)
            </span>
          </span>
        </div>
        <span className="metric-sep" />

        <div className="metric">
          <span className="label">Cost</span>
          <span className="value">{fmtCost(primary.costUsd)}</span>
        </div>
      </div>

      {/* ===================== Band 3 — tabs ===================== */}
      <div className="tabs">
        <span className="tab active">Transcript</span>
        <span className="tab">Tools</span>
        <span className="tab">Git</span>
        <span className="tab">Skills</span>
        <span className="tab">Subagents</span>
        <span className="tab">Raw JSON</span>
        <span className="tabs-spacer" />
        <span className="tabs-tool">
          <span className="sort-select">Timeline ▾</span>
        </span>
      </div>

      {/* ===================== Band 4 — 3-col layout ===================== */}
      <div
        className="layout3"
        style={{ gridTemplateColumns: 'var(--sidebar-w) minmax(0,1fr) var(--aside-w)' }}
      >
        {/* ---------- COLUMN 1: sidebar ---------- */}
        <aside className="sidebar">
          <div className="project-select">
            <span aria-hidden>⊞</span>
            <span>{primary.project}</span>
            <span className="caret">⌄</span>
          </div>

          <div className="search">
            <span aria-hidden>⌕</span>
            <input placeholder="Search sessions…" readOnly />
            <span className="kbd">⌘K</span>
          </div>

          <div className="filters">
            <div className="filters-head">
              <span className="title">Filters</span>
              <span className="clear">Clear</span>
            </div>

            <div className="filter-row">
              <span className="flabel">Event types</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                {filterTypes.map((t) => (
                  <span key={t} className={`event-type-badge ${t}`} title={TYPE_LABEL[t]}>
                    {TYPE_LABEL[t]} {typeCounts[t] ?? 0}
                  </span>
                ))}
              </div>
            </div>

            <div className="filter-row">
              <span className="flabel">Model</span>
              <div className="control">
                All models
                <span className="select-caret">⌄</span>
              </div>
            </div>

            <div className="filter-row">
              <span className="flabel">Outcome</span>
              <div className="control">
                All outcomes
                <span className="select-caret">⌄</span>
              </div>
            </div>

            <div className="filter-row">
              <span className="flabel">Has errors</span>
              <div className="control">
                Any
                <span className="select-caret">⌄</span>
              </div>
            </div>
          </div>

          <div className="session-head">
            <span>
              <span className="title">Sessions</span>
              <span className="count">{sessions.length}</span>
            </span>
            <span className="sort-select">Recent first ▾</span>
          </div>

          <div className="sidebar-scroll">
            <div className="session-list">
              {sessions.map((s) => {
                const st = parseStamp(s.startedAt);
                const active = s.id === primary.id;
                return (
                  <div key={s.id} className={`session-item${active ? ' active' : ''}`}>
                    <div className="si-top">
                      <span className="si-title">{s.title}</span>
                      <span className={`badge ${s.status}`}>{s.status}</span>
                    </div>
                    <div className="si-meta">
                      <span>
                        {st.date}, {st.time}
                      </span>
                      <span className="dot">·</span>
                      <span>{humanizeDuration(s.durationMs)}</span>
                      <span className="dot">·</span>
                      <span>{s.model ?? '—'}</span>
                    </div>
                    <div className="si-stats">
                      <span className="runner-badge">
                        <span className={`runner-dot ${s.runner}`} />
                        {RUNNER_LABEL[s.runner]}
                      </span>
                      <span className="chip token">{fmtTok(s.tokenUsage)} tok</span>
                      <span className="chip cost">{fmtCost(s.costUsd)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="user-footer">
            <span className="avatar">YO</span>
            <span className="uname">Yutaro Ono</span>
            <span className="badge pro">Pro</span>
            <span className="gear" aria-label="Settings">
              ⚙
            </span>
          </div>
        </aside>

        {/* ---------- COLUMN 2: main / timeline ---------- */}
        <main className="main">
          <div className="timeline">
            {events.map((e) => {
              const isNested = !!e.subagent;
              const isSel = selected != null && e.id === selected.id;
              const glyph = TYPE_GLYPH[e.type] ?? '•';

              // sub-line: path for file_* ; command for bash/test ; body otherwise.
              let subNode: React.ReactNode = null;
              if (e.filePath) {
                subNode = <div className="event-sub path">{e.filePath}</div>;
              } else if (e.command) {
                subNode = <div className="event-sub mono">{e.command}</div>;
              } else if (e.body) {
                const preview = e.body.split('\n')[0];
                subNode = <div className="event-sub body">{preview}</div>;
              }

              const showBadge =
                e.type === 'subagent' ||
                e.type === 'skill' ||
                e.type === 'error' ||
                e.type === 'commit';

              return (
                <div
                  key={e.id}
                  className={`event-row${isNested ? ' nested' : ''}${isSel ? ' selected' : ''}`}
                >
                  <span className="event-seq">{e.seq}</span>
                  <span className="event-gutter">{e.ts}</span>
                  <span className={`event-icon ${e.type}`} aria-hidden>
                    {glyph}
                  </span>
                  <div className="event-main">
                    <div className="event-headline">
                      <span className="event-title">{e.title}</span>
                      {showBadge && (
                        <span className={`event-type-badge ${e.type}`}>{TYPE_LABEL[e.type]}</span>
                      )}
                      {isNested && (
                        <span className="event-type-badge subagent">{e.subagent}</span>
                      )}
                    </div>
                    {subNode}
                  </div>
                  <span className="event-meta">
                    {e.type === 'commit' && <span className="chip hash">{endCommit}</span>}
                    {e.tokenUsage != null && (
                      <span className="tok">+{fmtInt(e.tokenUsage)} -0</span>
                    )}
                    {e.durationMs != null && <span className="dur">{durLabel(e.durationMs)}</span>}
                    {e.exitCode != null &&
                      (e.exitCode === 0 ? (
                        <span className="ok">✓</span>
                      ) : (
                        <span className="err">✗</span>
                      ))}
                  </span>
                </div>
              );
            })}
          </div>

          {/* ---------- bottom strip: minimap (under timeline column) ---------- */}
          <div className="minimap">
            <div className="minimap-head">
              <span className="mtitle">Timeline density</span>
              <div className="minimap-legend">
                {(
                  [
                    ['message', 'Message'],
                    ['tool', 'Tool'],
                    ['file', 'File'],
                    ['skill', 'Skill'],
                    ['subagent', 'Sub-agent'],
                    ['git', 'Git'],
                    ['error', 'Error'],
                  ] as const
                ).map(([cls, label]) => (
                  <span key={cls} className="legend-item">
                    <span className={`legend-swatch ${cls}`} />
                    {label}
                  </span>
                ))}
              </div>
              <span className="spacer" />
              <div className="minimap-zoom">
                <button type="button" aria-label="Zoom out">
                  −
                </button>
                <button type="button" aria-label="Zoom in">
                  +
                </button>
                <button type="button" aria-label="Fit">
                  ⤢
                </button>
              </div>
            </div>

            <div className="minimap-track">
              {events.map((e) => {
                // taller ticks for "louder" event kinds; deterministic by type/dur.
                const h =
                  e.type === 'error'
                    ? 34
                    : e.durationMs
                      ? Math.min(34, 10 + e.durationMs / 1200)
                      : 16;
                return (
                  <span
                    key={e.id}
                    className={`minimap-tick ${minimapKind(e.type)}`}
                    style={{ height: `${h}px` }}
                    title={`${e.ts} · ${e.title}`}
                  />
                );
              })}
              <span className="minimap-window" style={{ left: '62%', right: 0 }} />
            </div>

            <div className="minimap-axis">
              <span className="tick">{firstTs}</span>
              <span className="tick">{lastTs}</span>
            </div>
          </div>
        </main>

        {/* ---------- COLUMN 3: aside / detail ---------- */}
        <aside className="aside">
          <div className="detail">
            <div className="detail-head">
              <span className={`event-icon ${selType}`} aria-hidden>
                {TYPE_GLYPH[selType] ?? '•'}
              </span>
              <span className="dtitle">
                {selType === 'bash' ? 'Bash (shell)' : TYPE_LABEL[selType]}
              </span>
              <span className="spacer" />
              <span className={`badge ${selStatusClass}`}>{selStatusText}</span>
            </div>

            <div className="detail-actions">
              <button type="button" className="btn">
                📌 Pin
              </button>
              <button type="button" className="btn">
                🗒 Add Note
              </button>
            </div>

            <dl className="kv">
              <dt>Type</dt>
              <dd>{TYPE_LABEL[selType]}</dd>
              <dt>Actor</dt>
              <dd>{selected?.actor ?? '—'}</dd>
              <dt>Time</dt>
              <dd className="mono">
                {sessionDate} · {selTime}
              </dd>
              <dt>Duration</dt>
              <dd>{selected ? durLabel(selected.durationMs) || '—' : '—'}</dd>
              {selected?.filePath && (
                <>
                  <dt>Path</dt>
                  <dd className="mono">{selected.filePath}</dd>
                </>
              )}
              <dt>Exit code</dt>
              <dd
                className={
                  selected?.exitCode === 0 ? 'ok' : selected?.exitCode != null ? 'err' : ''
                }
              >
                {selected?.exitCode != null ? selected.exitCode : '—'}
              </dd>
              <dt>Tokens</dt>
              <dd>{selected?.tokenUsage != null ? fmtInt(selected.tokenUsage) : '—'}</dd>
            </dl>

            {selected?.command && (
              <>
                <div className="kv" style={{ borderTop: 0, paddingBottom: 0 }}>
                  <dt>Command</dt>
                  <dd />
                </div>
                <pre className="code-block">
                  <span className="copy" aria-label="Copy">
                    ⧉
                  </span>
                  {selected.command}
                </pre>
              </>
            )}

            {selected?.body && (
              <>
                <div className="kv" style={{ borderTop: 0, paddingBottom: 0 }}>
                  <dt>Output</dt>
                  <dd />
                </div>
                <pre className="code-block">{selected.body}</pre>
              </>
            )}

            {/* Linked files */}
            <div className="linked-files">
              <div className="panel-title">
                Linked Files <span className="count">({selectedFiles.length})</span>
              </div>
              {selectedFiles.length === 0 ? (
                <div className="empty">—</div>
              ) : (
                selectedFiles.map((f) => (
                  <div key={f.id} className="linked-file">
                    <span>{f.path}</span>
                    <span className={`role ${f.role}`}>{f.role}</span>
                  </div>
                ))
              )}
            </div>

            {/* Run JSON */}
            <div className="linked-files" style={{ borderBottom: 0, paddingBottom: 0 }}>
              <div className="panel-title">Run JSON</div>
            </div>
            <pre className="run-json">
              <JsonView value={runJson} />
            </pre>
          </div>

          {/* Annotations strip (right side, same vertical band as the minimap) */}
          <div className="annotations">
            <div className="ahead">
              Annotations <span className="count">({annotations.length})</span>
            </div>
            {annotations.length === 0 ? (
              <div className="empty">—</div>
            ) : (
              annotations.map((a) => (
                <div key={a.id} className="annotation">
                  <span className={`akind ${a.kind as AnnotationKind}`} />
                  <span>{a.note ?? a.kind}</span>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
