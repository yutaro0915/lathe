// app/findings/page.tsx — the cross-session Findings AXIS.
//
// The global bar's "Findings" lands here. Cross-session is the axis's job; the
// session viewer's Findings TAB shows only findings attached to that one session
// (design/ui-design-language.md, IA principle 2026-06-12).

export const dynamic = "force-dynamic";

import { listFindings, listSessions } from "@/lib/read";
import FindingsAxisView from "@/components/FindingsAxisView";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const [findings, sessions] = await Promise.all([listFindings(), listSessions()]);
  // ?session=… is a state of THIS screen (which session the filter is scoped to),
  // not a separate screen — so it is honoured as the initial session filter.
  const initialSessionFilter =
    typeof sp.session === "string" && sp.session.trim() ? sp.session : undefined;
  return (
    <FindingsAxisView
      findings={findings}
      sessions={sessions}
      initialSessionFilter={initialSessionFilter}
    />
  );
}
