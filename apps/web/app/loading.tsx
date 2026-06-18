// app/loading.tsx — Screen A loading skeleton (issue #8).
//
// The session viewer is a force-dynamic route: a cross-session navigation has to
// re-render the whole page on the server (events + per-session aggregates), which
// is the ~2s the user feels. This Suspense fallback renders INSTANTLY on click so
// the navigation registers immediately — the dense band/column structure is laid
// out with neutral placeholder bars, then swapped for the real content when the
// server render lands. Design discipline (ui-design-language.md): neutral bars on
// the app surface, hairline separators, a mono micro-label, no colour flood.

export default function LoadingSessionViewer() {
  const bar = (w: string, h = 10) => (
    <span className="sk-bar" style={{ width: w, height: h }} aria-hidden />
  );
  return (
    <div className="sk" aria-busy="true" aria-label="Loading session">
      <style>{`
        .sk{--sk:var(--border-faint,#edeff3)}
        .sk-bar,.sk-block{background:var(--sk);border-radius:3px;display:inline-block;
          position:relative;overflow:hidden}
        .sk-bar::after,.sk-block::after{content:"";position:absolute;inset:0;
          background:linear-gradient(90deg,transparent,rgba(127,127,127,.10),transparent);
          transform:translateX(-100%);animation:sk-shimmer 1.25s ease-in-out infinite}
        @keyframes sk-shimmer{100%{transform:translateX(100%)}}
        @media (prefers-reduced-motion:reduce){.sk-bar::after,.sk-block::after{animation:none}}
        .sk-sessbar{display:flex;align-items:center;justify-content:space-between;gap:16px;
          padding:10px 16px;border-bottom:1px solid var(--border,#e4e7ec)}
        .sk-id{display:flex;align-items:center;gap:10px;min-width:0}
        .sk-dot{width:8px;height:8px;border-radius:50%;background:var(--sk);flex:none}
        .sk-kstats{display:flex;gap:18px}
        .sk-kstat{display:flex;flex-direction:column;gap:5px;align-items:flex-end}
        .sk-tabs{display:flex;gap:10px;padding:8px 16px;border-bottom:1px solid var(--border,#e4e7ec)}
        .sk-layout{display:grid;
          grid-template-columns:var(--sidebar-w,264px) minmax(0,1fr) var(--aside-w,336px);
          height:calc(100vh - 220px)}
        .sk-col{padding:12px;overflow:hidden}
        .sk-col.left{border-right:1px solid var(--border,#e4e7ec)}
        .sk-col.right{border-left:1px solid var(--border,#e4e7ec)}
        .sk-item{padding:10px 0;border-bottom:1px solid var(--border-faint,#edeff3);
          display:flex;flex-direction:column;gap:6px}
        .sk-row{padding:9px 0;border-bottom:1px solid var(--border-faint,#edeff3);
          display:flex;align-items:center;gap:10px}
        .sk-label{font:600 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
          letter-spacing:.06em;text-transform:uppercase;color:var(--muted-2,#98a1ae);
          padding:2px 0 10px}
        @media (max-width:1100px){.sk-layout{grid-template-columns:var(--sidebar-w,264px) minmax(0,1fr)}
          .sk-col.right{display:none}}
      `}</style>

      {/* Band 2 — metrics (sessbar) */}
      <div className="sk-sessbar">
        <div className="sk-id">
          <span className="sk-dot" />
          {bar("220px", 12)}
          {bar("160px")}
        </div>
        <div className="sk-kstats">
          {Array.from({ length: 6 }).map((_, i) => (
            <span className="sk-kstat" key={i}>
              {bar("34px", 13)}
              {bar("28px", 8)}
            </span>
          ))}
        </div>
      </div>

      {/* Band 3 — tabs */}
      <div className="sk-tabs">
        {Array.from({ length: 9 }).map((_, i) => (
          <span key={i}>{bar(`${52 + (i % 3) * 12}px`)}</span>
        ))}
      </div>

      {/* Band 4 — 3-column layout */}
      <div className="sk-layout">
        <div className="sk-col left">
          <div className="sk-label">sessions</div>
          {Array.from({ length: 9 }).map((_, i) => (
            <div className="sk-item" key={i}>
              {bar("85%", 11)}
              {bar("55%", 9)}
              {bar("70%", 9)}
            </div>
          ))}
        </div>
        <div className="sk-col">
          <div className="sk-label">loading session</div>
          {Array.from({ length: 12 }).map((_, i) => (
            <div className="sk-row" key={i}>
              <span className="sk-dot" />
              {bar(`${40 + ((i * 37) % 50)}%`, 11)}
            </div>
          ))}
        </div>
        <div className="sk-col right">
          <div className="sk-label">inspector</div>
          {bar("70%", 12)}
          <div style={{ height: 10 }} />
          {Array.from({ length: 6 }).map((_, i) => (
            <div className="sk-row" key={i}>{bar(`${50 + ((i * 23) % 40)}%`, 10)}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
