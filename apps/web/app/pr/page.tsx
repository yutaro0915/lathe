export const dynamic = "force-dynamic";

import { getPullRequestBundle, listPullRequests } from "@/lib/db";
import PullRequestView from "@/components/PullRequestView";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const pullRequests = await listPullRequests();
  const requested = typeof sp.pr === "string" ? sp.pr : undefined;
  const selectedId =
    requested && pullRequests.some((pr) => pr.id === requested)
      ? requested
      : pullRequests[0]?.id;
  const bundle = selectedId ? await getPullRequestBundle(selectedId) : undefined;

  return <PullRequestView pullRequests={pullRequests} bundle={bundle} />;
}
