"use client";

import Link from "next/link";
import { fmtCost, fmtInt, parseStamp } from "@lathe/shared";
import DiffViewer from "@/components/DiffViewer";
import { Badge, RunnerIcon, Surface } from "@/design-system/components";
import { Icon } from "@/design-system/components/icons";
import type { PullRequest, PullRequestBundle, PullRequestSessionLink } from "@/lib/types";

type ReviewRow = { state: string; author: string; submittedAt: string; body: string };

function stateLabel(pr: PullRequest): string {
  if (pr.mergedAt || pr.state === "merged") return "merged";
  return pr.state;
}

function reviewRows(reviews: unknown[]): ReviewRow[] {
  return reviews
    .map((review) => {
      if (!review || typeof review !== "object") return null;
      const r = review as Record<string, unknown>;
      const author = r.author && typeof r.author === "object" ? (r.author as Record<string, unknown>).login : null;
      return {
        state: typeof r.state === "string" ? r.state.toLowerCase() : "review",
        author: typeof author === "string" ? author : "unknown",
        submittedAt: typeof r.submittedAt === "string" ? r.submittedAt : "",
        body: typeof r.body === "string" ? r.body : "",
      };
    })
    .filter((row): row is ReviewRow => row !== null);
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 7) : "unknown";
}

function prTime(pr: PullRequest): string {
  if (pr.mergedAt) return `merged ${parseStamp(pr.mergedAt).date}`;
  return `updated ${parseStamp(pr.updatedAt).date}`;
}

function StrengthChip({ link, fallbackSha }: { link: PullRequestSessionLink; fallbackSha: string | null }) {
  const exact = link.linkMethod === "sha";
  const label = exact ? shortSha(link.matchedSha ?? fallbackSha) : "branch fallback";
  return (
    <span
      className={`pr-link-strength ${exact ? "sha" : "branch"}`}
      data-testid="pr-link-strength"
      title={exact ? "Precise link by matching commit SHA" : "Weak fallback link by matching branch"}
    >
      <Icon name={exact ? "link" : "branch"} size={12} />
      {label}
    </span>
  );
}

export default function PullRequestDetail({ bundle }: { bundle?: PullRequestBundle }) {
  if (!bundle) {
    return (
      <Surface surface="pr" title="Pull Request" meta="not found">
        <div className="pr-detail" data-testid="pr-detail">
          <div className="empty" data-testid="empty">
            Pull request not found.
          </div>
        </div>
      </Surface>
    );
  }

  const pr = bundle.pullRequest;
  const reviews = reviewRows(pr.reviews);
  const githubFilesUrl = `${pr.url}/files`;

  return (
    <Surface surface="pr" title="Pull Request" meta={`#${pr.number}`}>
      <article className="pr-detail" data-testid="pr-detail">
        <header className="pr-detail-head" data-testid="pr-detail-head">
          <div className="pr-detail-title-row">
            <Link href="/pr" className="pr-back" data-testid="pr-back" aria-label="Back to pull request list" title="Back to pull request list">
              <Icon name="arrowLeft" size={15} />
            </Link>
            <h1 data-testid="pr-title" data-ellipsis-ok title={pr.title}>{pr.title}</h1>
            <span className="pr-detail-number" data-testid="pr-number">#{pr.number}</span>
            <Badge tone="neutral" className="pr-state-badge" data-testid="pr-state-badge">
              {stateLabel(pr)}
            </Badge>
            <span className="pr-detail-spacer" />
            <a className="pr-github-link" data-testid="pr-github-link" href={pr.url} target="_blank" rel="noreferrer">
              <Icon name="github" size={14} />
              View on GitHub
              <Icon name="external" size={12} />
            </a>
          </div>
          <div className="pr-detail-meta" data-testid="pr-detail-meta">
            <span data-ellipsis-ok title={`${pr.headRefName ?? "unknown"} -> ${pr.baseRefName ?? "base"}`}>
              <Icon name="branch" size={13} />
              {pr.headRefName ?? "unknown"} -&gt; {pr.baseRefName ?? "base"}
            </span>
            <span data-ellipsis-ok title={pr.authorLogin ?? "unknown author"}>{pr.authorLogin ?? "unknown author"}</span>
            <span>{prTime(pr)}</span>
          </div>
        </header>

        <div className="pr-detail-body">
          <section className="pr-section pr-produced" data-testid="pr-produced-by">
            <div className="pr-section-head">
              <span>Produced by</span>
              <span className="pr-section-count">{bundle.linkedSessions.length}</span>
            </div>
            <div className="pr-produced-list">
              {bundle.linkedSessions.map((link) => (
                <Link
                  key={`${link.session.id}:${link.linkMethod}`}
                  href={`/?session=${encodeURIComponent(link.session.id)}`}
                  className="pr-session-row"
                  data-testid="pr-session-row"
                >
                  <RunnerIcon runner={link.session.runner} size={20} />
                  <span className="pr-session-title" data-ellipsis-ok title={link.session.title}>{link.session.title}</span>
                  <StrengthChip link={link} fallbackSha={pr.headSha} />
                  <span className="pr-session-metric">{fmtCost(link.session.costUsd)} · {fmtInt(link.session.turnCount)} turns</span>
                  <Icon name="chevronRight" size={14} />
                </Link>
              ))}
              {bundle.linkedSessions.length === 0 ? (
                <div className="empty" data-testid="empty">No sessions linked to this pull request.</div>
              ) : null}
            </div>
            <p className="pr-section-note">
              sha is a precise commit match; branch fallback is a weaker branch-name match.
            </p>
          </section>

          <section className="pr-section pr-changed" data-testid="pr-changed-files">
            <div className="pr-section-head">
              <span>Changed files</span>
              <span className="pr-section-count">{fmtInt(pr.changedFiles)}</span>
              <span className="pr-section-stat">+{fmtInt(pr.additions)} -{fmtInt(pr.deletions)}</span>
              <a className="pr-section-link" href={githubFilesUrl} target="_blank" rel="noreferrer">
                open full diff on GitHub
                <Icon name="external" size={12} />
              </a>
            </div>
            <DiffViewer
              bundle={{ changedFiles: bundle.changedFiles, hunks: bundle.hunks, linkedEvents: {} }}
              currentId={pr.id}
              showHead={false}
              showAxis={false}
              fileRowTestId="pr-file-row"
              emptyMessage="No imported file-level diff is available for this PR; use the GitHub full diff link."
            />
            <p className="pr-section-note">
              Inline file diffs come from linked sessions when Lathe has imported those session diffs.
            </p>
          </section>

          <section className="pr-section pr-reviews" data-testid="pr-reviews">
            <div className="pr-section-head">
              <span>Reviews</span>
              <span className="pr-section-count">{reviews.length}</span>
            </div>
            <div className="pr-review-list">
              {reviews.map((review, index) => (
                <div className="pr-review-row" data-testid="pr-review-row" key={`${review.state}:${review.author}:${index}`}>
                  <Icon name={review.state === "approved" ? "check" : "alert"} size={14} />
                  <span className="pr-review-state">{review.state}</span>
                  <span className="pr-review-body" data-ellipsis-ok title={review.body || "(no body)"}>
                    {review.body || "(no body)"}
                  </span>
                  <span className="pr-review-meta">
                    {review.author} · {review.submittedAt ? parseStamp(review.submittedAt).date : "unknown time"}
                  </span>
                </div>
              ))}
              {reviews.length === 0 ? <div className="empty" data-testid="empty">No reviews imported.</div> : null}
            </div>
          </section>
        </div>
      </article>
    </Surface>
  );
}
