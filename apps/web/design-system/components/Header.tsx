// design-system/components/Header.tsx — the app TopBar chrome (presentational).
// scope+identity ONLY: a brand mark + a project-scope slot. No search / command /
// app-feature actions live here. The scope control (TopBarProjectSelect) is
// routing-coupled, so the shell (container) builds it and passes it in via the
// `projectSelector` slot; the DS owns only the chrome. Storyable in isolation.

import * as React from "react";
import Link from "next/link";
import { Badge } from "./index";

export interface HeaderProps {
  /** the project-scope control (breadcrumb dropdown), supplied by the shell */
  projectSelector?: React.ReactNode;
  /** brand link target (default "/") */
  brandHref?: string;
}

export function Header({ projectSelector, brandHref = "/" }: HeaderProps) {
  return (
    <header className="lds-topbar" data-testid="topbar">
      <Link href={brandHref} className="lds-tb-brand" data-testid="topbar-brand" title="Lathe — session observability">
        <span className="lds-tb-logo" data-testid="topbar-logo" aria-hidden>
          L
        </span>
        <span>Lathe</span>
        <Badge tone="neutral" className="lds-tb-ph" data-testid="topbar-ph">
          Phase 1
        </Badge>
      </Link>
      {projectSelector}
    </header>
  );
}
