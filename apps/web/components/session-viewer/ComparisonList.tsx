import * as React from "react";
import { fmtCost, fmtInt, humanizeDuration } from "@lathe/shared";
import type { TranscriptEvent } from "@/lib/types";

// ComparisonList — the SHARED D11 comparison-list + D12 inline-expansion shell,
// reused by BOTH the Tools tab (peers = tool TYPES) and the Skills tab (peers =
// capability NAMES). The structure is identical to the Sessions list discipline:
// one row per peer, fixed-width metric columns that align into scannable columns,
// sorted by invocation count descending. Clicking a row expands it IN PLACE
// (chevron-right → chevron-down) to reveal that peer's member events, each
// rendered by the caller via `renderMember` (the reused single Step component,
// D8). There is NO side inspector and NO navigation (D12). Color is rationed
// (D10): rows are neutral; the only privileged hue is the per-member error STATE
// carried by Step (var(--c-error)). No timestamp gutter (D5).
//
// Tools and Skills differ ONLY in: the peers they aggregate, the eyebrow/hint
// copy, the per-row icon, and their data-testid namespace (Tools keeps the
// slice-7 `tool-*` testids — the e2e contract; Skills uses `skill-*`). Everything
// structural (rows, expand/collapse wiring, member rendering) lives here once.

export type ComparisonGroup = {
  // stable identity used for the expand-set key + data attributes.
  key: string;
  // the leading neutral icon glyph (D4/D10): a character, not a colored dot.
  icon: React.ReactNode;
  // the peer label shown in the flex-1 name column (mono, ellipsized).
  label: string;
  // optional title attr for the label (e.g. the full human name on a glyph row).
  labelTitle?: string;
  count: number;
  costUsd: number | null;
  durationMs: number;
  // optional override for the trailing metric column. When omitted the row shows
  // the default `cost · duration` (the Tools/Skills contract, unchanged). The
  // Subagents "All" view supplies its own `cost · N tools` string here (D18:
  // columns count / cost / tools) without forking the component.
  metric?: React.ReactNode;
  // the member events this peer aggregates, rendered inline when expanded.
  events: TranscriptEvent[];
};

export function ComparisonList({
  groups,
  expandedKeys,
  toggleKey,
  eyebrow,
  hint,
  renderMember,
  testidPrefix,
  groupAttr,
}: {
  groups: ComparisonGroup[];
  expandedKeys: Set<string>;
  toggleKey: (key: string) => void;
  eyebrow: string;
  hint: string;
  // the caller renders each member event (the reused Step component, D8).
  renderMember: (event: TranscriptEvent) => React.ReactNode;
  // testid namespace: "tool" (slice-7 contract) or "skill" (slice-8). Yields
  // `${prefix}s-list` / `${prefix}-row` / `${prefix}-count` / `${prefix}-body` …
  testidPrefix: string;
  // the data attribute carrying the peer key on the group/row (e.g.
  // "data-tool-type" / "data-skill-name"), for debugging + targeted styling.
  groupAttr: string;
}) {
  return (
    <div className="timeline" data-testid="timeline">
      <div className="lds-clist-caption" data-testid={`${testidPrefix}s-caption`}>
        <span className="lds-clist-caption-eyebrow">{eyebrow}</span>
        <span className="lds-clist-caption-hint">{hint}</span>
      </div>
      {/* D11 comparison-list: peer rows + fixed metric columns. Row click =
          inline expand (D12). Same list shape as Sessions / Tools. */}
      <div className="lds-clist" data-testid={`${testidPrefix}s-list`}>
        {groups.map((g) => {
          const open = expandedKeys.has(g.key);
          return (
            <div
              key={g.key}
              className={`lds-clist-group${open ? " open" : ""}`}
              data-testid={`${testidPrefix}-group`}
              {...{ [groupAttr]: g.key }}
              data-open={open ? "true" : undefined}
            >
              <div
                className="lds-clist-row"
                data-testid={`${testidPrefix}-row`}
                {...{ [groupAttr]: g.key }}
                role="button"
                tabIndex={0}
                aria-expanded={open}
                onClick={() => toggleKey(g.key)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    toggleKey(g.key);
                  }
                }}
              >
                {/* neutral icon (D4/D10): the glyph, not a colored dot. */}
                <span className="lds-clist-ic" data-testid={`${testidPrefix}-ic`} aria-hidden>
                  {g.icon}
                </span>
                <span
                  className="lds-clist-name"
                  data-testid={`${testidPrefix}-name`}
                  data-ellipsis-ok
                  title={g.labelTitle ?? g.label}
                >
                  {g.label}
                </span>
                <span className="lds-clist-count" data-testid={`${testidPrefix}-count`}>
                  ×{fmtInt(g.count)}
                </span>
                <span className="lds-clist-metric" data-testid={`${testidPrefix}-metric`}>
                  {g.metric ?? <>{fmtCost(g.costUsd)} · {humanizeDuration(g.durationMs > 0 ? g.durationMs : null)}</>}
                </span>
                <span className="lds-clist-chevron" data-testid={`${testidPrefix}-chevron`} aria-hidden>
                  {open ? "▾" : "▸"}
                </span>
              </div>

              {open && (
                <div className="lds-clist-body" data-testid={`${testidPrefix}-body`}>
                  {/* D8: each member is the reused single Step component (uniform
                      frame; kind from event.type; error = clean-red state). */}
                  {g.events.map((ev) => (
                    <React.Fragment key={ev.id}>{renderMember(ev)}</React.Fragment>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
