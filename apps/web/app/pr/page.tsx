export const dynamic = "force-dynamic";

import { getPullRequestBundle, listPullRequests } from "@/lib/read";
import PullRequestDetail from "@/components/PullRequestDetail";
import PullRequestList from "@/components/PullRequestList";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const requested = typeof sp.pr === "string" ? sp.pr : undefined;
  if (requested) {
    const bundle = await getPullRequestBundle(requested);
    return <PullRequestDetail bundle={bundle} />;
  }

  const pullRequests = await listPullRequests();
  return <PullRequestList pullRequests={pullRequests} />;
}
