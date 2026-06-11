import type { EventType } from "@/lib/types";

// Event-type color palette shared by transcript and stats surfaces.
export const EVENT_COLOR: Record<EventType, string> = {
  user_message: "#7d92b8",
  assistant_message: "#9c8fc4",
  thinking: "#ada0cf",
  file_read: "#6fa3b8",
  file_edit: "#c2a36b",
  file_write: "#7aa389",
  bash: "#8b95a5",
  subagent: "#9c8fc4",
  skill: "#c2a36b",
  commit: "#7aa389",
  test: "#6fa3b8",
  error: "#d64545",
  todo: "#aab2bd",
  memory: "#6fa3b8",
  hook: "#aab2bd",
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
