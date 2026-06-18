"use client";

import { useRouter } from "next/navigation";
import { fmtCompact, fmtDuration, fmtInt } from "@lathe/shared";
import { RUNNER_LABEL } from "@/lib/runner-display";
import type { ChangedFile, Session } from "@/lib/types";

export function StandaloneChrome({
  sessions,
  current,
  currentId,
  files,
  onSwitchSession,
}: {
  sessions: Session[];
  current: Session;
  currentId: string;
  files: ChangedFile[];
  onSwitchSession: (id: string) => void;
}) {
  const router = useRouter();
  const runnerLabel = RUNNER_LABEL[current.runner] ?? current.runner;
  const branch = current.gitBranch ?? "main";
  const commitText = `${current.commitCount} commit${current.commitCount === 1 ? "" : "s"}`;
  return (
    <>
      <div className="lds-session-bar" data-testid="sessbar">
        <div className="lds-session-bar-id" data-testid="sessbar-id">
          <span className={`runner-dot ${current.runner}`} data-testid="runner-dot" aria-hidden />
          <span className="lds-session-bar-title" data-testid="sessbar-title" title={current.title}>
            {current.title}
          </span>
          {current.errorCount > 0 && (
            <span className="badge err" data-testid="badge" title={`${current.errorCount} failed tool call(s) in this session`}>
              {current.errorCount} error{current.errorCount === 1 ? "" : "s"}
            </span>
          )}
          <span className="lds-session-bar-meta" data-testid="sessbar-meta">
            Git diff · {runnerLabel} · <span className="mono" data-testid="mono">⎇ {branch}</span> · {commitText} ·{" "}
            {current.startedAt.replace("T", " ").slice(0, 16)}
          </span>
        </div>
        <div className="lds-session-bar-stats" data-testid="sessbar-stats">
          <div className="kstat" data-testid="kstat">
            <b>{fmtInt(files.length)}</b>
            <span>files</span>
          </div>
          <div className="kstat" data-testid="kstat">
            <b>{fmtDuration(current.durationMs)}</b>
            <span>duration</span>
          </div>
          <div className="kstat" data-testid="kstat">
            <b>{fmtInt(current.turnCount)}</b>
            <span>turns</span>
          </div>
          <div
            className="kstat"
            data-testid="kstat"
            title={`${fmtInt(current.tokenIn)} in · ${fmtInt(current.tokenOut)} out`}
          >
            <b>{fmtCompact(current.tokenIn + current.tokenOut)}</b>
            <span>tokens</span>
          </div>
        </div>
      </div>

      <div className="lds-session-tabs" data-testid="tabs" role="tablist">
        {(
          [
            ["transcript", "Transcript"],
            ["tools", "Tools"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={false}
            data-tab={key}
            className="lds-session-tab"
            data-testid="tab"
            onClick={() => router.push(`/?session=${encodeURIComponent(currentId)}&tab=${key}`)}
          >
            {label}
          </button>
        ))}
        <span className="lds-session-tab active" data-testid="tab" role="tab" aria-selected={true} data-tab="git">Git</span>
        {(
          [
            ["skills", "Skills"],
            ["subagents", "Subagents"],
            ["raw", "Raw JSON"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={false}
            data-tab={key}
            className="lds-session-tab"
            data-testid="tab"
            onClick={() => router.push(`/?session=${encodeURIComponent(currentId)}&tab=${key}`)}
          >
            {label}
          </button>
        ))}
        <span className="lds-session-tabs-spacer" data-testid="tabs-spacer" />
        <span className="lds-session-tabs-tool" data-testid="tabs-tool">
          <label style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <span className="muted small" data-testid="muted">Session</span>
            <select
              value={currentId}
              onChange={(event) => onSwitchSession(event.target.value)}
              style={{
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "5px 9px",
                color: "var(--text)",
                font: "inherit",
                fontSize: 12.5,
                cursor: "pointer",
                maxWidth: 260,
              }}
            >
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
            </select>
          </label>
        </span>
      </div>
    </>
  );
}
