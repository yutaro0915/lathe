"use client";

// components/TopBarProjectSelect.tsx — the real project-SCOPE control, in the
// shell TopBar (Layout v2, design/layout-architecture.md).
//
// Per the updated TopBar spec, the project control is a BORDERLESS breadcrumb
// segment (like Langfuse's `/ Yutaro Ono v`): a `/` separator, the current
// project name, and a chevron — plain text + chevron, no box/border/outline.
// It is NOT a bordered control and carries no app-feature actions; the TopBar
// holds scope + identity only (topbar-scope-only).
//
// It is the single project-scope control for the whole app: selecting a project
// writes the scope to the `?project=<id|all>` URL query param (default `all`).
// Every section that scopes by project reads that param (Sessions surface /
// Overview today). The native <select> keeps the stable `project-picker` testid
// and its `value="all"` option, so the project-filter e2e contract lives here.

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Icon } from "@/components/ds/icons";

export interface TopBarProject {
  project: string;
  sessions: number;
  cost: number;
  costKnown: boolean;
}

export default function TopBarProjectSelect({
  projects,
  totalSessions,
}: {
  projects: TopBarProject[];
  totalSessions: number;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const current = searchParams.get("project") ?? "all";

  // the label shown in the breadcrumb segment (the <select> overlays it, so the
  // text mirrors the active option).
  const label =
    current === "all"
      ? "All projects"
      : projects.find((p) => p.project === current)?.project ?? current;

  const onChange = (value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value === "all") next.delete("project");
    else next.set("project", value);
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <span className="lds-tb-scope" data-testid="topbar-scope" data-scope={current}>
      <span className="lds-tb-scope-sep" aria-hidden>
        /
      </span>
      <span className="lds-tb-scope-name" data-testid="topbar-scope-name">
        {label}
      </span>
      <span className="lds-tb-scope-ic" aria-hidden>
        <Icon name="chevronDown" size={13} />
      </span>
      {/* the real control: an invisible native <select> overlaying the segment,
          so the borderless breadcrumb look is preserved while keeping native
          option semantics + the project-picker e2e contract. */}
      <select
        className="lds-tb-scope-sel project-picker"
        data-testid="project-picker"
        value={current}
        onChange={(e) => onChange(e.target.value)}
        title="Scope every section to one project"
        aria-label="Project scope"
      >
        <option value="all">All projects · {totalSessions} sessions</option>
        {projects.map((p) => (
          <option key={p.project} value={p.project}>
            {p.project} · {p.sessions} ses · {p.costKnown ? `$${p.cost.toFixed(0)}` : "—"}
          </option>
        ))}
      </select>
    </span>
  );
}
