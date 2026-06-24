// design-system/components/icons.tsx — thin-stroke line icons for the DS v1 shell.
// No icon font, no emoji. currentColor + tabular sizing (DS rule: no emoji,
// neutral micro-affordances). Ported from the bundle ui_kit Icon set.

import * as React from "react";

type IconName =
  | "list"
  | "findings"
  | "pr"
  | "chart"
  | "messages"
  | "settings"
  | "grid"
  | "stack"
  | "folder"
  | "arrowLeft"
  | "external"
  | "github"
  | "branch"
  | "link"
  | "plus"
  | "x"
  | "send"
  | "check"
  | "alert"
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
  messages: (
    <>
      <path d="M4 5.5C4 4.7 4.7 4 5.5 4h13c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5H9l-5 4v-13.5z" />
      <line x1="8" y1="8" x2="16" y2="8" />
      <line x1="8" y1="11" x2="14" y2="11" />
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
  stack: (
    <>
      <polygon points="12 3 21 8 12 13 3 8 12 3" />
      <polyline points="3 13 12 18 21 13" />
    </>
  ),
  folder: (
    <path d="M3 6.5C3 5.7 3.7 5 4.5 5H9l2 2h8.5c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5h-15C3.7 18 3 17.3 3 16.5v-10z" />
  ),
  arrowLeft: (
    <>
      <line x1="20" y1="12" x2="5" y2="12" />
      <polyline points="11 6 5 12 11 18" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M19 14v4.5c0 .8-.7 1.5-1.5 1.5h-12C4.7 20 4 19.3 4 18.5v-12C4 5.7 4.7 5 5.5 5H10" />
    </>
  ),
  github: (
    <>
      <path d="M12 2.8a9.2 9.2 0 0 0-2.9 17.9c.5.1.6-.2.6-.5v-1.7c-2.6.6-3.1-1-3.1-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.4.7.1-.5.3-.9.5-1.1-2.1-.2-4.2-1-4.2-4.6 0-1 .4-1.8 1-2.5-.1-.2-.4-1.2.1-2.5 0 0 .8-.2 2.6 1a8.9 8.9 0 0 1 4.8 0c1.8-1.2 2.6-1 2.6-1 .5 1.3.2 2.3.1 2.5.6.7 1 1.5 1 2.5 0 3.6-2.1 4.4-4.2 4.6.3.3.6.8.6 1.6v2.4c0 .3.2.6.7.5A9.2 9.2 0 0 0 12 2.8z" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="12" r="2" />
      <path d="M6 7v10" />
      <path d="M8 5h4a6 6 0 0 1 6 5" />
    </>
  ),
  link: (
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M8.5 10.5 7.2 11.8a3.5 3.5 0 0 0 5 5l1.3-1.3" />
      <path d="M15.5 13.5 16.8 12.2a3.5 3.5 0 0 0-5-5l-1.3 1.3" />
    </>
  ),
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  x: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  send: (
    <>
      <path d="M21 3 10 14" />
      <path d="M21 3 14 21 10 14 3 10 21 3z" />
    </>
  ),
  check: <polyline points="5 12.5 10 17.5 19 6.5" />,
  alert: (
    <>
      <path d="M12 3 21 19H3L12 3z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="16" x2="12" y2="16" />
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
