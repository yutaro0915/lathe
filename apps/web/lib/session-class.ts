import { SESSION_CLASSES, type SessionClass } from "../scripts/ingest/domain/session-class";

export type SessionClassFilter = SessionClass | "all";

export const SESSION_CLASS_OPTIONS: { value: SessionClassFilter; label: string }[] = [
  ...SESSION_CLASSES.map((value) => ({ value, label: value })),
  { value: "all", label: "all classes" },
];

const SESSION_CLASS_FILTER_SET = new Set<string>(SESSION_CLASS_OPTIONS.map((option) => option.value));

export function parseSessionClassFilter(value: unknown): SessionClassFilter | undefined {
  return typeof value === "string" && SESSION_CLASS_FILTER_SET.has(value)
    ? (value as SessionClassFilter)
    : undefined;
}

export function sessionClassFilterOrDefault(value: unknown): SessionClassFilter {
  return parseSessionClassFilter(value) ?? "development";
}

export function sessionClassLabel(value: string): string {
  return value === "all" ? "all classes" : value;
}

export function writeSessionClassParam(params: URLSearchParams, value: SessionClassFilter) {
  if (value === "development") params.delete("sessionClass");
  else params.set("sessionClass", value);
}
