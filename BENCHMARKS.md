# Benchmark comparison tool — design (long-term, not yet implemented)

> Status: **design only**. This document is the spec for a future phase; no code
> ships for it yet. Everything else in this package is implemented.

## Goal

Let the user compare *key agentic coding benchmarks* against the *current
Surplus marketplace* for a set of models, and get:

1. A **model recommendation** — the best value pick for a given workload.
2. **Project / daily spend estimates** for each candidate.

## Shape

Two surfaces:

- **`surplus_benchmarks`** (server tool, agent-callable)
- **`/surplus-benchmarks`** (TUI command, dialog output)

Both share the same scoring engine (`benchmarks.ts` / `benchmarks.js` in the
package) so results never diverge.

## Data

### Benchmark dataset (`benchmarks.json`, bundled + refreshed)

Curated table keyed by model ID:

```jsonc
{
  "swe-bench-verified": {
    "claude-opus-4.8": 71.2,
    "gpt-5.5": 68.9,
    // ...
  },
  "swe-bench-pro": { ... },
  "terminal-bench": { ... },
  "aider-polyglot": { ... },
  "livecodebench": { ... }
}
```

- Rows are **model IDs as discovered by model discovery** so they line up with
  the marketplace.
- Refresh via `sync-benchmarks.mjs` (fetches from a pinned, versioned source —
  initially a GitHub-hosted JSON committed in this repo; later an API if one is
  available without a key).
- Unknown models are omitted from scoring and reported as "no benchmark data".

### Live market overlay

For each candidate model, query the existing `markets()` API and reuse the
existing **blended `$/1M`** logic (input/output mix + cache-hit fraction), so
prices reflect the user's real usage, not sticker rates. Also report the
**strictest tier that passes** right now (reusing `bestDiscountPct`).

## Inputs (tool/command args)

| arg | type | default | meaning |
|---|---|---|---|
| `models` | string[] | auto (top-10 by score) | models to compare |
| `benchmarks` | string[] | all | which benchmarks to weight |
| `weights` | number[] | equal | relative weights per benchmark |
| `workload` | enum | `"agentic"` | preset weight profile: `agentic`, `code-change`, `refactor`, `long-context` |
| `dailyTokens` | number | 10M | assumed daily input+output token budget |
| `projectTokens` | number | — | optional project token budget |

## Scoring & recommendation

For each model compute:

```
value = Σ(weight_i × score_i) / blended $/1M
```

- `value` is the "agentic tokens-per-dollar efficiency".
- Recommendation = argmax(value), with the constraint that the strictest tier
  currently passing is displayed per model (a model at 0% off may still be the
  best value; the tool says so explicitly).
- Pareto line: report models on the frontier of (blended score, cost) so the
  user sees trade-offs, not just one pick.

## Spend estimates

- **Daily**: `dailyTokens × blended $/1M ÷ 1e6`.
- **Project**: `projectTokens × blended $/1M ÷ 1e6` (when provided).
- Show per-model alongside the tier that passes so the floor is part of the
  decision ("best at ≥90% off", etc.).

## Output format (tool)

```
Benchmarks · SWE-bench-V 71.2 · Terminal 68.0 · ...   (weighted 1:1:1)

claude-opus-4.8    value 94.1  ·  $0.00072/1M blended  ·  min90 passes
  daily (10M tok): $7.20   ·  project (50M): $36.00
gpt-5.5            value 81.3  ·  $0.00091/1M blended  ·  min80 passes
  daily (10M tok): $9.10   ·  project (50M): $45.50

Recommendation: claude-opus-4.8 (best value)
```

TUI `/surplus-benchmarks` renders the same table in a dialog with a tier
quick-switch action per row (reuses `/surplus-tier`).

## Data freshness

- `benchmarks.json` ships in the repo and is refreshed by `sync-benchmarks.mjs`.
- Market numbers are always live at call time.
- Add a `--stale-after-days` guard so old benchmark data is flagged rather than
  silently used.

## Open questions

- Which public benchmark source to pin (Artificial Analysis API needs a key;
  a versioned GitHub JSON is the no-key fallback).
- Whether to fold per-benchmark uncertainty/error bars into the value score.
- Project token budget estimation from repo size (number of files × LOC) — nice
  but out of scope for the first cut.
