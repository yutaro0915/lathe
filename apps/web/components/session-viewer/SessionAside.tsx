import { EVENT_LABEL, TYPE_GLYPH } from "@/lib/event-display";
import { fmtInt, humanizeDuration, parseStamp } from "@lathe/shared";
import type { EventFile, EventType, Session, TranscriptEvent } from "@/lib/types";
import { JsonView } from "./JsonView";

type Props = {
  asideIsLauncherDup: boolean;
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
  asideIsLauncherDup,
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
    <aside className="aside" data-testid="aside">
      {asideIsLauncherDup ? (
        <div className="detail" data-testid="detail">
          <div className="detail-placeholder" data-testid="detail-placeholder" data-aside-placeholder="step-inspect">
            Select a step to inspect
          </div>
        </div>
      ) : (
        <div className="detail" data-testid="detail">
          <div className="detail-head" data-testid="detail-head">
            <span className={`event-icon ${selType}`} data-testid="event-icon" aria-hidden>{TYPE_GLYPH[selType] ?? "•"}</span>
            <span className="dtitle" data-testid="dtitle">{selType === "bash" ? "Bash (shell)" : EVENT_LABEL[selType]}</span>
            <span className="spacer" data-testid="spacer" />
            {selected?.exitCode != null && <span className={`badge ${selStatusClass}`} data-testid="badge">{selStatusText}</span>}
          </div>

          <div className="detail-actions" data-testid="detail-actions">
            <button type="button" className={`btn${selPinned ? " btn-primary" : ""}`} data-testid="btn" onClick={togglePin} disabled={!selected}>
              📌 {selPinned ? "Pinned" : "Pin"}
            </button>
            <button type="button" className="btn" data-testid="btn" onClick={openNoteEditor} disabled={!selected}>
              🗒 {selNote ? "Edit Note" : "Add Note"}
            </button>
            {selected && eventsWithDiff.has(selected.id) && (
              <button type="button" className="btn" data-testid="btn" onClick={openSelectedDiff} title="See the Git diff this edit produced (jump to the Git tab)">
                ⎇ Diff →
              </button>
            )}
          </div>

          {noteDraft != null && (
            <div style={{ padding: "0 16px 12px" }}>
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Note for this event…"
                rows={3}
                autoFocus
                style={{
                  width: "100%",
                  fontFamily: "var(--sans)",
                  fontSize: "12.5px",
                  padding: "8px",
                  border: "1px solid var(--border-strong)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--panel)",
                  color: "var(--text)",
                  resize: "vertical",
                }}
              />
              <div style={{ display: "flex", gap: "6px", marginTop: "6px" }}>
                <button type="button" className="btn btn-sm btn-primary" data-testid="btn" onClick={saveNote}>Save</button>
                <button type="button" className="btn btn-sm" data-testid="btn" onClick={() => setNoteDraft(null)}>Cancel</button>
              </div>
            </div>
          )}

          {selNote && noteDraft == null && (
            <div className="kv" data-testid="kv" style={{ borderTop: 0, paddingTop: 0, gridTemplateColumns: "1fr" }}>
              <dd style={{ background: "var(--accent-weak)", padding: "8px 10px", borderRadius: "var(--radius-sm)" }}>🗒 {selNote}</dd>
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
                <button type="button" className="io-copy" data-testid="io-copy" onClick={() => copy("cmd", selected.command ?? "")}>
                  {copied === "cmd" ? "✓ copied" : "⧉ copy"}
                </button>
              </div>
              <pre className="code-block cmd" data-testid="code-block">{selected.command}</pre>
            </div>
          )}
          <div className="io-block io-output" data-testid="io-block">
            <div className="io-head" data-testid="io-head">
              <span>{outputLabel(selType)}</span>
              {selected?.body && (
                <button type="button" className="io-copy" data-testid="io-copy" onClick={() => copy("out", selected.body ?? "")}>
                  {copied === "out" ? "✓ copied" : "⧉ copy"}
                </button>
              )}
            </div>
            <pre className="code-block output" data-testid="code-block" data-block-kind="output">
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
            <div className="panel-title" data-testid="panel-title" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span>Run JSON</span>
              <button type="button" className="btn btn-sm" data-testid="btn" onClick={() => copy("runjson", JSON.stringify(runJson, null, 2))} disabled={!selected}>
                {copied === "runjson" ? "Copied ✓" : "⧉ Copy"}
              </button>
            </div>
          </div>
          <pre className="run-json" data-testid="run-json">
            <JsonView value={runJson} />
          </pre>
        </div>
      )}
    </aside>
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
