"use client";

import { fmtLatency } from "@lathe/shared";
import type { Annotation, ChangedFile, LinkedEvent, TranscriptEvent } from "@/lib/types";
import { confidenceLabel, methodLabel, toolName } from "./model";

export function AttributionPane({
  active,
  annotations,
  coveredCount,
  hunksLength,
  linkedEvents,
  rawJson,
  selected,
  selectedEvent,
  showBanner,
  showRawJson,
  onSetSelectedLinkedEventId,
  onSetShowRawJson,
  onJumpToEvent,
}: {
  active: ChangedFile | undefined;
  annotations: Annotation[];
  coveredCount: number;
  hunksLength: number;
  linkedEvents: LinkedEvent[];
  rawJson: string;
  selected: LinkedEvent | undefined;
  selectedEvent: TranscriptEvent | undefined;
  showBanner: boolean;
  showRawJson: boolean;
  onSetSelectedLinkedEventId: (id: string) => void;
  onSetShowRawJson: React.Dispatch<React.SetStateAction<boolean>>;
  onJumpToEvent?: (eventId: string) => void;
}) {
  return (
    <div className="lds-layout-aside" data-testid="aside">
      {showBanner && (
        <div className="attr-banner" data-testid="attr-banner">
          <span className="bi" data-testid="bi">⚠</span>
          <span>Some changes were made after shell commands; attribution is probabilistic.</span>
        </div>
      )}
      <div className="linked-events" data-testid="linked-events">
        <div className="panel-title" data-testid="panel-title">
          Linked Events <span className="count" data-testid="count">({linkedEvents.length})</span>
          {hunksLength > 0 && (
            <span className="muted small" data-testid="muted"> · {coveredCount}/{hunksLength} hunks linked</span>
          )}
        </div>
        {linkedEvents.map((linkedEvent, index) => {
          const isActive = !!selected && linkedEvent.event.id === selected.event.id;
          return (
            <div
              key={`${linkedEvent.event.id}-${linkedEvent.hunkId}-${index}`}
              className={`linked-event${isActive ? " active" : ""}`}
              data-testid="linked-event"
              role="button"
              tabIndex={0}
              onClick={() => {
                onSetSelectedLinkedEventId(linkedEvent.event.id);
                onSetShowRawJson(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSetSelectedLinkedEventId(linkedEvent.event.id);
                  onSetShowRawJson(false);
                }
              }}
            >
              <span className="le-idx" data-testid="le-idx">{index + 1}</span>
              <div className="le-body" data-testid="le-body">
                <div className="le-turn" data-testid="le-turn">
                  <b>Turn {linkedEvent.event.seq}:</b> {linkedEvent.event.title}
                </div>
                <div className="le-meta" data-testid="le-meta">
                  <span className={`confidence ${linkedEvent.confidence}`} data-testid="confidence">
                    {methodLabel(linkedEvent.method)}
                  </span>
                  <span className="le-conf" data-testid="le-conf">{confidenceLabel(linkedEvent.confidence)}</span>
                </div>
              </div>
              {onJumpToEvent && (
                <button
                  type="button"
                  className="le-jump"
                  data-testid="le-jump"
                  title="Jump to the transcript step that produced this hunk"
                  onClick={(event) => {
                    event.stopPropagation();
                    onJumpToEvent(linkedEvent.event.id);
                  }}
                >
                  ↩ step {linkedEvent.event.seq}
                </button>
              )}
            </div>
          );
        })}
        {linkedEvents.length === 0 && <div className="empty" data-testid="empty">No linked events.</div>}
      </div>

      {selected && selectedEvent && (
        <>
          <div className="panel-title" data-testid="panel-title" style={{ padding: "0 14px", margin: "4px 0 0" }}>
            Event Details
          </div>
          <dl className="kv" data-testid="kv">
            <dt>Time</dt>
            <dd className="v mono" data-testid="v">{selectedEvent.ts}</dd>
            <dt>Tool</dt>
            <dd className="v mono" data-testid="v">{toolName(selectedEvent, selected.method)}</dd>
            <dt>Path</dt>
            <dd className="v mono" data-testid="v">{selectedEvent.filePath ?? active?.path ?? "—"}</dd>
            <dt>Exit code</dt>
            <dd className="v mono" data-testid="v">{selectedEvent.exitCode != null ? selectedEvent.exitCode : "0"}</dd>
            <dt>Latency</dt>
            <dd className="v mono" data-testid="v">{fmtLatency(selectedEvent.durationMs)}</dd>
          </dl>
          <div className="diff-toolbar" data-testid="diff-toolbar" style={{ borderBottom: "none", paddingTop: 4 }}>
            <span className="fstats" data-testid="fstats">
              <span className="add" data-testid="add">+{active ? active.additions : 0}</span>
              {" / "}
              <span className="del" data-testid="del">-{active ? active.deletions : 0}</span>
            </span>
            <span className="spacer" data-testid="spacer" />
            <button type="button" className="btn btn-sm" data-testid="btn" onClick={() => onSetShowRawJson((value) => !value)}>
              {"{}"} Raw JSON
            </button>
          </div>
          {showRawJson && (
            <pre className="run-json" data-testid="run-json" style={{ margin: "0 14px 10px", whiteSpace: "pre-wrap" }}>
              {rawJson}
            </pre>
          )}
        </>
      )}

      {annotations.length > 0 && (
        <div className="annotations" data-testid="annotations">
          <div className="ahead" data-testid="ahead">
            Attribution notes <span className="count" data-testid="count">({annotations.length})</span>
          </div>
          {annotations.map((annotation) => (
            <div className="annotation" data-testid="annotation" key={annotation.id}>
              <span className={`akind ${annotation.kind}`} data-testid="akind" />
              <span className="nowrap" data-testid="nowrap">{annotation.note ?? annotation.kind}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
