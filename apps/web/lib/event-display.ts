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

// ---- D7: step kinds --------------------------------------------------------
// The transcript groups the ~15 raw event types into FIVE step kinds (D7). A
// step's kind is derived from event.type; the Step component (D8) keeps one
// invariant frame and only varies the kind icon / signal / detail-block.
// `user_message` is NOT a kind — it is the TURN HEADER, so it is absent here.
// `error` is NOT a kind either — it is a cross-cutting STATE (D7/D10); a raw
// `error`-type event renders as an `execute` step carrying the error state.
export type StepKind = "thinking" | "investigate" | "execute" | "edit" | "message";

// event.type → kind. Grounded against EVENT_LABEL above:
//   thinking            → thinking
//   assistant_message   → message
//   file_read, memory   → investigate (reading code / loading context files)
//   file_edit, file_write → edit
//   bash, test, skill, commit, hook, subagent → execute (a tool/command ran)
//   todo                → message (low-frequency status note; closest to a
//                         user-facing message, documented choice)
//   error               → execute (error is a STATE, base kind = execute)
//   user_message        → message (only as a defensive fallback; user_message
//                         is consumed as a turn header before it reaches a Step)
export const TYPE_KIND: Record<EventType, StepKind> = {
  thinking: "thinking",
  assistant_message: "message",
  file_read: "investigate",
  memory: "investigate",
  file_edit: "edit",
  file_write: "edit",
  bash: "execute",
  test: "execute",
  skill: "execute",
  commit: "execute",
  hook: "execute",
  subagent: "execute",
  todo: "message",
  error: "execute",
  user_message: "message",
};

// Short, lowercase kind label shown in the step frame (matches the mockup).
export const KIND_LABEL: Record<StepKind, string> = {
  thinking: "thinking",
  investigate: "investigate",
  execute: "execute",
  edit: "edit",
  message: "message",
};

// One glyph per kind for the step's leading icon (the frame's kind icon slot).
export const KIND_GLYPH: Record<StepKind, string> = {
  thinking: "✲",
  investigate: "◎",
  execute: "›_",
  edit: "✎",
  message: "✦",
};

export function kindOf(type: EventType): StepKind {
  return TYPE_KIND[type] ?? "execute";
}

// D7/D10: a step is in the ERROR state when it is an error event OR exited
// non-zero. The state is cross-cutting (any kind can carry it) and is the only
// privileged color (clean red, var(--c-error)).
export function hasErrorState(type: EventType, exitCode: number | null): boolean {
  return type === "error" || (exitCode != null && exitCode !== 0);
}
