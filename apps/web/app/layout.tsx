import './globals.css';
import GlobalNav from '@/components/GlobalNav';

export const metadata = {
  title: 'Lathe',
  description: 'Harness engineering platform — Phase 1 transcript / Git-diff viewer',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <div className="app">
          {/* The ONE persistent global bar — on every route. Sessions / Findings
              / PR / Overview, current axis highlighted. */}
          <GlobalNav />
          {children}
        </div>
      </body>
    </html>
  );
}
