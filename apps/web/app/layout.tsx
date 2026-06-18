import './globals.css';
import './design-system/index.css';
import Link from 'next/link';
import RailNav from '@/components/RailNav';
import TopBarProjectSelect from '@/components/TopBarProjectSelect';
import { Badge } from '@/components/ds';
import { getProjectStats, listSessions } from '@/lib/read';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Lathe',
  description: 'Harness engineering platform — Phase 1 transcript / Git-diff viewer',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The TopBar project selector is the single project-scope control, so the
  // shell owns the project list (the same one the surfaces' pickers used).
  const [sessions, projectStats] = await Promise.all([listSessions(), getProjectStats()]);
  const projects = projectStats.map((p) => ({
    project: p.project,
    sessions: p.sessions,
    cost: p.cost,
    costKnown: p.costKnown,
  }));
  // The TopBar breadcrumb appends the CURRENT session (when on /?session=<id>) as
  // a read-only segment, so the user can tell which session they are viewing from
  // the top. It needs the id->title map of the sessions the shell already loaded
  // (no extra query); the selector resolves ?session= against it client-side.
  const sessionTitles = sessions.map((s) => ({ id: s.id, title: s.title }));

  return (
    <html lang="ja">
      <body>
        {/* Layout v2 AppShell (design/layout-architecture.md): the shell OWNS the
            chrome regions. A full-width TOP BAR (brand + a borderless breadcrumb
            project-scope selector — scope and identity ONLY, no search/command,
            no app-feature actions) sits above a horizontal BODY split: the ONE
            persistent left nav RAIL (Sessions / Findings / PR / Overview, current
            axis highlighted) + a WORK AREA. The work area's header chrome is owned
            by the single Surface component, so no surface draws its own header
            band (the cause of the old header step). Depth is hairline borders. */}
        <div className="lds-shell" data-testid="lds-app">
          {/* TopBar — shell-owned scope + identity ONLY. Brand mark + a borderless
              breadcrumb project selector (`Lathe / <project> v`); the selector
              writes the scope to ?project= and every section reads it. No search,
              no command affordance, no boxed control. */}
          <header className="lds-topbar" data-testid="topbar">
            <Link href="/" className="lds-tb-brand" data-testid="topbar-brand" title="Lathe — session observability">
              <span className="lds-tb-logo" data-testid="topbar-logo" aria-hidden>L</span>
              <span>Lathe</span>
              <Badge tone="neutral" className="lds-tb-ph" data-testid="topbar-ph">Phase 1</Badge>
            </Link>
            <TopBarProjectSelect
              projects={projects}
              totalSessions={sessions.length}
              sessionTitles={sessionTitles}
            />
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
