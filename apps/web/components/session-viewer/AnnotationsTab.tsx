import type { AnnotationKind, TranscriptEvent } from "@/lib/types";

type Annotation = {
  id: number;
  atSeq: number;
  kind: AnnotationKind;
  note: string | null;
};

export function AnnotationsTab({
  annotations,
  events,
  jumpToEvent,
}: {
  annotations: Annotation[];
  events: TranscriptEvent[];
  jumpToEvent: (eventId: string) => void;
}) {
  return (
    <div className="timeline annotations-tab" data-testid="timeline" data-panel="annotations">
      <div className="annotations-tab-head" data-testid="annotations-tab-head">
        <span className="ann-tab-label" data-testid="ann-tab-label">Annotations</span>
        <span className="count mono" data-testid="count">{annotations.length}</span>
      </div>
      <div className="annotations-tab-sub" data-testid="annotations-tab-sub">
        Notable moments flagged along the run — errors, commits &amp; tests, in time order. Click one to jump to that step in the Transcript.
      </div>
      {annotations.length === 0 ? (
        <div className="empty" data-testid="empty" style={{ padding: "16px" }}>
          No flagged moments in this session.
        </div>
      ) : (
        [...annotations].sort((a, b) => a.atSeq - b.atSeq).map((a) => {
          const target = events.find((e) => e.seq === a.atSeq && !e.parentId) ?? events.find((e) => e.seq === a.atSeq);
          const jump = () => {
            if (target) jumpToEvent(target.id);
          };
          return (
            <div
              key={a.id}
              className="annotation annotation-tab-row"
              data-testid="annotation"
              data-annotation-seq={a.atSeq}
              onClick={jump}
              role={target ? "button" : undefined}
              tabIndex={target ? 0 : undefined}
              onKeyDown={(ev) => {
                if (target && (ev.key === "Enter" || ev.key === " ")) {
                  ev.preventDefault();
                  jump();
                }
              }}
              title={target ? `${a.kind} at step ${a.atSeq} — click to jump to the Transcript` : `${a.kind} at step ${a.atSeq}`}
              style={{ cursor: target ? "pointer" : "default" }}
            >
              <span className="amain" data-testid="amain">
                <span className="ameta" data-testid="ameta">
                  <span className={`akind-tag ${a.kind as AnnotationKind}`} data-testid="akind-tag">{a.kind}</span>
                  <span className="aseq" data-testid="aseq">step {a.atSeq}</span>
                </span>
                {a.note && <span className="atxt" data-testid="atxt">{a.note}</span>}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
