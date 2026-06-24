import type { TranscriptEvent } from "@/lib/types";
import { Button } from "@/design-system/components";
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
    <div className="timeline" data-testid="timeline" style={{ padding: "var(--sp-12) var(--sp-16)" }}>
      <div className="panel-title raw-tab-title" data-testid="panel-title">
        <span>{selected ? `Selected event ${selected.seq}` : "Events array"}</span>
        <Button size="sm" data-testid="btn" onClick={() => copy("raw-main", JSON.stringify(selected ?? events, null, 2))}>
          {copied === "raw-main" ? "Copied ✓" : "⧉ Copy"}
        </Button>
      </div>
      <pre className="lds-codebox run-json" data-testid="run-json" style={{ whiteSpace: "pre-wrap" }}>
        <JsonView value={selected ?? events} />
      </pre>
    </div>
  );
}
