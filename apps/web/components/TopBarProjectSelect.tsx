"use client";

// components/TopBarProjectSelect.tsx — the real project-SCOPE control, in the
// shell TopBar (Layout v2, design/layout-architecture.md).
//
// Per the updated TopBar spec, the project control is a BORDERLESS breadcrumb
// segment (like Langfuse's `/ Yutaro Ono v`): a `/` separator, the current
// project name, and a chevron — plain text + chevron, no box/border/outline.
// It is NOT a bordered control and carries no app-feature actions; the TopBar
// holds scope + identity only (topbar-scope-only).
//
// It is the single project-scope control for the whole app: selecting a project
// writes the scope to the `?project=<id|all>` URL query param (default `all`).
// Every section that scopes by project reads that param (Sessions surface /
// Overview today).
//
// The trigger is a CUSTOM lathe dropdown (a button toggling a styled menu),
// NOT a native <select> — the native control showed the Mac-default popup which
// looked out of place in the DS. The trigger keeps the stable `project-picker`
// testid and an `all` default; each option carries `project-option` +
// `data-project` so e2e can drive it by label. Keyboard accessible: Enter/Space/
// ArrowDown open, Escape closes, arrows move, Enter selects.
//
// Breadcrumb shape: `Lathe / <project>` always; when viewing a session
// (`/?session=<id>`) a second read-only segment appends the session title
// (or a short id) → `Lathe / <project> / <session title>`, so the user can tell
// which session they are in from the top.

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/design-system/components/icons";

export interface TopBarProject {
  project: string;
  sessions: number;
  cost: number;
  costKnown: boolean;
}

export interface TopBarSessionTitle {
  id: string;
  title: string;
}

export default function TopBarProjectSelect({
  projects,
  totalSessions,
  sessionTitles = [],
}: {
  projects: TopBarProject[];
  totalSessions: number;
  sessionTitles?: TopBarSessionTitle[];
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const current = searchParams.get("project") ?? "all";

  // the label shown in the breadcrumb segment (mirrors the active option).
  const label =
    current === "all"
      ? "All projects"
      : projects.find((p) => p.project === current)?.project ?? current;

  // ---- current session breadcrumb segment (Fix B) --------------------------
  // When the URL targets a single session, append it as a read-only segment.
  // Resolve the title from the shell-loaded id->title list; fall back to a short
  // id when the title is unknown (e.g. a not-yet-loaded session).
  const sessionId = searchParams.get("session");
  const sessionLabel = sessionId
    ? sessionTitles.find((s) => s.id === sessionId)?.title ?? shortId(sessionId)
    : null;

  const onChange = (value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value === "all") next.delete("project");
    else next.set("project", value);
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // ---- custom dropdown state (Fix C) ---------------------------------------
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const menuId = useId();

  // option list: the synthetic "all" row first, then one row per project. Each
  // carries the value written to ?project= and the visible label.
  const options = [
    { value: "all", label: `All projects · ${totalSessions} sessions`, name: "All projects" },
    ...projects.map((p) => ({
      value: p.project,
      label: `${p.project} · ${p.sessions} ses · ${p.costKnown ? `$${p.cost.toFixed(0)}` : "—"}`,
      name: p.project,
    })),
  ];
  const currentIndex = Math.max(
    0,
    options.findIndex((o) => o.value === current),
  );

  // close on outside click / on route param change.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);
  useEffect(() => {
    setOpen(false);
  }, [current]);

  const openMenu = () => {
    setActiveIndex(currentIndex);
    setOpen(true);
  };
  const choose = (value: string) => {
    setOpen(false);
    if (value !== current) onChange(value);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(options[activeIndex].value);
    }
  };

  return (
    <span className="lds-tb-scope" data-testid="topbar-scope" data-scope={current} ref={rootRef}>
      <span className="lds-tb-scope-sep" aria-hidden>
        /
      </span>
      {/* project segment: a custom dropdown trigger (button) + styled menu. */}
      <button
        type="button"
        className="lds-tb-scope-trigger"
        data-testid="project-picker"
        data-value={current}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Scope every section to one project"
        aria-label="Project scope"
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="lds-tb-scope-name" data-testid="topbar-scope-name">
          {label}
        </span>
        <span className="lds-tb-scope-ic" aria-hidden>
          <Icon name="chevronDown" size={13} />
        </span>
      </button>
      {open ? (
        <ul
          className="lds-tb-scope-menu"
          data-testid="project-menu"
          id={menuId}
          role="listbox"
          aria-label="Project scope"
        >
          {options.map((o, i) => (
            <li key={o.value} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={o.value === current}
                className={
                  "lds-tb-scope-opt" +
                  (o.value === current ? " is-current" : "") +
                  (i === activeIndex ? " is-active" : "")
                }
                data-testid="project-option"
                data-project={o.value}
                onClick={() => choose(o.value)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {/* session segment (Fix B): read-only, only on a session URL. */}
      {sessionLabel != null ? (
        <>
          <span className="lds-tb-scope-sep" aria-hidden>
            /
          </span>
          <span
            className="lds-tb-scope-session"
            data-testid="topbar-session-name"
            title={sessionLabel}
          >
            {sessionLabel}
          </span>
        </>
      ) : null}
    </span>
  );
}

// short, stable fallback for an unknown session id (first 8 chars).
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
