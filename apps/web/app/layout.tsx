import './globals.css';
import './design-system/index.css';
import Link from 'next/link';
import RailNav from '@/components/RailNav';

export const metadata = {
  title: 'Lathe',
  description: 'Harness engineering platform — Phase 1 transcript / Git-diff viewer',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {/* Layout v2 AppShell (design/layout-architecture.md): the shell OWNS the
            chrome regions. A full-width TOP BAR (brand + project-scope indicator +
            command affordance — scope and identity ONLY, no app-feature actions)
            sits above a horizontal BODY split: the ONE persistent left nav RAIL
            (Sessions / Findings / PR / Overview, current axis highlighted) + a
            WORK AREA. The work area's header chrome is owned by the single Surface
            component, so no surface draws its own header band (the cause of the
            old header step). Depth is hairline borders, no shadow. */}
        <div className="lds-shell" data-testid="lds-app">
          {/* TopBar — shell-owned scope + identity. STEP 1: the project-scope
              region is a STATIC, non-interactive "All projects" placeholder; the
              interactive switcher + ?project= data flow is a later step. */}
          <header className="lds-topbar" data-testid="topbar">
            <Link href="/" className="lds-tb-brand" data-testid="topbar-brand" title="Lathe — session observability">
              <span className="lds-tb-logo" data-testid="topbar-logo" aria-hidden>L</span>
              <span>Lathe</span>
            </Link>
            <span
              className="lds-tb-scope"
              data-testid="topbar-scope"
              data-scope="all"
              aria-disabled="true"
              title="Project scope — switcher arrives in a later step"
            >
              <span className="lds-tb-scope-ic" aria-hidden>
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
              </span>
              All projects
            </span>
            <span className="lds-tb-spacer" />
            <span className="lds-tb-cmd" data-testid="topbar-command" aria-label="Command menu" title="Command menu">
              Search
              <span className="lds-kbd" data-testid="topbar-kbd">⌘K</span>
            </span>
          </header>
          <div className="lds-shell-body" data-testid="lds-shell-body">
            <RailNav />
            <div className="lds-workarea" data-testid="lds-workarea">{children}</div>
          </div>
        </div>
      </body>
    </html>
  );
}
