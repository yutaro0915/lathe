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
//   • a collapsible RightPanel (toggled by ONE edge slider) when `rightPanel`
//     is supplied. Collapse and expand are the SAME affordance — a slim vertical
//     edge-tab pinned to the right (VS Code / Langfuse side-panel style). It
//     flips its chevron + aria-label by state instead of using two asymmetric
//     controls (the old header × to close + a separate edge rail to reopen).

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
  // into a main column + this panel; a single right-edge slider toggle collapses
  // and expands it (the same control in both directions).
  rightPanel?: {
    title?: React.ReactNode;
    children: React.ReactNode;
    // start collapsed (default: open when rightPanel is supplied).
    defaultOpen?: boolean;
  };
  children: React.ReactNode;
  // marks the surface root for targeting / debugging.
  surface?: string;
  // optional testid for the WorkareaHeader band itself, so a surface whose e2e
  // contract targets the whole header (e.g. SessionViewer's `sessbar`) can hang
  // it on the one band rather than re-drawing its own.
  headerTestId?: string;
}

export default function Surface({ title, meta, actions, tabs, rightPanel, children, surface, headerTestId }: SurfaceProps) {
  const [panelOpen, setPanelOpen] = React.useState(rightPanel?.defaultOpen ?? true);

  const panelTitle = rightPanel?.title ?? "Inspector";
  const body = rightPanel ? (
    <div className="lds-surface-split" data-testid="lds-surface-split" data-rp-open={panelOpen}>
      <div className="lds-surface-main" data-testid="lds-surface-main">{children}</div>
      {panelOpen ? (
        <aside className="lds-rightpanel" data-testid="lds-rightpanel">
          <div className="lds-rp-head" data-testid="lds-rp-head">
            <span className="lds-rp-title" data-testid="lds-rp-title">{rightPanel.title}</span>
          </div>
          <div className="lds-rp-body" data-testid="lds-rp-body">{rightPanel.children}</div>
        </aside>
      ) : null}
      {/* The ONE collapse/expand affordance. A slim right-edge vertical tab,
          always in the same place (pinned to the right edge of the split), in
          BOTH states — like the VS Code / Langfuse side-panel collapse. It does
          not use two asymmetric controls (the old header × + a separate reopen
          rail); it flips chevron direction + aria-label by `panelOpen`:
            • OPEN  → "›" (collapse, pointing toward the edge), label hidden.
            • CLOSED→ "‹" (expand) + the panel's "Inspector" label.
          One stable testid (lds-rp-toggle) + aria-expanded + data-rp-open so a
          test/CSS can read the state. */}
      <button
        type="button"
        className="lds-rp-toggle"
        data-testid="lds-rp-toggle"
        data-rp-open={panelOpen}
        aria-expanded={panelOpen}
        aria-label={panelOpen ? "Collapse panel" : "Expand panel"}
        title={panelOpen ? "Collapse panel" : "Expand panel"}
        onClick={() => setPanelOpen((open) => !open)}
      >
        <span className="lds-rp-toggle-chevron" aria-hidden="true">{panelOpen ? "›" : "‹"}</span>
        {panelOpen ? null : <span className="lds-rp-toggle-label">{panelTitle}</span>}
      </button>
    </div>
  ) : (
    children
  );

  return (
    <section className="lds-surface" data-testid="lds-surface" data-surface={surface}>
      <header className="lds-wh" data-testid={headerTestId ?? "lds-wh"}>
        <span className="lds-wh-titles" data-testid="lds-wh-titles" data-wah-cell="titles">
          <span className="lds-wh-title" data-testid="lds-wh-title">{title}</span>
          {/* meta is secondary header text designed to ellipsize (it has
              text-overflow:ellipsis and yields width to the title + actions);
              data-ellipsis-ok marks that truncation as intended so the gate
              flags only an UNINTENDED cut of the primary title. */}
          {meta != null ? <span className="lds-wh-meta" data-testid="lds-wh-meta" data-ellipsis-ok>{meta}</span> : null}
        </span>
        <span className="lds-wh-spacer" data-testid="lds-wh-spacer" />
        {actions != null ? (
          <span className="lds-wh-actions" data-testid="lds-wh-actions" data-wah-cell="actions">{actions}</span>
        ) : null}
      </header>
      {tabs != null ? <div className="lds-wh-tabs" data-testid="lds-wh-tabs">{tabs}</div> : null}
      <div className="lds-surface-body" data-testid="lds-surface-body">{body}</div>
    </section>
  );
}
