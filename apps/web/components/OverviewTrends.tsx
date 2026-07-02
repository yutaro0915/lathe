import Link from "next/link";
import { fmtCost, fmtInt } from "@lathe/shared";
import { RUNNER_LABEL } from "@/lib/runner-display";
import type { FindingKind, FindingKindCounts, Runner, Session } from "@/lib/types";

const FINDING_KIND_ORDER: FindingKind[] = [
  "failure_loop",
  "excess_cost",
  "unattributed_diff",
  "risky_action",
];

type TimeBar = {
  key: string;
  label: string;
  fromDay: string;
  toDay: string;
  cost: number;
  sessions: number;
  anomaly: boolean;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function dayOf(startedAt: string): string {
  return startedAt.slice(0, 10);
}

function parseDayLabel(day: string): string {
  const [, mo, da] = day.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(mo) - 1] ?? mo} ${Number(da)}`;
}

function buildTimeBars(sessions: Session[]): TimeBar[] {
  const priced = sessions
    .filter((s) => s.startedAt && s.costUsd != null)
    .sort((a, b) => dayOf(a.startedAt).localeCompare(dayOf(b.startedAt)));
  if (priced.length === 0) return [];

  const DAY_MS = 86_400_000;
  const BAR_TARGET = 14;
  const times = priced
    .map((s) => Date.parse(dayOf(s.startedAt)))
    .filter((t) => !Number.isNaN(t));
  const firstMs = times.length ? Math.min(...times) : Date.parse(dayOf(priced[0].startedAt));
  const lastMs = times.length ? Math.max(...times) : firstMs;
  const spanDays = Math.max(1, Math.round((lastMs - firstMs) / DAY_MS) + 1);
  const bucketDays = Math.max(1, Math.ceil(spanDays / BAR_TARGET));
  const step = bucketDays * DAY_MS;
  const buckets = new Map<number, TimeBar & { startMs: number }>();

  for (const session of priced) {
    const ms = Date.parse(dayOf(session.startedAt));
    const idx = Number.isNaN(ms) ? 0 : Math.floor((ms - firstMs) / step);
    let bucket = buckets.get(idx);
    if (!bucket) {
      const startMs = firstMs + idx * step;
      const fromDay = new Date(startMs).toISOString().slice(0, 10);
      const toDay = new Date(startMs + (bucketDays - 1) * DAY_MS).toISOString().slice(0, 10);
      bucket = {
        key: `b${idx}`,
        label: parseDayLabel(fromDay),
        fromDay,
        toDay,
        cost: 0,
        sessions: 0,
        anomaly: false,
        startMs,
      };
      buckets.set(idx, bucket);
    }
    bucket.cost += session.costUsd ?? 0;
    bucket.sessions += 1;
    bucket.anomaly ||= session.costAnomaly;
  }

  return [...buckets.values()]
    .sort((a, b) => a.startMs - b.startMs)
    .map(({ startMs: _startMs, ...bucket }) => bucket);
}

export default function OverviewTrends({
  scopeSessions,
  findingKindCounts,
  periodHref,
}: {
  scopeSessions: Session[];
  findingKindCounts: FindingKindCounts;
  periodHref: (fromDay: string, toDay: string) => string;
}) {
  const runners = new Map<Runner, { costs: number[]; sessions: number; known: number }>();
  for (const session of scopeSessions) {
    const row = runners.get(session.runner) ?? { costs: [], sessions: 0, known: 0 };
    row.sessions += 1;
    if (session.costUsd != null) {
      row.costs.push(session.costUsd);
      row.known += 1;
    }
    runners.set(session.runner, row);
  }
  const runnerRows = [...runners.entries()]
    .map(([runner, row]) => ({ runner, ...row, median: median(row.costs) }))
    .sort((a, b) => (b.median ?? -1) - (a.median ?? -1) || b.sessions - a.sessions);
  const maxRunnerMedian = Math.max(1e-6, ...runnerRows.map((row) => row.median ?? 0));

  const timeBars = buildTimeBars(scopeSessions);
  const maxTimeCost = Math.max(1e-6, ...timeBars.map((bar) => bar.cost));

  const kindRows = FINDING_KIND_ORDER.map((kind) => ({
    kind,
    count: findingKindCounts[kind] ?? 0,
  }));
  const maxKindCount = Math.max(1, ...kindRows.map((row) => row.count));

  return (
    <section className="overview-trends" data-testid="overview-trends">
      <div className="overview-section-h" data-testid="overview-section-h">Trends</div>
      <div className="overview-trends-grid" data-testid="overview-trends-grid">
        <section className="chart-card trend-card" data-testid="trend-card" data-trend="cost-by-runner">
          <div className="chart-h" data-testid="chart-h">
            Cost by runner <span className="muted small" data-testid="muted">(median)</span>
          </div>
          <div className="chart-body bars" data-testid="chart-body">
            {runnerRows.map((row) => {
              const width = row.median == null ? 0 : (row.median / maxRunnerMedian) * 100;
              return (
                <div className="hbar-row trend-row" data-testid="runner-cost-row" data-runner={row.runner} key={row.runner}>
                  <span className="hbar-label" data-testid="hbar-label" title={`${RUNNER_LABEL[row.runner]} · ${row.known} priced / ${row.sessions} sessions`}>
                    {RUNNER_LABEL[row.runner]}
                  </span>
                  <span className="hbar-track" data-testid="hbar-track">
                    <span
                      className={`hbar-fill trend-neutral-fill${width === 0 ? " is-zero" : ""}`}
                      data-testid="hbar-fill"
                      style={{ width: `${width}%` }}
                    />
                  </span>
                  <span className="hbar-val" data-testid="hbar-val">{row.median == null ? "-" : fmtCost(row.median)}</span>
                </div>
              );
            })}
            {runnerRows.length === 0 && <div className="empty" data-testid="empty">No sessions in scope.</div>}
          </div>
          <div className="trend-note" data-testid="trend-note">
            Median across priced sessions; unpriced sessions stay out of the calculation.
          </div>
        </section>

        <section className="chart-card trend-card" data-testid="trend-card" data-trend="cost-over-time">
          <div className="chart-h" data-testid="chart-h">Cost over time</div>
          {timeBars.length === 0 ? (
            <div className="empty" data-testid="empty">No priceable sessions in scope.</div>
          ) : (
            <>
              <div className="trend-time-bars" data-testid="trend-time-bars">
                {timeBars.map((bar) => {
                  const height = bar.cost === 0 ? 0 : Math.max(8, (bar.cost / maxTimeCost) * 100);
                  return (
                    <Link
                      key={bar.key}
                      href={periodHref(bar.fromDay, bar.toDay)}
                      className="trend-time-link"
                      data-testid="time-bar-link"
                      data-from={bar.fromDay}
                      data-to={bar.toDay}
                      title={`${bar.fromDay}${bar.toDay !== bar.fromDay ? ` to ${bar.toDay}` : ""} · ${fmtCost(bar.cost)} · ${fmtInt(bar.sessions)} sessions`}
                    >
                      <span
                        className="trend-time-bar"
                        data-problem-signal={bar.anomaly ? "cost-outlier" : "none"}
                        style={{
                          height: `${height}%`,
                          background: bar.anomaly ? "var(--c-error)" : "var(--muted-2)",
                        }}
                      />
                    </Link>
                  );
                })}
              </div>
              <div className="trend-note" data-testid="trend-note">
                Daily cost buckets across this scope.
              </div>
            </>
          )}
        </section>

        <section className="chart-card trend-card" data-testid="trend-card" data-trend="findings-by-kind">
          <div className="chart-h" data-testid="chart-h">Findings by kind</div>
          <div className="chart-body bars" data-testid="chart-body">
            {kindRows.map((row) => (
              <div className="hbar-row trend-row" data-testid="finding-kind-row" data-kind={row.kind} key={row.kind}>
                <span className="hbar-label mono" data-testid="hbar-label" title={row.kind}>{row.kind}</span>
                <span className="hbar-track" data-testid="hbar-track">
                  <span
                    className={`hbar-fill trend-neutral-fill${row.count === 0 ? " is-zero" : ""}`}
                    data-testid="hbar-fill"
                    style={{ width: `${(row.count / maxKindCount) * 100}%` }}
                  />
                </span>
                <span className="hbar-val" data-testid="hbar-val">{fmtInt(row.count)}</span>
              </div>
            ))}
          </div>
          <div className="trend-note" data-testid="trend-note">
            Distribution across findings attached to this session scope.
          </div>
        </section>
      </div>
    </section>
  );
}
