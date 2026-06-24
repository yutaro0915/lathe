import { EVENT_LABEL, TYPE_GLYPH } from "@/lib/event-display";
import { fmtInt, humanizeDuration, parseStamp } from "@lathe/shared";
import type { EventFile, EventType, Session, TranscriptEvent } from "@/lib/types";
import { Button, Pressable } from "@/design-system/components";
import { JsonView } from "./JsonView";

// Pressable is DS Pressable for bespoke controls; feature classes keep their visuals.

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

export function SessionAside({
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
    <div className="lds-sv-aside" data-testid="aside">
      <div className="detail" data-testid="detail">
          <div className="detail-head" data-testid="detail-head">
            <span className={`event-icon ${selType}`} data-testid="event-icon" aria-hidden>{TYPE_GLYPH[selType] ?? "•"}</span>
            <span className="dtitle" data-testid="dtitle">{selType === "bash" ? "Bash (shell)" : EVENT_LABEL[selType]}</span>
            <span className="spacer" data-testid="spacer" />
            {selected?.exitCode != null && <span className={`badge ${selStatusClass}`} data-testid="badge">{selStatusText}</span>}
          </div>

          <div className="detail-actions" data-testid="detail-actions">
            <Button type="button" variant={selPinned ? "primary" : "default"} data-testid="btn" onClick={togglePin} disabled={!selected}>
              📌 {selPinned ? "Pinned" : "Pin"}
            </Button>
            <Button type="button" data-testid="btn" onClick={openNoteEditor} disabled={!selected}>
              🗒 {selNote ? "Edit Note" : "Add Note"}
            </Button>
            {selected && eventsWithDiff.has(selected.id) && (
              <Button type="button" data-testid="btn" onClick={openSelectedDiff} title="See the Git diff this edit produced (jump to the Git tab)">
                ⎇ Diff →
              </Button>
            )}
          </div>

          {noteDraft != null && (
            <div className="session-note-editor-wrap">
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Note for this event…"
                rows={3}
                autoFocus
                className="session-note-editor"
              />
              <div className="session-note-actions">
                <Button type="button" size="sm" variant="primary" data-testid="btn" onClick={saveNote}>Save</Button>
                <Button type="button" size="sm" data-testid="btn" onClick={() => setNoteDraft(null)}>Cancel</Button>
              </div>
            </div>
          )}

          {selNote && noteDraft == null && (
            <div className="kv" data-testid="kv" style={{ borderTop: 0, paddingTop: 0, gridTemplateColumns: "1fr" }}>
              <dd className="session-note-body">🗒 {selNote}</dd>
            </div>
          )}

          <div className="stat-strip" data-testid="stat-strip">
            {selected?.durationMs != null && <Stat label="Duration" value={fmtDur2(selected.durationMs)} />}
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
            {selMeta.tool && selMeta.tool !== EVENT_LABEL[selType] ? ` · ${selMeta.tool}` : ""}
          </div>
          {selected?.filePath && <div className="detail-path mono" data-testid="detail-path">{selected.filePath}</div>}
          {selected?.command && (
            <div className="io-block" data-testid="io-block">
              <div className="io-head" data-testid="io-head">
                <span>Command</span>
                <Pressable type="button" className="io-copy" data-testid="io-copy" onClick={() => copy("cmd", selected.command ?? "")}>
                  {copied === "cmd" ? "✓ copied" : "⧉ copy"}
                </Pressable>
              </div>
              <pre className="lds-codebox code-block cmd" data-testid="code-block">{selected.command}</pre>
            </div>
          )}
          <div className="io-block io-output" data-testid="io-block">
            <div className="io-head" data-testid="io-head">
              <span>{outputLabel(selType)}</span>
              {selected?.body && (
                <Pressable type="button" className="io-copy" data-testid="io-copy" onClick={() => copy("out", selected.body ?? "")}>
                  {copied === "out" ? "✓ copied" : "⧉ copy"}
                </Pressable>
              )}
            </div>
            <pre className="lds-codebox code-block output" data-testid="code-block" data-block-kind="output">
              {selected?.body ? selected.body : <span className="muted" data-testid="muted">(no output captured)</span>}
            </pre>
          </div>
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
          <div className="linked-files" data-testid="linked-files" style={{ borderBottom: 0, paddingBottom: 0 }}>
            <div className="panel-title session-run-json-title" data-testid="panel-title">
              <span>Run JSON</span>
              <Button type="button" size="sm" data-testid="btn" onClick={() => copy("runjson", JSON.stringify(runJson, null, 2))} disabled={!selected}>
                {copied === "runjson" ? "Copied ✓" : "⧉ Copy"}
              </Button>
            </div>
          </div>
          <pre className="lds-codebox run-json" data-testid="run-json">
            <JsonView value={runJson} />
          </pre>
      </div>
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
