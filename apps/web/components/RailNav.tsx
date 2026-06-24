"use client";

// components/RailNav.tsx — container for the left nav. Computes the active axis
// from the current route and hands presentational SideNav the resolved items.

import { usePathname } from "next/navigation";
import { SideNav, type SideNavItem } from "@/design-system/components";
import { type IconName } from "@/design-system/components/icons";

const NAV: { href: string; label: string; nav: string; icon: IconName; match: (path: string) => boolean }[] = [
  // Sessions is the root "/"; deep links like /?session=…&tab=… are the SAME
  // screen in a different state, so the root match is exact-path only.
  { href: "/", label: "Sessions", nav: "sessions", icon: "list", match: (p) => p === "/" },
  { href: "/findings", label: "Findings", nav: "findings", icon: "findings", match: (p) => p.startsWith("/findings") },
  { href: "/chat", label: "Chat", nav: "chat", icon: "messages", match: (p) => p.startsWith("/chat") },
  { href: "/pr", label: "PR", nav: "pr", icon: "pr", match: (p) => p.startsWith("/pr") },
  { href: "/overview", label: "Overview", nav: "overview", icon: "chart", match: (p) => p.startsWith("/overview") },
];

export default function RailNav() {
  const pathname = usePathname() ?? "/";
  const items: SideNavItem[] = NAV.map((n) => ({
    href: n.href,
    label: n.label,
    icon: n.icon,
    nav: n.nav,
    active: n.match(pathname),
  }));
  return <SideNav items={items} user={{ name: "Yutaro Ono", initials: "YO" }} activePath={pathname} />;
}
