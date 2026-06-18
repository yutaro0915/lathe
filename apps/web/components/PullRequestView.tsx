"use client";

import Link from "next/link";
import { fmtInt, parseStamp } from "@lathe/shared";
import { RUNNER_LABEL } from "@/lib/runner-display";
import type { PullRequestBundle, PullRequestSummary } from "@/lib/types";

function stateLabel(pr: PullRequestSummary): string {
  if (pr.mergedAt || pr.state === "merged") return "merged";
  return pr.state;
}

function reviewRows(reviews: unknown[]): { state: string; author: string; submittedAt: string; body: string }[] {
  return reviews
    .map((review) => {
      if (!review || typeof review !== "object") return null;
      const r = review as Record<string, unknown>;
      const author = r.author && typeof r.author === "object" ? (r.author as Record<string, unknown>).login : null;
      return {
        state: typeof r.state === "string" ? r.state : "REVIEW",
        author: typeof author === "string" ? author : "unknown",
        submittedAt: typeof r.submittedAt === "string" ? r.submittedAt : "",
        body: typeof r.body === "string" ? r.body : "",
      };
    })
    .filter((row): row is { state: string; author: string; submittedAt: string; body: string } => !!row);
}

export default function PullRequestView({
  pullRequests,
  bundle,
}: {
  pullRequests: PullRequestSummary[];
  bundle?: PullRequestBundle;
}) {
  const selected = bundle?.pullRequest;
  const reviews = selected ? reviewRows(selected.reviews) : [];

  return (
    <div className="pr-shell" data-testid="pr-shell">
      <aside className="pr-sidebar" data-testid="pr-sidebar">
        <div className="pr-sidebar-head" data-testid="pr-sidebar-head">
          <div>
            <div className="panel-title" data-testid="panel-title" style={{ margin: 0 }}>Pull Requests</div>
            <div className="muted small" data-testid="muted">{pullRequests.length} imported</div>
          </div>
          <Link href="/" className="btn btn-sm" data-testid="btn">Sessions</Link>
        </div>
        <div className="pr-list" data-testid="pr-list">
          {pullRequests.map((pr) => (
            <Link
              key={pr.id}
              href={`/pr?pr=${encodeURIComponent(pr.id)}`}
              className={`pr-list-item${selected?.id === pr.id ? " active" : ""}`} data-testid="pr-list-item"
            >
              <div className="pr-list-top" data-testid="pr-list-top">
                <span className="pr-number" data-testid="pr-number">#{pr.number}</span>
                <span className={`pr-chip ${stateLabel(pr)}`} data-testid="pr-chip">{stateLabel(pr)}</span>
              </div>
              <div className="pr-list-title" data-testid="pr-list-title">{pr.title}</div>
              <div className="pr-list-meta" data-testid="pr-list-meta">
                <span>{pr.headRefName ?? "unknown branch"}</span>
                <span>·</span>
                <span>{parseStamp(pr.updatedAt).date}</span>
              </div>
            </Link>
          ))}
          {pullRequests.length === 0 && (
            <div className="empty" data-testid="empty" style={{ padding: 14 }}>
              No pull requests imported. Run verify:pr first.
            </div>
          )}
        </div>
      </aside>

      <main className="pr-main" data-testid="pr-main">
        {!selected ? (
          <div className="empty" data-testid="empty" style={{ padding: 18 }}>No pull request selected.</div>
        ) : (
          <>
            <section className="pr-hero" data-testid="pr-hero">
              <div className="pr-title-line" data-testid="pr-title-line">
                <span className="pr-number" data-testid="pr-number">#{selected.number}</span>
                <h1>{selected.title}</h1>
                <span className={`pr-chip ${stateLabel(selected)}`} data-testid="pr-chip">{stateLabel(selected)}</span>
              </div>
              <div className="pr-meta-row" data-testid="pr-meta-row">
                <span>{selected.authorLogin ?? "unknown author"}</span>
                <span>·</span>
                <span>{selected.headRefName ?? "unknown"} → {selected.baseRefName ?? "base"}</span>
                <span>·</span>
                <a href={selected.url} target="_blank" rel="noreferrer">GitHub</a>
              </div>
              <div className="pr-stat-row" data-testid="pr-stat-row">
                <span className="chip" data-testid="chip">+{fmtInt(selected.additions)}</span>
                <span className="chip" data-testid="chip">-{fmtInt(selected.deletions)}</span>
                <span className="chip" data-testid="chip">{fmtInt(selected.changedFiles)} files</span>
                <span className="chip" data-testid="chip">{fmtInt(selected.reviewCount)} reviews</span>
              </div>
            </section>

            <section className="pr-section" data-testid="pr-section">
              <div className="panel-title" data-testid="panel-title">Description</div>
              <div className="pr-body" data-testid="pr-body">{selected.body?.trim() || "(no description)"}</div>
            </section>

            <section className="pr-section" data-testid="pr-section">
              <div className="panel-title" data-testid="panel-title">
                Linked Sessions <span className="count" data-testid="count">{bundle.linkedSessions.length}</span>
              </div>
              <div className="linked-session-list" data-testid="linked-session-list">
                {bundle.linkedSessions.map(({ session, linkMethod }) => (
                  <Link key={`${session.id}:${linkMethod}`} href={`/?session=${encodeURIComponent(session.id)}`} className="linked-session" data-testid="linked-session">
                    <span className={`runner-dot ${session.runner}`} data-testid="runner-dot" />
                    <span className="linked-session-title" data-testid="linked-session-title">{session.title}</span>
                    <span className="muted" data-testid="muted">{RUNNER_LABEL[session.runner]}</span>
                    <span className="chip" data-testid="chip">{linkMethod}</span>
                    <span className="muted" data-testid="muted">{parseStamp(session.startedAt).date}</span>
                  </Link>
                ))}
                {bundle.linkedSessions.length === 0 && (
                  <div className="empty" data-testid="empty">No sessions linked yet.</div>
                )}
              </div>
            </section>

            <section className="pr-section" data-testid="pr-section">
              <div className="panel-title" data-testid="panel-title">
                Reviews <span className="count" data-testid="count">{reviews.length}</span>
              </div>
              <div className="review-list" data-testid="review-list">
                {reviews.map((review, index) => (
                  <div key={`${review.state}:${review.author}:${index}`} className="review-row" data-testid="review-row">
                    <span className="badge neutral" data-testid="badge">{review.state.toLowerCase()}</span>
                    <span className="review-author" data-testid="review-author">{review.author}</span>
                    <span className="muted" data-testid="muted">{review.submittedAt ? parseStamp(review.submittedAt).date : "—"}</span>
                    {review.body && <span className="review-body" data-testid="review-body">{review.body}</span>}
                  </div>
                ))}
                {reviews.length === 0 && <div className="empty" data-testid="empty">No reviews imported.</div>}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
