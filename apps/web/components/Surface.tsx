"use client";

// components/Surface.tsx — the SINGLE home for work-area header chrome (Layout
// v2, design/layout-architecture.md).
//
// The shell (app/layout.tsx) owns the chrome regions: a full-width TopBar and a
// persistent left Rail. Inside the work area, this Surface component owns the
// WorkareaHeader band — the one place the new header styling exists. Every
// surface fills its slots ({title, meta?, actions?, tabs?, rightPanel?,
// children}) instead of drawing its own header band (the old per-surface bands
// .lds-page-head / .lds-session-bar / .pr-hero were the cause of the header
// step). Because the header height + body geometry are fixed here, a surface is
// structurally unable to reintroduce a header step.
//
//   • WorkareaHeader (fixed --appbar-h, full width, hairline bottom border):
//     title + meta on the LEFT, actions on the RIGHT.
//   • an optional tabs row directly under the header.
//   • the Body: the scroll region the surface fills (children). The body itself
//     is a non-scrolling flex column so a surface can place a fixed sub-row (e.g.
//     a filters panel) above its own scrolling list.
//   • a collapsible RightPanel (closed with ×) when `rightPanel` is supplied.

import * as React from "react";

export interface SurfaceProps {
  // WorkareaHeader title (left).
  title: React.ReactNode;
  // optional secondary text beside the title (left).
  meta?: React.ReactNode;
  // header actions (right). Surface-feature controls (search / sort / filters /
  // project picker etc.) live here, NOT in the shell TopBar.
  actions?: React.ReactNode;
  // optional tabs row, rendered directly under the header.
  tabs?: React.ReactNode;
  // optional collapsible right inspector panel. When supplied, the body splits
  // into a main column + this panel; the panel closes with the × control.
  rightPanel?: {
    title?: React.ReactNode;
    children: React.ReactNode;
    // start collapsed (default: open when rightPanel is supplied).
    defaultOpen?: boolean;
  };
  children: React.ReactNode;
  // marks the surface root for targeting / debugging.
  surface?: string;
}

export default function Surface({ title, meta, actions, tabs, rightPanel, children, surface }: SurfaceProps) {
  const [panelOpen, setPanelOpen] = React.useState(rightPanel?.defaultOpen ?? true);

  const body = rightPanel ? (
    <div className="lds-surface-split" data-testid="lds-surface-split">
      <div className="lds-surface-main" data-testid="lds-surface-main">{children}</div>
      {panelOpen ? (
        <aside className="lds-rightpanel" data-testid="lds-rightpanel">
          <div className="lds-rp-head" data-testid="lds-rp-head">
            <span className="lds-rp-title" data-testid="lds-rp-title">{rightPanel.title}</span>
            <button
              type="button"
              className="lds-rp-close"
              data-testid="lds-rp-close"
              aria-label="Close panel"
              title="Close panel"
              onClick={() => setPanelOpen(false)}
            >
              ×
            </button>
          </div>
          <div className="lds-rp-body" data-testid="lds-rp-body">{rightPanel.children}</div>
        </aside>
      ) : null}
    </div>
  ) : (
    children
  );

  return (
    <section className="lds-surface" data-testid="lds-surface" data-surface={surface}>
      <header className="lds-wh" data-testid="lds-wh">
        <span className="lds-wh-titles" data-testid="lds-wh-titles">
          <span className="lds-wh-title" data-testid="lds-wh-title">{title}</span>
          {meta != null ? <span className="lds-wh-meta" data-testid="lds-wh-meta">{meta}</span> : null}
        </span>
        <span className="lds-wh-spacer" data-testid="lds-wh-spacer" />
        {actions != null ? (
          <span className="lds-wh-actions" data-testid="lds-wh-actions">{actions}</span>
        ) : null}
      </header>
      {tabs != null ? <div className="lds-wh-tabs" data-testid="lds-wh-tabs">{tabs}</div> : null}
      <div className="lds-surface-body" data-testid="lds-surface-body">{body}</div>
    </section>
  );
}
