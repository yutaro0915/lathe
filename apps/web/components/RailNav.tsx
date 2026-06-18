"use client";

// components/RailNav.tsx — the ONE persistent global navigation, on every route.
//
// Lathe Design System v1 shell: navigation lives in a 264px LEFT RAIL (not a top
// bar). The four axes are Sessions / Findings / PR / Overview, current location
// always highlighted so "where am I / how do I get back" is always answerable
// (design.md IA: every screen lives under this one bar).
//
// Machine-readable / e2e contract (dual-operability): the rail container carries
// data-railnav and each axis item carries data-nav with the axis id and an
// `active` class, so agents and tests can target axes structurally.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "@/components/ds/icons";
import { Badge } from "@/components/ds";

const NAV: { href: string; label: string; nav: string; icon: IconName; match: (path: string) => boolean }[] = [
  // Sessions is the root "/"; deep links like /?session=…&tab=… are the SAME
  // screen in a different state, so the root match is exact-path only.
  { href: "/", label: "Sessions", nav: "sessions", icon: "list", match: (p) => p === "/" },
  { href: "/findings", label: "Findings", nav: "findings", icon: "findings", match: (p) => p.startsWith("/findings") },
  { href: "/pr", label: "PR", nav: "pr", icon: "pr", match: (p) => p.startsWith("/pr") },
  { href: "/overview", label: "Overview", nav: "overview", icon: "chart", match: (p) => p.startsWith("/overview") },
];

export default function RailNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="lds-railnav" data-testid="globalnav" data-railnav data-active-path={pathname} aria-label="Primary">
      <Link href="/" className="lds-rail-brand" data-testid="lds-rail-brand" title="Lathe — session observability">
        <span className="lds-rail-logo" data-testid="lds-rail-logo">L</span>
        <span>Lathe</span>
        <Badge tone="neutral" className="lds-rail-ph" data-testid="lds-rail-ph">Phase 1</Badge>
      </Link>
      <div className="lds-rail-nav" data-testid="lds-rail-nav">
        {NAV.map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`lds-rail-nav-item${active ? " active" : ""}`} data-testid="globalnav-tab"
              data-nav={item.nav}
              data-state={active ? "active" : "inactive"}
              aria-current={active ? "page" : undefined}
            >
              <span className="lds-rail-ic" data-testid="lds-rail-ic">
                <Icon name={item.icon} size={15} />
              </span>
              {item.label}
            </Link>
          );
        })}
      </div>
      <div className="lds-rail-scroll" data-testid="lds-rail-scroll" />
      <div className="lds-rail-user" data-testid="lds-rail-user">
        <span className="lds-avatar" data-testid="lds-avatar">YO</span>
        <span className="lds-uname" data-testid="lds-uname">Yutaro Ono</span>
        <span className="lds-gear" data-testid="lds-gear" aria-label="Settings">
          <Icon name="settings" size={15} />
        </span>
      </div>
    </nav>
  );
}
