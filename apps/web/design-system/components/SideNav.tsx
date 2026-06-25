"use client";

// design-system/components/SideNav.tsx — the persistent left navigation rail,
// presentational. It renders nav items + the user footer from props only (no
// routing); the active item and the current path are computed by a container
// (components/RailNav) and passed in. This lets the rail be observed in isolation
// (Storybook) and keeps the route logic out of the DS.

import * as React from "react";
import Link from "next/link";
import { Icon, type IconName } from "@/design-system/components/icons";

export interface SideNavItem {
  href: string;
  label: string;
  icon: IconName;
  /** value for data-nav (e2e axis id) */
  nav: string;
  active: boolean;
}
export interface SideNavUser {
  name: string;
  initials: string;
}
export interface SideNavProps {
  items: SideNavItem[];
  user: SideNavUser;
  /** current path, surfaced as data-active-path for tests/CSS */
  activePath?: string;
}

export function SideNav({ items, user, activePath }: SideNavProps) {
  return (
    <nav className="lds-railnav" data-testid="globalnav" data-railnav data-active-path={activePath} aria-label="Primary">
      <div className="lds-rail-nav" data-testid="lds-rail-nav">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`lds-rail-nav-item${item.active ? " active" : ""}`}
            data-testid="globalnav-tab"
            data-nav={item.nav}
            data-state={item.active ? "active" : "inactive"}
            aria-current={item.active ? "page" : undefined}
            title={item.label}
          >
            <span className="lds-rail-ic" data-testid="lds-rail-ic">
              <Icon name={item.icon} size={15} />
            </span>
            <span className="lds-rail-label">{item.label}</span>
          </Link>
        ))}
      </div>
      <div className="lds-rail-scroll" data-testid="lds-rail-scroll" />
      <div className="lds-rail-user" data-testid="lds-rail-user">
        <span className="lds-avatar" data-testid="lds-avatar" title={user.name}>{user.initials}</span>
        <span className="lds-uname" data-testid="lds-uname">{user.name}</span>
        <span className="lds-gear" data-testid="lds-gear" aria-label="Settings" role="img">
          <Icon name="settings" size={15} />
        </span>
      </div>
    </nav>
  );
}
