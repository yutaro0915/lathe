"use client";

// components/GlobalNav.tsx — the ONE persistent global bar, on every route.
//
// IA principle (design/ui-design-language.md, 2026-06-12): every screen lives
// under this bar; there is no screen reachable only by some other means, and the
// current location is always highlighted so "where am I / how do I get back" is
// always answerable. The four axes are Sessions / Findings / PR / Overview.

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV: { href: string; label: string; match: (path: string) => boolean }[] = [
  // Sessions is the root "/"; deep links like /?session=…&tab=… are the SAME
  // screen in a different state, so the root match is exact-path only.
  { href: "/", label: "Sessions", match: (p) => p === "/" },
  { href: "/findings", label: "Findings", match: (p) => p.startsWith("/findings") },
  { href: "/pr", label: "PR", match: (p) => p.startsWith("/pr") },
  { href: "/overview", label: "Overview", match: (p) => p.startsWith("/overview") },
];

export default function GlobalNav() {
  const pathname = usePathname() ?? "/";
  return (
    <header className="globalnav" data-testid="globalnav" data-active-path={pathname}>
      <Link href="/" className="brand globalnav-brand" data-testid="brand" title="Lathe — session observability">
        <span className="logo" data-testid="logo">L</span>
        <span>Lathe</span>
      </Link>
      <nav className="globalnav-tabs" data-testid="globalnav-tabs" aria-label="Primary">
        {NAV.map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`globalnav-tab${active ? " active" : ""}`} data-testid="globalnav-tab"
              data-nav={item.label.toLowerCase()}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="globalnav-actions" data-testid="globalnav-actions">
        <span className="badge pro" data-testid="badge">Phase 1</span>
      </div>
    </header>
  );
}
