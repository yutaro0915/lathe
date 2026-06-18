import './globals.css';
import './design-system/index.css';
import RailNav from '@/components/RailNav';

export const metadata = {
  title: 'Lathe',
  description: 'Harness engineering platform — Phase 1 transcript / Git-diff viewer',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        {/* Lathe Design System v1 shell: a single horizontal split — the ONE
            persistent left nav RAIL (Sessions / Findings / PR / Overview, current
            axis highlighted) + a WORK AREA. No top bar; depth is hairline borders,
            no shadow. (design.md IA: every screen lives under this one bar.) */}
        <div className="lds-app" data-testid="lds-app">
          <RailNav />
          <div className="lds-workarea" data-testid="lds-workarea">{children}</div>
        </div>
      </body>
    </html>
  );
}
