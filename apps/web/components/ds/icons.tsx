// components/ds/icons.tsx — thin-stroke line icons for the DS v1 shell.
// No icon font, no emoji. currentColor + tabular sizing (DS rule: no emoji,
// neutral micro-affordances). Ported from the bundle ui_kit Icon set.

import * as React from "react";

type IconName =
  | "list"
  | "findings"
  | "pr"
  | "chart"
  | "settings"
  | "grid"
  | "chevronDown"
  | "chevronRight";

const PATHS: Record<IconName, React.ReactNode> = {
  list: (
    <>
      <line x1="8" y1="6" x2="20" y2="6" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="8" y1="18" x2="20" y2="18" />
      <line x1="4" y1="6" x2="4" y2="6" />
      <line x1="4" y1="12" x2="4" y2="12" />
      <line x1="4" y1="18" x2="4" y2="18" />
    </>
  ),
  findings: (
    <>
      <path d="M12 3 2.6 19.5h18.8L12 3z" />
      <line x1="12" y1="10" x2="12" y2="14" />
      <line x1="12" y1="17" x2="12" y2="17" />
    </>
  ),
  pr: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <line x1="6" y1="8.2" x2="6" y2="15.8" />
      <circle cx="18" cy="18" r="2.2" />
      <path d="M18 15.8V12a4 4 0 0 0-4-4h-3.5" />
      <polyline points="13 5.5 10 8 13 10.5" />
    </>
  ),
  chart: (
    <>
      <line x1="4" y1="20" x2="20" y2="20" />
      <rect x="5" y="11" width="3" height="6.5" />
      <rect x="10.5" y="6" width="3" height="11.5" />
      <rect x="16" y="13.5" width="3" height="4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  chevronDown: <polyline points="6 9 12 15 18 9" />,
  chevronRight: <polyline points="9 6 15 12 9 18" />,
};

export function Icon({ name, size = 14, stroke = 1.9 }: { name: IconName; size?: number; stroke?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block", flex: "0 0 auto" }}
    >
      {PATHS[name]}
    </svg>
  );
}

export type { IconName };
