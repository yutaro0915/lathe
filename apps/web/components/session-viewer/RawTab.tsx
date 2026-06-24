import type { TranscriptEvent } from "@/lib/types";
import { JsonView } from "./JsonView";

export function RawTab({
  selected,
  events,
  copied,
  copy,
}: {
  selected?: TranscriptEvent;
  events: TranscriptEvent[];
  copied: string | null;
  copy: (key: string, text: string) => void;
}) {
  return (
    <div className="timeline" data-testid="timeline" style={{ padding: "12px 14px" }}>
      <div className="panel-title" data-testid="panel-title" style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span>{selected ? `Selected event ${selected.seq}` : "Events array"}</span>
        <button type="button" className="btn btn-sm" data-testid="btn" onClick={() => copy("raw-main", JSON.stringify(selected ?? events, null, 2))}>
          {copied === "raw-main" ? "Copied ✓" : "⧉ Copy"}
        </button>
      </div>
      <pre className="lds-codebox run-json" data-testid="run-json" style={{ whiteSpace: "pre-wrap" }}>
        <JsonView value={selected ?? events} />
      </pre>
    </div>
  );
}
