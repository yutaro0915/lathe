import './globals.css';
import Link from 'next/link';

export const metadata = {
  title: 'Lathe',
  description: 'Harness engineering platform — Phase 1 transcript / Git-diff viewer',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <div className="app">
          <header className="appbar">
            <div className="brand">
              <span className="logo">L</span>
              <span>Lathe</span>
            </div>
            <div className="crumb">
              <span>LLMWiki / lathe</span>
              <span className="sep">/</span>
              <span className="cur">Phase 1 viewer</span>
            </div>
            <nav className="appnav">
              <Link href="/">セッション</Link>
              <Link href="/diff">Git差分・帰属</Link>
            </nav>
            <div className="appbar-actions">
              <span className="badge pro">Phase 1</span>
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
