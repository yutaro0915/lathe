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
    <div className="tabs" data-testid="tabs" role="tablist">
      {TABS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={activeTab === key}
          data-tab={key}
          className={`tab${activeTab === key ? " active" : ""}`}
          data-testid="tab"
          onClick={() => {
            setActiveTab(key);
            if (key === "git") clearGitFocus();
          }}
        >
          {label}
          {key === "annotations" && annotationsCount > 0 && <span className="tab-count" data-testid="tab-count">{annotationsCount}</span>}
          {key === "findings" && pendingFindingsCount > 0 && <span className="tab-count" data-testid="tab-count">{pendingFindingsCount}</span>}
        </button>
      ))}
      <span className="tabs-spacer" data-testid="tabs-spacer" />
      <span className="tabs-tool" data-testid="tabs-tool">
        <span className="sort-select" data-testid="sort-select">{visibleCount} shown</span>
      </span>
    </div>
  );
}
