import * as React from "react";

// design-system/components/AppShell.tsx — the app shell layout (presentational).
// Atlassian navigation-system slot naming: a full-width TopNav over a body split
// of SideNav + Main. It owns the shell grid regions only; the shell's container
// (app/layout.tsx) builds the slot contents (Header / RailNav) and the page fills
// Main. No data/routing here — storyable in isolation.
export interface AppShellProps {
  /** full-width top bar (the Header) */
  topNav: React.ReactNode;
  /** persistent left navigation (the SideNav, via its RailNav container) */
  sideNav: React.ReactNode;
  /** the work area content (Main) */
  children: React.ReactNode;
}

export function AppShell({ topNav, sideNav, children }: AppShellProps) {
  return (
    <div className="lds-shell" data-testid="lds-app">
      {topNav}
      <div className="lds-shell-body" data-testid="lds-shell-body">
        {sideNav}
        <div className="lds-workarea" data-testid="lds-workarea">{children}</div>
      </div>
    </div>
  );
}
