# Cost Semantics

Updated: 2026-06-11

This document defines how Lathe computes session cost and records the pricing audit performed before G9 cost anomaly detection.

## Sources

- Anthropic first-party pricing: https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI first-party pricing: https://developers.openai.com/api/docs/pricing
- Bundled source table: `apps/web/db/pricing.json`, pinned from LiteLLM on 2026-06-06.

`pricing.json` is bundled so `pnpm -F web ingest` and the published package can work offline. First-party pages are the authority when a bundled value differs from the vendor's current public price.

## What Counts As Cost

Lathe prices token usage at ingest time and stores the result in `sessions.cost_usd`.

Included:

- Fresh input tokens: `input_tokens`
- Output tokens: `output_tokens`
- Cache creation tokens: `cache_creation_input_tokens`
- Cache read / cached input tokens: `cache_read_input_tokens` for Claude, `cached_input_tokens` for Codex/OpenAI

Not included:

- Session headline cost does not include child sub-agent transcript cost. Sub-agent cost is calculated from child transcripts and displayed on each sub-agent launcher/run.
- An individual message whose model id cannot be resolved is not guessed. A session cost is `null` only when no priced message usage exists.
- Tool flat fees are not currently represented in the observed transcripts and are not added.

Token totals intentionally exclude cache-read/cached-input tokens because the token UI is a "work performed" signal. Cost includes cache reads because they are billed.

## Pricing Audit

Unit: USD per 1M tokens. `cacheWrite` means Anthropic 5-minute cache write when the transcript does not expose a 1-hour TTL distinction; for OpenAI it equals fresh input because there is no separate write surcharge in Lathe's observed Codex usage.

| Model / prefix | `pricing.json` before | First-party price | Result |
|---|---:|---:|---|
| `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5` | input 15 / write 18.75 / read 1.5 / output 75 via generic `opus` | input 5 / 5m write 6.25 / read 0.5 / output 25 | Fixed. Previous generic `opus` fallback over-counted Opus 4.5+ by 3x. |
| `claude-opus-4-1`, `claude-opus-4` | input 15 / write 18.75 / read 1.5 / output 75 | input 15 / 5m write 18.75 / read 1.5 / output 75 | No change. |
| `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-sonnet-4` | input 3 / write 3.75 / read 0.3 / output 15 | input 3 / 5m write 3.75 / read 0.3 / output 15 | No change; explicit prefixes added. |
| `claude-haiku-4-5` | generic `haiku` input 0.8 / write 1.0 / read 0.08 / output 4 | input 1 / 5m write 1.25 / read 0.1 / output 5 | Fixed by explicit prefix. |
| `claude-haiku-3-5` | input 0.8 / write 1.0 / read 0.08 / output 4 | input 0.8 / 5m write 1.0 / read 0.08 / output 4 | No change; explicit prefix added. |
| `claude-fable-5`, `claude-mythos-5` | unpriceable unless a later message matched another family | input 10 / 5m write 12.5 / read 1 / output 50 | Fixed by explicit prefix. |
| `gpt-5.5` | input 5 / cached 0.5 / output 30 | input 5 / cached 0.5 / output 30 | No change. |
| `gpt-5.5-pro` | input 30 / cached 3 / output 180 | input 30 / cached not listed / output 180 | Kept. The bundled table has a cached-input value, but current first-party table lists no cached price for pro. Lathe has no observed `gpt-5.5-pro` sessions. |
| `gpt-5.4` | input 2.5 / cached 0.25 / output 15 | input 2.5 / cached 0.25 / output 15 | No change. |
| `gpt-5.4-mini` | input 0.75 / cached 0.075 / output 4.5 | input 0.75 / cached 0.075 / output 4.5 | No change. |
| `gpt-5.4-nano` | input 0.2 / cached 0.02 / output 1.25 | input 0.2 / cached 0.02 / output 1.25 | No change. |
| `gpt-5.4-pro` | input 30 / cached 3 / output 180 | input 30 / cached not listed / output 180 | Kept. Lathe has no observed `gpt-5.4-pro` sessions. |
| `gpt-5.3` / `gpt-5.3-codex` effective prefix | input 1.75 / cached 0.175 / output 14 | `gpt-5.3-codex` input 1.75 / cached 0.175 / output 14 | No change. |

## Verification Conclusion

Conclusion: cost logic needed correction.

The raw transcript replay added in `pnpm -F web verify:cost` proved DB values matched the old code exactly, so the storage pipeline was internally consistent. The pricing audit found the model mapping was too coarse for newer Claude Opus versions: all Opus models were charged with the older Opus 4 / 4.1 tier even when transcripts carried `claude-opus-4-6`, `claude-opus-4-7`, or `claude-opus-4-8`.

Before re-ingest, the existing DB showed the older over-counted Opus totals:

| Model | Sessions | Old summed cost |
|---|---:|---:|
| `claude-opus-4-8` | 74 | $10,341.60 |
| `claude-opus-4-7` | 18 | $8,598.92 |
| `claude-opus-4-6` | 10 | $209.54 |
| `gpt-5.5` | 183 | $3,003.15 |
| `gpt-5.4` | 22 | $29.05 |

After re-ingest with the corrected model prefixes:

| Model | Sessions | New summed cost |
|---|---:|---:|
| `claude-opus-4-8` | 74 | $3,477.00 |
| `claude-opus-4-7` | 18 | $2,866.31 |
| `claude-opus-4-6` | 10 | $69.85 |
| `claude-fable-5` | 6 | $607.00 |
| `gpt-5.5` | 183 | $3,003.15 |
| `gpt-5.4` | 22 | $29.05 |

Verification result:

- `pnpm -F web ingest`: `sessions=344 events=65011 changed_files=2175 hunks=6015 attributions=6015 event_files=12434 annotations=4352`
- `pnpm -F web verify:cost`: GREEN, 15/15 checked, max relative diff 0.0000%
