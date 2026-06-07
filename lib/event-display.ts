import type { EventType } from "@/lib/types";

// Event-type color palette shared by transcript and stats surfaces.
export const EVENT_COLOR: Record<EventType, string> = {
  user_message: "#64748b",
  assistant_message: "#6366f1",
  thinking: "#a855f7",
  file_read: "#0ea5e9",
  file_edit: "#f59e0b",
  file_write: "#10b981",
  bash: "#475569",
  subagent: "#8b5cf6",
  skill: "#eab308",
  commit: "#22c55e",
  test: "#14b8a6",
  error: "#ef4444",
  todo: "#94a3b8",
  memory: "#06b6d4",
  hook: "#f43f5e",
};

// Short human label per event type.
export const EVENT_LABEL: Record<EventType, string> = {
  user_message: "User",
  assistant_message: "Assistant",
  thinking: "Thinking",
  file_read: "Read",
  file_edit: "Edit",
  file_write: "Write",
  bash: "Bash",
  subagent: "Sub-agent",
  skill: "Skill",
  commit: "Commit",
  test: "Test",
  error: "Error",
  todo: "Todo",
  memory: "Memory",
  hook: "Hook",
};

// Single-character glyph per event type for compact timeline markers.
export const TYPE_GLYPH: Record<EventType, string> = {
  user_message: "◍",
  assistant_message: "✦",
  thinking: "✲",
  file_read: "◎",
  file_edit: "✎",
  file_write: "＋",
  bash: "›_",
  subagent: "⌥",
  skill: "★",
  commit: "⎇",
  test: "✓",
  error: "!",
  todo: "☐",
  memory: "❏",
  hook: "↪",
};
