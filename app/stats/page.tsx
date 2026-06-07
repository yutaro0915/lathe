// app/stats/page.tsx — legacy stats route, now a thin REDIRECT to /overview.
//
// Stats now live in two distinct places (they answer different questions):
//   • /overview — cross-session analytics (per project / all projects)
//   • /?tab=stats — in-session analytics (charts for ONE specific run)
// The legacy /stats URL was the cross-session one, so we forward it there.

export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

export default function Page() {
  redirect("/overview");
}
