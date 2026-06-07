// app/stats/page.tsx — legacy stats route, now a thin REDIRECT.
//
// Cross-session statistics used to be their own page with their own shell. They
// are now an in-page "Stats" tab inside the session viewer (same shell — the
// session list stays put), so this route just forwards to that tab. Any old
// /stats link keeps working.
// node:sqlite logs an ExperimentalWarning at runtime — harmless.

export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

export default function Page() {
  redirect("/?tab=stats");
}
