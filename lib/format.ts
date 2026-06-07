/**
 * Format an integer with US digit grouping.
 */
export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Compact large counts for stat chips, preserving raw small numbers.
 */
export function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Compact token counts with one decimal K suffix.
 */
export function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/**
 * Format USD cost; null/unknown stays explicit.
 */
export function fmtCost(c: number | null): string {
  if (c == null || !Number.isFinite(c)) return "—";
  if (c < 0) return "—";
  if (c > 0 && c < 0.01) return "<$0.01";
  return `$${c.toFixed(2)}`;
}

/**
 * Format milliseconds for chart durations, keeping sub-minute precision.
 */
export function fmtDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Format tool latency, using seconds for short waits.
 */
export function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return fmtDuration(ms);
}

/**
 * Human readable elapsed time for sidebars and headers.
 */
export function humanizeDuration(ms: number | null): string {
  if (ms == null) return "—";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Shorten model labels for compact UI chips.
 */
export function shortModel(m: string | null | undefined, fallback = "—"): string {
  if (!m) return fallback;
  return m.replace(/^claude-/, "");
}

/**
 * Return the final path segment.
 */
export function basename(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash === -1 ? p : p.slice(slash + 1);
}

/**
 * Split a SQLite timestamp into compact date and time labels.
 */
export function parseStamp(s: string): { date: string; time: string } {
  const [datePart, timePart = ""] = s.split(" ");
  const [, mo, da] = datePart.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const moName = months[Number(mo) - 1] ?? mo;
  const date = `${moName} ${Number(da)}`;
  const time = timePart.slice(0, 5);
  return { date, time };
}

/**
 * Format a duration already measured in seconds.
 */
export function fmtDurationSec(sec: number): string {
  if (sec <= 0) return "0s";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
