"use client";

// components/TopBarProjectSelect.tsx — routing container for the real
// project-SCOPE control in the shell TopBar (Layout v2,
// design/layout-architecture.md).
//
// It is the single project-scope control for the whole app: selecting a project
// writes the scope to the `?project=<id|all>` URL query param (default `all`).
// Every section that scopes by project reads that param (Sessions surface /
// Overview today).
//
// The dropdown itself is the DS ProjectScope view. This container owns only
// routing, search params, and the option/session labels passed into that view.
//
// Breadcrumb shape: `Lathe / <project>` always; when viewing a session
// (`/?session=<id>`) a second read-only segment appends the session title
// (or a short id) → `Lathe / <project> / <session title>`, so the user can tell
// which session they are in from the top.

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { ProjectScope } from "@/design-system/components";

export interface TopBarProject {
  project: string;
  sessions: number;
  cost: number;
  costKnown: boolean;
}

export interface TopBarSessionTitle {
  id: string;
  title: string;
}

export default function TopBarProjectSelect({
  projects,
  totalSessions,
  sessionTitles = [],
}: {
  projects: TopBarProject[];
  totalSessions: number;
  sessionTitles?: TopBarSessionTitle[];
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const current = searchParams.get("project") ?? "all";

  // the label shown in the breadcrumb segment (mirrors the active option).
  const label =
    current === "all"
      ? "All projects"
      : projects.find((p) => p.project === current)?.project ?? current;

  // ---- current session breadcrumb segment (Fix B) --------------------------
  // When the URL targets a single session, append it as a read-only segment.
  // Resolve the title from the shell-loaded id->title list; fall back to a short
  // id when the title is unknown (e.g. a not-yet-loaded session).
  const sessionId = searchParams.get("session");
  const sessionLabel = sessionId
    ? sessionTitles.find((s) => s.id === sessionId)?.title ?? shortId(sessionId)
    : null;

  const onChange = (value: string) => {
    if (value === current) return;
    const next = new URLSearchParams(searchParams.toString());
    if (value === "all") next.delete("project");
    else next.set("project", value);
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // option list: the synthetic "all" row first, then one row per project. Each
  // carries the value written to ?project= and the visible label.
  const options = [
    { value: "all", label: `All projects · ${totalSessions} sessions` },
    ...projects.map((p) => ({
      value: p.project,
      label: `${p.project} · ${p.sessions} ses · ${p.costKnown ? `$${p.cost.toFixed(0)}` : "—"}`,
    })),
  ];

  return (
    <ProjectScope
      options={options}
      value={current}
      currentLabel={label}
      onValueChange={onChange}
      sessionLabel={sessionLabel}
    />
  );
}

// short, stable fallback for an unknown session id (first 8 chars).
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
