import './globals.css';
import '../design-system/index.css';
import RailNav from '@/components/RailNav';
import TopBarProjectSelect from '@/components/TopBarProjectSelect';
import { AppShell, Header } from '@/design-system/components';
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
        {/* AppShell owns only chrome regions; layout builds the routed slot contents. */}
        <AppShell
          topNav={(
            <Header
              projectSelector={(
                <TopBarProjectSelect
                  projects={projects}
                  totalSessions={sessions.length}
                  sessionTitles={sessionTitles}
                />
              )}
            />
          )}
          sideNav={<RailNav />}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
