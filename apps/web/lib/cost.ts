// lib/cost.ts — derive USD cost from real token counts.
//
// Claude Code transcripts carry no cost field, but they DO carry per-message
// token usage (input / output / cache-creation / cache-read). We price those
// four categories with bundled per-tier rates (db/pricing.json, mirrored from
// LiteLLM's MIT pricing data) — the same approach ccusage uses, but with zero
// runtime dependencies and no network access (works offline; npm-publish safe).
//
// Pure module (no node APIs) so it imports cleanly from both the tsx ingest
// script and Next. The pricing JSON is imported by RELATIVE path so tsx (which
// does not resolve the "@/" tsconfig alias) can load it during ingest.

import pricing from "../db/pricing.json";

export interface TokenUsage {
  input: number; // input_tokens
  output: number; // output_tokens
  cacheWrite: number; // cache_creation_input_tokens (cache write, ~1.25x input)
  cacheRead: number; // cache_read_input_tokens   (cache read, ~0.1x input — cheap but often the biggest bucket)
}

export interface TierRate {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const TIERS = pricing.tiers as Record<string, TierRate>;
const CLAUDE = pricing.claude as Record<string, TierRate>;
// Newer Claude families have version-specific prices, so check exact model-id
// prefixes before falling back to the coarse opus/sonnet/haiku tiers.
const CLAUDE_KEYS = Object.keys(CLAUDE).sort((a, b) => b.length - a.length);
const OPENAI = pricing.openai as Record<string, TierRate>;
// longest id first so "gpt-5.5" / "gpt-5.4-mini" win over the "gpt-5" prefix
const OPENAI_KEYS = Object.keys(OPENAI).sort((a, b) => b.length - a.length);

// Map a transcript model string to a pricing tier. Claude and OpenAI first use
// longest model-id prefix matching, then Claude falls back to family substring
// matching (opus/sonnet/haiku) for older or abbreviated transcript model names.
// Returns null for models we cannot price (e.g. "claude-code", "codex-auto-
// review", "<synthetic>") — callers must then show "—" rather than invent one.
export function resolveTier(model: string | null | undefined): TierRate | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const k of CLAUDE_KEYS) if (m.startsWith(k)) return CLAUDE[k];
  if (m.includes("opus")) return TIERS.opus;
  if (m.includes("sonnet")) return TIERS.sonnet;
  if (m.includes("haiku")) return TIERS.haiku;
  for (const k of OPENAI_KEYS) if (m.startsWith(k)) return OPENAI[k];
  return null;
}

// USD cost for one usage bundle under a model, or null if the model is not
// priceable. Prices are per-million tokens, so divide by 1e6.
export function costForUsage(
  model: string | null | undefined,
  u: TokenUsage
): number | null {
  const t = resolveTier(model);
  if (!t) return null;
  return (
    (u.input * t.input +
      u.output * t.output +
      u.cacheWrite * t.cacheWrite +
      u.cacheRead * t.cacheRead) /
    1_000_000
  );
}

export const PRICING_SOURCE = pricing.source;
export const PRICING_PINNED_AT = pricing.pinnedAt;
