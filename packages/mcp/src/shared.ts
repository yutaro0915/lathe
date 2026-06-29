// Shared scalar helpers used by multiple modules in packages/mcp/src.
// No domain imports — only pure functions and constants.

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function cleanNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

export function normalizeLimit(value: number | undefined): number {
  return Math.min(MAX_LIMIT, Math.max(1, cleanNumber(value, DEFAULT_LIMIT)));
}

export function assertMaxLength(label: string, value: string | undefined, max: number): void {
  if (value !== undefined && value.length > max) {
    throw new Error(`${label} must be ${max} characters or fewer`);
  }
}
