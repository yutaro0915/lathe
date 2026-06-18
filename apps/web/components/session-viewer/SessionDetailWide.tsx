"use client";

import * as React from "react";
import { EVENT_LABEL, TYPE_GLYPH } from "@/lib/event-display";
import { fmtInt, humanizeDuration, parseStamp } from "@lathe/shared";
import type { EventFile, EventType, Session, TranscriptEvent } from "@/lib/types";
import { Markdown } from "./Markdown";

// SessionDetailWide.tsx — the WIDE master-detail RIGHT pane for the Transcript
// (annotation #6 / 2026-06-18: important info — Input/Output, md preview, code —
// must not be cramped in a narrow Inspector). It owns the `aside` testid + the
// detail markup (detail / detail-head / dtitle / stat-strip / code-block /
// linked-files) the e2e contract targets, but lays them out with real width: the
// I/O is the dominant main column with a Pretty (markdown) / Raw toggle + a
// per-block copy, and a metadata sub-column (Tool / Time / Latency / Exit /
// Tokens / linked files + a forward SCORES placeholder for the eval phase).

type Props = {
  selected?: TranscriptEvent;
  selectedFiles: EventFile[];
  primary: Session;
  pins: Set<string>;
  notes: Record<string, string>;
  noteDraft: string | null;
  setNoteDraft: (value: string | null) => void;
  copied: string | null;
  copy: (key: string, text: string) => void;
  eventsWithDiff: Set<string>;
  togglePin: () => void;
  openNoteEditor: () => void;
  saveNote: () => void;
  openSelectedDiff: () => void;
};

type IoView = "pretty" | "raw";

// Default to Raw so the raw code-block (data-block-kind="output", white-space:
// pre-wrap) is the landing state for every event type. The user flips to Pretty
// to read prose as markdown. Keeping Raw as the default preserves the e2e output
// contract (the code-block is present + wrapping the moment a step is selected).

export function SessionDetailWide({
  selected,
  selectedFiles,
  primary,
  pins,
  notes,
  noteDraft,
  setNoteDraft,
  copied,
  copy,
  eventsWithDiff,
  togglePin,
  openNoteEditor,
  saveNote,
  openSelectedDiff,
}: Props) {
  const selType = (selected?.type ?? "bash") as EventType;
  const sessionDate = parseStamp(primary.startedAt).date;
  const selTime = selected ? selected.ts.slice(0, 8) : "";
  const selMeta: { tool?: string; toolUses?: number } = (() => {
    try {
      return selected?.meta ? JSON.parse(selected.meta) : {};
    } catch {
      return {};
    }
  })();
  const selStatusClass = selected?.exitCode == null ? "neutral" : selected.exitCode === 0 ? "success" : "failed";
  const selStatusText = selected?.exitCode == null ? "Done" : selected.exitCode === 0 ? "Success" : "Failed";
  const selPinned = selected ? pins.has(selected.id) : false;
  const selNote = selected ? notes[selected.id] : undefined;

  const [outView, setOutView] = React.useState<IoView>("raw");
  React.useEffect(() => setOutView("raw"), [selected?.id]);

  return (
    <div className="lds-sv-detail-wide" data-testid="aside">
      <div className="detail detail-wide" data-testid="detail">
        <div className="detail-head" data-testid="detail-head">
          <span className={`event-icon ${selType}`} data-testid="event-icon" aria-hidden>{TYPE_GLYPH[selType] ?? "•"}</span>
          <span className="dtitle" data-testid="dtitle">{selType === "bash" ? "Bash (shell)" : EVENT_LABEL[selType]}</span>
          <span className="spacer" data-testid="spacer" />
          {selected?.exitCode != null && <span className={`badge ${selStatusClass}`} data-testid="badge">{selStatusText}</span>}
        </div>

        <div className="detail-actions" data-testid="detail-actions">
          <button type="button" className={`btn${selPinned ? " btn-primary" : ""}`} data-testid="btn" onClick={togglePin} disabled={!selected}>
            {selPinned ? "Pinned" : "Pin"}
          </button>
          <button type="button" className="btn" data-testid="btn" onClick={openNoteEditor} disabled={!selected}>
            {selNote ? "Edit Note" : "Add Note"}
          </button>
          {selected && eventsWithDiff.has(selected.id) && (
            <button type="button" className="btn" data-testid="btn" onClick={openSelectedDiff} title="See the Git diff this edit produced (jump to the Git tab)">
              Diff →
            </button>
          )}
        </div>

        {noteDraft != null && (
          <div className="detail-note-edit">
            <textarea
              className="detail-note-area"
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Note for this event"
              rows={3}
              autoFocus
            />
            <div className="detail-note-actions">
              <button type="button" className="btn btn-sm btn-primary" data-testid="btn" onClick={saveNote}>Save</button>
              <button type="button" className="btn btn-sm" data-testid="btn" onClick={() => setNoteDraft(null)}>Cancel</button>
            </div>
          </div>
        )}

        {selNote && noteDraft == null && <div className="detail-note-view">{selNote}</div>}

        {/* The wide layout: I/O is the dominant main column; metadata + scores sit
            in a right sub-column (stacks under the I/O on narrow widths). */}
        <div className="detail-wide-grid" data-testid="detail-wide-grid">
          <div className="detail-io-main" data-testid="detail-io-main">
            {selected?.command && (
              <IoBlock
                label="Command"
                raw={selected.command}
                copyKey="cmd"
                copied={copied}
                copy={copy}
                view="raw"
                allowToggle={false}
                blockKind="cmd"
              />
            )}
            <IoBlock
              label={outputLabel(selType)}
              raw={selected?.body ?? ""}
              hasBody={!!selected?.body}
              copyKey="out"
              copied={copied}
              copy={copy}
              view={outView}
              setView={setOutView}
              allowToggle
              blockKind="output"
            />
          </div>

          <aside className="detail-meta-col" data-testid="detail-meta-col">
            <div className="stat-strip" data-testid="stat-strip">
              {selMeta.tool && <Stat label="Tool" value={selMeta.tool} />}
              <Stat label="Time" value={selTime || "—"} />
              {selected?.durationMs != null && <Stat label="Latency" value={fmtDur2(selected.durationMs)} />}
              {selected?.exitCode != null && (
                <div className="stat" data-testid="stat">
                  <span className="stat-k" data-testid="stat-k">Exit</span>
                  <span className={`stat-v ${selected.exitCode === 0 ? "ok" : "err"}`} data-testid="stat-v">{selected.exitCode === 0 ? "0 ✓" : `${selected.exitCode} ✗`}</span>
                </div>
              )}
              {selected?.tokenUsage != null && <Stat label="Tokens" value={fmtInt(selected.tokenUsage)} />}
              {selMeta.toolUses != null && <Stat label="Tool calls" value={String(selMeta.toolUses)} />}
            </div>

            <div className="detail-sub" data-testid="detail-sub">
              {EVENT_LABEL[selType]} · {selected?.actor ?? "—"} · {sessionDate} {selTime}
            </div>
            {selected?.filePath && <div className="detail-path mono" data-testid="detail-path">{selected.filePath}</div>}

            <div className="linked-files" data-testid="linked-files">
              <div className="panel-title" data-testid="panel-title">Linked Files <span className="count" data-testid="count">({selectedFiles.length})</span></div>
              {selectedFiles.length === 0 ? (
                <div className="empty" data-testid="empty">—</div>
              ) : (
                selectedFiles.map((f) => (
                  <div key={f.id} className="linked-file" data-testid="linked-file">
                    <span>{f.path}</span>
                    <span className={`role ${f.role}`} data-testid="role">{f.role}</span>
                  </div>
                ))
              )}
            </div>

            {/* SCORES — forward placeholder for the eval phase. The slot is
                reserved (label + a muted note); nothing is wired. */}
            <div className="detail-scores" data-testid="detail-scores">
              <div className="panel-title" data-testid="panel-title">Scores <span className="scores-tag" data-testid="scores-tag">eval</span></div>
              <div className="scores-coming muted" data-testid="scores-coming">Eval scores land in a later phase.</div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function IoBlock({
  label,
  raw,
  hasBody = true,
  copyKey,
  copied,
  copy,
  view,
  setView,
  allowToggle,
  blockKind,
}: {
  label: string;
  raw: string;
  hasBody?: boolean;
  copyKey: string;
  copied: string | null;
  copy: (key: string, text: string) => void;
  view: IoView;
  setView?: (v: IoView) => void;
  allowToggle: boolean;
  blockKind: "cmd" | "output";
}) {
  return (
    <div className={`io-block${blockKind === "output" ? " io-output" : ""}`} data-testid="io-block">
      <div className="io-head" data-testid="io-head">
        <span>{label}</span>
        <span className="io-head-tools">
          {allowToggle && setView && (
            <span className="segmented io-toggle" data-testid="io-toggle" title="Pretty renders markdown; Raw shows the raw text">
              <button type="button" className={view === "pretty" ? "active" : ""} data-testid="io-toggle-pretty" data-active={view === "pretty" ? "true" : undefined} onClick={() => setView("pretty")}>
                Pretty
              </button>
              <button type="button" className={view === "raw" ? "active" : ""} data-testid="io-toggle-raw" data-active={view === "raw" ? "true" : undefined} onClick={() => setView("raw")}>
                Raw
              </button>
            </span>
          )}
          {hasBody && raw && (
            <button type="button" className="io-copy" data-testid="io-copy" onClick={() => copy(copyKey, raw)}>
              {copied === copyKey ? "✓ copied" : "⧉ copy"}
            </button>
          )}
        </span>
      </div>
      {view === "pretty" && allowToggle ? (
        <div className="io-pretty" data-testid="io-pretty" data-block-kind={blockKind}>
          {hasBody && raw ? <Markdown text={raw} /> : <span className="muted" data-testid="muted">(no output captured)</span>}
        </div>
      ) : (
        <pre className={`code-block ${blockKind === "output" ? "output" : "cmd"}`} data-testid="code-block" data-block-kind={blockKind}>
          {hasBody && raw ? raw : <span className="muted" data-testid="muted">(no output captured)</span>}
        </pre>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat" data-testid="stat">
      <span className="stat-k" data-testid="stat-k">{label}</span>
      <span className="stat-v" data-testid="stat-v">{value}</span>
    </div>
  );
}

function fmtDur2(ms: number | null): string {
  return ms == null ? "—" : ms < 1000 ? `${ms}ms` : humanizeDuration(ms);
}

function outputLabel(selType: EventType): string {
  if (selType === "bash" || selType === "test") return "Output · stdout / stderr";
  if (selType === "file_read") return "File contents";
  if (selType === "subagent") return "Result / summary";
  if (selType === "thinking") return "Thinking · reasoning";
  if (selType === "assistant_message" || selType === "user_message") return "Message";
  return "Detail";
}
