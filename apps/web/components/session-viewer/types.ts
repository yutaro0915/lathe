import type { EventType } from "@/lib/types";

export type Tab =
  | "transcript"
  | "tools"
  | "git"
  | "skills"
  | "subagents"
  | "annotations"
  | "findings"
  | "raw"
  | "stats";

export type FilterMode = "highlight" | "hide";

export type TurnFile = { id: string; path: string };

export type TurnRollup = {
  turn: number;
  steps: number;
  edits: number;
  bash: number;
  errors: number;
  tokens: number;
  durationMs: number;
  wallDurationMs: number;
  costUsd: number | null;
  files: TurnFile[];
  summary: string;
  collapsed: boolean;
};

export const ALL_TYPES: EventType[] = [
  "user_message",
  "assistant_message",
  "thinking",
  "file_read",
  "file_edit",
  "file_write",
  "bash",
  "subagent",
  "skill",
  "memory",
  "hook",
  "commit",
  "test",
  "todo",
  "error",
];

export const TOOL_TYPES: EventType[] = ["bash", "file_read", "file_edit", "file_write", "test", "commit"];

export function durLabel(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function firstNonEmptyLine(text: string | null | undefined): string {
  return (text ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

export function hmsToMs(ts: string): number | null {
  const m = /(\d{2}):(\d{2}):(\d{2})/.exec(ts);
  if (!m) return null;
  return (Number(m[1]) * 60 * 60 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

export function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}
