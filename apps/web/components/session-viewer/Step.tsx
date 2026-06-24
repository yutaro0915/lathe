import * as React from "react";
import { KIND_GLYPH, KIND_LABEL, kindOf, hasErrorState } from "@/lib/event-display";
import { fmtInt } from "@lathe/shared";
import type { ChangedFile, DiffHunk, TranscriptEvent } from "@/lib/types";
import { Markdown } from "@/components/Markdown";
import { firstNonEmptyLine } from "./types";

// Step.tsx — the SINGLE uniform step component (D8). Its FRAME is invariant
// across kinds: [kind icon][optional clean-red error dot][kind label][one-line
// detail, ellipsized][optional trailing signal]. Only the icon, the signal, and
// the inline DETAIL-BLOCK content vary by kind (D7: thinking / investigate /
// execute / edit / message). `error` is NOT a kind — it is a cross-cutting STATE
// (clean red, var(--c-error)) layered on top WITHOUT changing the frame shape.
// Clicking the frame expands the detail-block in place (no side pane). There is
// exactly ONE container element per step regardless of kind — the gate against
// per-kind layout drift (D8). A `subagent` step additionally expands its child
// steps (the existing nested hierarchy), each rendered as its own Step.

export type StepEdit = { file: ChangedFile; hunks: DiffHunk[] } | null;

type Props = {
  event: TranscriptEvent;
  depth: number;
  turn?: number; // the 1-based turn this step belongs to (for cross-tab jumps)
  selectedEventId?: string;
  expanded?: boolean;
  flashEventId?: string | null;
  // sub-agent nesting: child steps + expand wiring (only when this step launched
  // a sub-agent). `null` when the step has no children.
  childSteps?: TranscriptEvent[];
  agentExpanded?: boolean;
  onToggleAgent?: (eventId: string) => void;
  // edit detail-block data (resolved by the parent from the bundle): the changed
  // file + its hunks for an `edit` step. `null` when not an edit / not resolved.
  edit?: StepEdit;
  // child-step resolvers (so nested steps get their own edit data + nesting).
  resolveEdit?: (e: TranscriptEvent) => StepEdit;
  onSelect: (eventId: string) => void;
};

const StepExpansionContext = React.createContext<Set<string> | null>(null);

export function StepExpansionProvider({
  expandedEventIds,
  children,
}: {
  expandedEventIds: Set<string>;
  children: React.ReactNode;
}) {
  return <StepExpansionContext.Provider value={expandedEventIds}>{children}</StepExpansionContext.Provider>;
}

// The one-line detail shown on the frame (right of the kind label), ellipsized.
// Varies by kind but is always a single line in the SAME slot.
function frameDetail(event: TranscriptEvent, edit: StepEdit): React.ReactNode {
  const kind = kindOf(event.type);
  if (kind === "edit") {
    const path = edit?.file.path ?? event.filePath ?? event.title;
    return <span className="lds-step-mono">{path}</span>;
  }
  if (kind === "execute") {
    return <span className="lds-step-mono">{event.command ?? event.title}</span>;
  }
  if (kind === "investigate") {
    return event.filePath ? <span className="lds-step-mono">{event.filePath}</span> : <span>{event.title}</span>;
  }
  // thinking / message: the first non-empty line of the body, else the title.
  return <span>{firstNonEmptyLine(event.body) || event.title}</span>;
}

// The trailing signal on the frame (right edge), e.g. "+128 −44" for an edit or
// "exit 1" (clean red) for an errored execute. Optional; many steps have none.
function frameSignal(event: TranscriptEvent, edit: StepEdit, isError: boolean): React.ReactNode {
  if (isError) {
    const code = event.exitCode != null && event.exitCode !== 0 ? `exit ${event.exitCode}` : "error";
    return <span className="lds-step-signal lds-step-signal-error" data-testid="step-signal-error">{code}</span>;
  }
  if (edit) {
    return (
      <span className="lds-step-signal lds-step-mono" data-testid="step-signal">
        +{fmtInt(edit.file.additions)} −{fmtInt(edit.file.deletions)}
      </span>
    );
  }
  if (event.exitCode === 0) {
    return <span className="lds-step-signal lds-step-mono" data-testid="step-signal">exit 0</span>;
  }
  return null;
}

// A compact unified diff for the edit detail-block, reusing the .diff-line DS
// primitive (same markup the Git tab uses). Lines wrap (no horizontal spill).
function StepDiff({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div className="lds-codebox lds-step-diff" data-testid="step-diff" data-scroll>
      {hunks.map((h) => {
        const lines = h.content.split("\n");
        return (
          <div className="lds-step-hunk" data-testid="step-hunk" key={h.id}>
            <div className="lds-step-hunk-head" data-testid="step-hunk-head">{h.header}</div>
            {lines.map((line, li) => {
              const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
              const marker = cls === "add" ? "+" : cls === "del" ? "-" : " ";
              const text = cls ? line.slice(1) : line;
              return (
                <div className={`diff-line${cls ? " " + cls : ""}`} data-testid="diff-line" key={`${h.id}-${li}`} style={{ gridTemplateColumns: "16px minmax(0,1fr)" }}>
                  <span className="marker" data-testid="marker">{marker}</span>
                  <span className="ltext" data-testid="ltext">{text}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// The inline detail-block content (below the frame when the step is expanded).
// The CONTAINER is the same .lds-step-detail for every kind; only the inner
// content differs (D8). The content is READABLE (the user wants outputs
// viewable in the transcript): command + output (execute), file + diff (edit),
// full body (thinking / message / investigate).
function StepDetail({ event, edit }: { event: TranscriptEvent; edit: StepEdit }) {
  const kind = kindOf(event.type);
  return (
    <div className="lds-step-detail" data-testid="step-detail">
      {event.command && (
        <pre className="lds-codebox code-block cmd" data-testid="code-block" data-block-kind="cmd" data-scroll>{event.command}</pre>
      )}
      {kind === "edit" && edit && edit.hunks.length > 0 ? (
        <StepDiff hunks={edit.hunks} />
      ) : kind === "edit" ? (
        <div className="lds-step-empty muted" data-testid="step-detail-empty">
          {edit ? `${edit.file.path} · +${fmtInt(edit.file.additions)} −${fmtInt(edit.file.deletions)}` : event.filePath ?? "(no diff captured)"}
        </div>
      ) : (event.type === "thinking" || event.type === "assistant_message" || event.type === "todo" || event.type === "user_message") ? (
        event.body ? (
          <div className="lds-step-body" data-testid="step-detail-body"><Markdown text={event.body} /></div>
        ) : (
          <pre className="lds-codebox code-block output" data-testid="code-block" data-block-kind="output" data-scroll>
            <span className="muted" data-testid="muted">(no content captured)</span>
          </pre>
        )
      ) : (
        <pre className="lds-codebox code-block output" data-testid="code-block" data-block-kind="output" data-scroll>
          {event.body ? event.body : <span className="muted" data-testid="muted">(no output captured)</span>}
        </pre>
      )}
    </div>
  );
}

export function Step({
  event,
  depth,
  turn,
  selectedEventId,
  expanded,
  flashEventId,
  childSteps,
  agentExpanded,
  onToggleAgent,
  edit = null,
  resolveEdit,
  onSelect,
}: Props) {
  const kind = kindOf(event.type);
  const isError = hasErrorState(event.type, event.exitCode);
  const glyph = KIND_GLYPH[kind];
  const hasChildren = (childSteps?.length ?? 0) > 0;
  const isAgent = event.type === "subagent" && hasChildren;
  const selected = selectedEventId === event.id;
  const expandedEventIds = React.useContext(StepExpansionContext);
  const open = expanded ?? expandedEventIds?.has(event.id) ?? false;
  const flash = flashEventId === event.id;

  return (
    <div className="lds-step-wrap" data-testid="step-wrap" data-child-row={depth > 0 ? "true" : undefined}>
      <div
        data-eid={event.id}
        data-testid="event-row"
        data-row-kind="step"
        data-step-kind={kind}
        data-event-kind={event.type}
        data-step-error={isError ? "true" : undefined}
        data-turn={turn}
        data-selected={selected ? "true" : undefined}
        data-expanded={open ? "true" : undefined}
        data-flash={flash ? "true" : undefined}
        data-child-row={depth > 0 ? "true" : undefined}
        className={`lds-step${selected ? " selected" : ""}${flash ? " flash-jump" : ""}${depth > 0 ? " lds-step-child" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(event.id)}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onSelect(event.id);
          }
        }}
      >
        <span className={`event-icon ${event.type}`} data-testid="event-icon" data-event-kind={event.type} data-step-kind={kind} aria-hidden>
          {glyph}
        </span>
        <div className="lds-step-head" data-testid="step-head">
          {isError && <span className="lds-step-errdot" data-testid="step-errdot" title="error" />}
          <span className="lds-step-kind" data-testid="step-kind-label">{KIND_LABEL[kind]}</span>
          {/* the one-line detail intentionally ellipsizes; data-ellipsis-ok marks
              the clip as non-silent for the layout-integrity gate. */}
          <span className="lds-step-line" data-testid="step-line" data-ellipsis-ok>{frameDetail(event, edit)}</span>
          {frameSignal(event, edit, isError)}
          {isAgent && (
            <button
              type="button"
              className="tw-expand"
              data-testid="tw-expand"
              aria-label={agentExpanded ? "Collapse sub-agent" : "Expand sub-agent"}
              onClick={(ev) => {
                ev.stopPropagation();
                onToggleAgent?.(event.id);
              }}
            >
              {agentExpanded ? "▾" : "▸"}
            </button>
          )}
        </div>
      </div>
      {open && <StepDetail event={event} edit={edit} />}
      {isAgent && agentExpanded && (
        <div className="lds-step-children" data-testid="step-children">
          {childSteps!.map((child) => (
            <Step
              key={child.id}
              event={child}
              depth={depth + 1}
              selectedEventId={selectedEventId}
              expanded={expandedEventIds?.has(child.id) ?? false}
              flashEventId={flashEventId}
              edit={resolveEdit ? resolveEdit(child) : null}
              resolveEdit={resolveEdit}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
