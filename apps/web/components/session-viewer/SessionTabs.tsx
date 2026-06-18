import type { Tab } from "./types";

const TABS = [
  ["transcript", "Transcript"],
  ["tools", "Tools"],
  ["git", "Git"],
  ["skills", "Skills"],
  ["subagents", "Subagents"],
  ["annotations", "Annotations"],
  ["findings", "Findings"],
  ["raw", "Raw JSON"],
  ["stats", "Stats"],
] as const;

// SessionTabs renders into the Surface's tabs slot (the row directly under the
// single shell-owned WorkareaHeader). It no longer draws the standalone
// `.lds-session-tabs` strip that sat at a different indent from the metrics band
// (the origin of the header step). The `tabs` / `tab` / `tab-count` testids and
// role="tab"/aria-selected semantics are unchanged.
export function SessionTabs({
  activeTab,
  setActiveTab,
  annotationsCount,
  pendingFindingsCount,
  visibleCount,
  clearGitFocus,
}: {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  annotationsCount: number;
  pendingFindingsCount: number;
  visibleCount: number;
  clearGitFocus: () => void;
}) {
  return (
    <div className="lds-sv-tabs" data-testid="tabs" role="tablist">
      {TABS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={activeTab === key}
          data-tab={key}
          className={`lds-sv-tab${activeTab === key ? " active" : ""}`}
          data-testid="tab"
          onClick={() => {
            setActiveTab(key);
            if (key === "git") clearGitFocus();
          }}
        >
          {label}
          {key === "annotations" && annotationsCount > 0 && <span className="lds-sv-tab-count" data-testid="tab-count">{annotationsCount}</span>}
          {key === "findings" && pendingFindingsCount > 0 && <span className="lds-sv-tab-count" data-testid="tab-count">{pendingFindingsCount}</span>}
        </button>
      ))}
      <span className="lds-sv-tabs-spacer" data-testid="tabs-spacer" />
      <span className="lds-sv-tabs-tool" data-testid="tabs-tool">
        <span className="sort-select" data-testid="sort-select">{visibleCount} shown</span>
      </span>
    </div>
  );
}
