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
  getSessionPrSummary,
  listFindings,
} from "@/lib/db";
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

  // "Workspace mode" = any param that scopes/targets a single session. Bare "/"
  // (no such param) is the LIST surface. Overview drill-downs (model/from/to/
  // errors) and finding jumps (seq/fromFinding) and ?tab all open the workspace.
  const hasState =
    !!req ||
    typeof sp.tab === "string" ||
    typeof sp.seq === "string" ||
    typeof sp.fromFinding === "string" ||
    typeof sp.model === "string" ||
    typeof sp.from === "string" ||
    typeof sp.to === "string" ||
    typeof sp.errors === "string";

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
  if (!hasState) {
    return (
      <SessionsSurface sessions={sessions} projects={projects} sessionProject={sessionProject} />
    );
  }

  // ---- WORKSPACE (per-session viewer) -------------------------------------
  const [sessionPrs, findings, requestedBundle] = await Promise.all([
    getSessionPrSummary(),
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
  const initialModel = typeof sp.model === "string" && sp.model.trim() ? sp.model : undefined;
  const initialFrom = typeof sp.from === "string" && sp.from.trim() ? sp.from : undefined;
  const initialTo = typeof sp.to === "string" && sp.to.trim() ? sp.to : undefined;
  const initialErrors = sp.errors === "yes" ? "yes" : sp.errors === "no" ? "no" : undefined;
  return (
    <SessionViewer
      sessions={sessions}
      bundle={bundle}
      currentId={id}
      projects={projects}
      sessionProject={sessionProject}
      sessionPrs={sessionPrs}
      findings={findings}
      initialTab={initialTab}
      initialSeq={initialSeq}
      initialFromFinding={initialFromFinding}
      initialModel={initialModel}
      initialFrom={initialFrom}
      initialTo={initialTo}
      initialErrors={initialErrors}
    />
  );
}
