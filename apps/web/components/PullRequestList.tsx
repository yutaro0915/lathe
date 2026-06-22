"use client";

import Link from "next/link";
import { fmtInt, parseStamp } from "@lathe/shared";
import Surface from "@/components/Surface";
import { Badge } from "@/components/ds";
import { Icon } from "@/components/ds/icons";
import type { PullRequestSummary } from "@/lib/types";

function stateLabel(pr: PullRequestSummary): string {
  if (pr.mergedAt || pr.state === "merged") return "merged";
  return pr.state;
}

function prMeta(pr: PullRequestSummary): string {
  const branch = pr.headRefName ?? "unknown branch";
  const base = pr.baseRefName ? ` -> ${pr.baseRefName}` : "";
  return `${pr.projectId} · ${branch}${base}`;
}

function prStat(pr: PullRequestSummary): string {
  if (typeof pr.additions === "number" && typeof pr.deletions === "number") {
    return `+${fmtInt(pr.additions)} -${fmtInt(pr.deletions)}`;
  }
  return `updated ${parseStamp(pr.updatedAt).date}`;
}

export default function PullRequestList({ pullRequests }: { pullRequests: PullRequestSummary[] }) {
  return (
    <Surface surface="pr" title="Pull Requests" meta={`${pullRequests.length} imported`}>
      <div className="pr-list-page" data-testid="pr-list">
        {pullRequests.length === 0 ? (
          <div className="empty" data-testid="empty">
            No pull requests imported. Run verify:pr first.
          </div>
        ) : (
          <div className="pr-comparison-list" data-testid="pr-comparison-list">
            {pullRequests.map((pr) => {
              const state = stateLabel(pr);
              return (
                <Link
                  key={pr.id}
                  href={`/pr?pr=${encodeURIComponent(pr.id)}`}
                  className="pr-row"
                  data-testid="pr-list-row"
                >
                  <span className="pr-row-icon" data-testid="pr-state-icon" title={state}>
                    <Icon name="pr" size={15} />
                  </span>
                  <span className="pr-row-title" data-testid="pr-list-title" data-ellipsis-ok title={pr.title}>
                    {pr.title}
                  </span>
                  <span className="pr-row-number" data-testid="pr-number">#{pr.number}</span>
                  <Badge tone="neutral" className="pr-state-badge" data-testid="pr-state-badge">
                    {state}
                  </Badge>
                  <span className="pr-row-meta" data-testid="pr-list-meta" data-ellipsis-ok title={prMeta(pr)}>
                    {prMeta(pr)}
                  </span>
                  <span className="pr-row-stat" data-testid="pr-list-stat">{prStat(pr)}</span>
                  <span className="pr-row-chevron" aria-hidden>
                    <Icon name="chevronRight" size={13} />
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </Surface>
  );
}
