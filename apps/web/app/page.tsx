// app/page.tsx — the Sessions AXIS.
//
// Thin SERVER wrapper. Two states of the same axis:
//   • bare "/"          → the cross-session Sessions LIST surface (full-width in
//                         the work area; the left is navigation only — design.md
//                         IA decision). Rendered by <SessionsSurface>.
//   • "/?session=<id>"  → the per-session WORKSPACE (transcript / git / stats /
//     (or any state param)  findings …), rendered by the existing <SessionViewer>.
//
// Opening a row on the list navigates to "/?session=<id>"; the global rail still
// reads "Sessions" (same axis, different state). Overview drill-downs land here
// with seed params (model / from-to / errors / tab / seq / fromFinding) and open
// the workspace already scoped.

export const dynamic = "force-dynamic";

import {
  getSessionBundle,
  getPrimarySession,
  listSessions,
  getProjectStats,
  listFindings,
} from "@/lib/read";
import SessionViewer from "@/components/SessionViewer";
import SessionsSurface from "@/components/SessionsSurface";

const TABS = ["transcript", "tools", "git", "skills", "subagents", "annotations", "findings", "raw", "stats"] as const;
type Tab = (typeof TABS)[number];

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const req = typeof sp.session === "string" ? sp.session : undefined;

  // "Workspace mode" = a param that targets a SINGLE session (session id, a tab,
  // a step seq, or a finding jump). Bare "/" — and the list-scoping params
  // (model / from / to / errors) that an Overview drill-down carries — render the
  // full-width LIST surface. The list, and the cross-session navigation it gives,
  // now lives only here on "/" (the per-session viewer's session-list sidebar was
  // removed), so a period/model drill-down lands on the list rather than inside a
  // single session's workspace where there is no list to scope.
  const hasState =
    !!req ||
    typeof sp.tab === "string" ||
    typeof sp.seq === "string" ||
    typeof sp.fromFinding === "string";

  // The project scope select + the session->project map are needed by BOTH the
  // list surface and the viewer's sidebar, so compute them once up front.
  const [sessions, projectStats] = await Promise.all([listSessions(), getProjectStats()]);
  const projects = projectStats.map((p) => ({
    project: p.project,
    sessions: p.sessions,
    cost: p.cost,
    costKnown: p.costKnown,
  }));
  const sessionProject: Record<string, string> = {};
  for (const p of projectStats) for (const r of p.sessionRefs) sessionProject[r.id] = p.project;

  // ---- LIST surface (bare "/") --------------------------------------------
  // Overview drill-downs land here carrying list-scoping params (model / from /
  // to / errors); pass them so the surface opens pre-filtered, the same way the
  // (removed) viewer sidebar used to seed its filters from these params.
  if (!hasState) {
    const initialModel = typeof sp.model === "string" && sp.model.trim() ? sp.model : undefined;
    const initialFrom = typeof sp.from === "string" && sp.from.trim() ? sp.from : undefined;
    const initialTo = typeof sp.to === "string" && sp.to.trim() ? sp.to : undefined;
    const initialErrors = sp.errors === "yes" ? "yes" : sp.errors === "no" ? "no" : undefined;
    return (
      <SessionsSurface
        sessions={sessions}
        projects={projects}
        sessionProject={sessionProject}
        initialModel={initialModel}
        initialFrom={initialFrom}
        initialTo={initialTo}
        initialErrors={initialErrors}
      />
    );
  }

  // ---- WORKSPACE (per-session viewer) -------------------------------------
  // The per-session viewer no longer renders a session-list sidebar, so it no
  // longer needs the cross-session PR summary or the Overview drill-down filter
  // seeds (model / from / to / errors); those query params are still accepted on
  // the URL but only affect the Sessions surface's list now.
  const [findings, requestedBundle] = await Promise.all([
    listFindings(),
    req ? getSessionBundle(req) : Promise.resolve(undefined),
  ]);
  const id = requestedBundle ? req! : (await getPrimarySession()).id;
  const bundle = requestedBundle ?? (await getSessionBundle(id))!;
  const initialTab: Tab =
    typeof sp.tab === "string" && (TABS as readonly string[]).includes(sp.tab)
      ? (sp.tab as Tab)
      : "transcript";
  const seqRaw = typeof sp.seq === "string" ? Number(sp.seq) : NaN;
  const initialSeq = Number.isInteger(seqRaw) && seqRaw > 0 ? seqRaw : undefined;
  const fromFindingRaw = typeof sp.fromFinding === "string" ? Number(sp.fromFinding) : NaN;
  const initialFromFinding =
    Number.isInteger(fromFindingRaw) && fromFindingRaw > 0 ? fromFindingRaw : undefined;
  return (
    <SessionViewer
      sessions={sessions}
      bundle={bundle}
      currentId={id}
      findings={findings}
      initialTab={initialTab}
      initialSeq={initialSeq}
      initialFromFinding={initialFromFinding}
    />
  );
}
