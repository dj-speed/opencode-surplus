# opencode-surplus

Surplus Intelligence status and routing controls for the [opencode](https://opencode.ai) TUI.

If you buy LLM tokens through [Surplus Intelligence](https://www.surplusintelligence.ai), this plugin puts your costs and the live marketplace right in your terminal:

- **Live TPS meter** next to the input box — tokens per second, average speed, and time-to-first-token.
- **"Today" block** at the top of the sidebar — today's blended price per 1M tokens, % off vs list, and total spend (from Surplus's settled usage records).
- **Routing status** in the sidebar footer — your discount floor, the top 3 marketplace offers (blended to *your* usage), the routing pin, and this session's cost / avg / token total.
- **Model discovery** — the plugin scrapes the Surplus model catalog at startup (and via `sync-models.mjs`) so every tier provider lists the full marketplace, without hand-maintaining model lists.
- **One discount tier per model** — the tier providers are hidden behind a single grouped "Surplus Intelligence" entry in the model picker; `/surplus-tier` sets the floor for the active model and the sidebar shows only that one tier.
- **Floor-failure prompt** — with `/surplus-flag yes`, a `minimum_discount_not_met` failure immediately pops a dialog offering a **recommended tier** (the strictest one that currently passes) to adjust to; with the flag off, failures just fail normally (no prompt, no auto-change).
- **`/surplus-*` commands** — instant, free, no LLM round-trip (see below).

It ships as three files:

| File | Kind | What it adds |
|---|---|---|
| `surplus-sidebar.tsx` | TUI plugin | The meter, sidebar blocks, and `/surplus-*` commands |
| `surplus-control.js` | server plugin | `surplus_*` agent tools, model discovery, floor proxy, floor-failure prompt |
| `sync-models.mjs` | CLI script | Manual model-catalog scrape (cache + optionally write config) |

---

## Requirements

- [opencode](https://opencode.ai) 1.18.x or newer.
- A Surplus Intelligence API key saved in opencode (`opencode auth login`, provider ID starting with `surplus`). The key is read from your `auth.json` at runtime — it is **never** stored in this plugin.
- Optional but recommended: Surplus **providers configured in `opencode.json`** so requests route through the `/min{N}` discount-floor URLs (see "Providers" below).

> **No secrets here.** This package contains no API keys, no wallet addresses, and no personal paths. It reads your key from opencode's own `auth.json`.

---

## Install (one command)

```bash
git clone https://github.com/<your-user>/opencode-surplus.git
cd opencode-surplus
./install.sh
```

Or without git — download this folder and run `./install.sh` from inside it.

That copies both plugin files into your opencode config, backs up and updates your `tui.json`, and tells you to restart. Done.

**Manual install** (if you prefer to place files yourself):

```bash
# TUI plugin:
cp surplus-sidebar.tsx ~/.config/opencode/surplus-sidebar.tsx
# add to ~/.config/opencode/tui.json:
#   { "plugin": ["./surplus-sidebar.tsx"] }

# Server plugin:
mkdir -p ~/.config/opencode/plugins
cp surplus-control.js ~/.config/opencode/plugins/surplus-control.js
```

Restart opencode after installing.

---

## Providers (recommended, for discount floors)

The Surplus API enforces discount floors via the **URL path**, not the request body. The plugin keeps **one `surplus` catalog provider** — every discovered (text-output) model is listed there **exactly once**, so the model picker shows a single clean "Surplus Intelligence" group:

```jsonc
{
  "provider": {
    "surplus": {
      "name": "Surplus Intelligence",
      "npm": "@ai-sdk/openai-compatible",
      "options": {},
      "models": { "deepseek-v4-flash": { "name": "DeepSeek V4 Flash" } }
    }
  }
}
```

The provider's `baseURL` is pointed at a **local floor proxy** the plugin runs (`http://127.0.0.1:<port>/v1`). On every request the proxy reads the model's current floor from `~/.local/share/opencode/surplus-control.json` and forwards to `https://api.surplusintelligence.ai/min{floor}/v1`. That makes floors **instant**:

- `/surplus-tier NN` (or `surplus_settier`) sets the floor for the active model (≥70/80/90/95% or off) — **it applies to the very next request**, no restart.
- Legacy tier providers you've already configured (`surplus-70/80/90/95`) keep working as floor shortcuts, and catalog models you've explicitly placed there are **skipped from the catalog** so nothing is listed twice.
- If the proxy can't start, the plugin falls back to per-model `provider.api` URLs (floors apply on the next start).

Then run `opencode auth login` for the surplus provider (or copy the existing surplus credential), pick the model in `/models`, and the sidebar shows its floor.

> Note: Surplus **ignores** `max_price_per_1m` / `X-Max-Price-Per-1M` (verified live). The floor is the `/min{N}` URL.

---

## `/surplus-*` commands

Run these with `/` (autocomplete) or Ctrl-P (command palette, category **Surplus**). They run in-process — no model call, instant, free:

| Command | What it shows |
|---|---|---|
| `/surplus-status` (alias `/surplus`) | Active model, provider, **single discount floor**, pin, offers, session stats |
| `/surplus-offers` | Top 10 healthy sellers for the active model (optionally filtered to the pin) |
| `/surplus-tier` | Set the discount floor for the active model (≥70/80/90/95% or off) |
| `/surplus-flag` | Toggle backoff-prompt mode (prompt to adjust tier after 60s vs auto-switch) |
| `/surplus-models` | List the discovered Surplus model catalog |
| `/surplus-spend` | Today's spend + tokens + blended $/1M + savings vs list, and this session's spend/avg |
| `/surplus-pin` | Interactive picker to pin the active model to a seller host (or reset/clear/type a URL) |
| `/surplus-clear` | Clears stored overrides for the active model |
| `/surplus-tui` | Disable the TUI integration (meter, sidebar, commands) for this session |

The agent-callable server tools mirror most of these: `surplus_offers`, `surplus_pin`, `surplus_tier`, `surplus_settier`, `surplus_flag`, `surplus_models`, `surplus_backoff`, `surplus_spend`, `surplus_clear`.

---

## Reading the sidebar

```
Context            <- opencode's built-in panel (this session)
  ...tokens
  ...$ spent
Today              <- our block: today's blended price, % off, total spend
Floor ≥90% (min90) <- the discount floor of the provider you're on
94.2% off · $0.00072/1M · OpenRouter   <- top marketplace offers,
94.0% off · ...                         <- blended to YOUR usage
Pin none          <- no routing pin; Surplus picks the best seller
$0.12 · avg $0.0008/1M · 148.2M tok    <- THIS session's totals
```

Color coding: green = ≥90% off, yellow = ≥80%, red = below.

---

## How the numbers are computed

- **Today avg $/1M** = settled cost ÷ total tokens. The usage CSV's `input_tokens` already includes cached prompt tokens, and the settled cost prices them at the cache-read rate.
- **Offer $/1M** = each seller's per-token rates weighted by your real input/output mix, adjusted for your cache-hit fraction (capped at 95%). This is closer to what you'd actually pay than the sticker rate card.
- **Session totals** (cost / tokens) come from opencode's authoritative session record and include cached tokens, so they match the Context panel.

---

## Configuration (optional)

The TUI plugin accepts options via the `tui.json` tuple form:

```jsonc
{
  "plugin": [["./surplus-sidebar.tsx", {
    "enabled": true,
    "offers": { "filterByPin": false },
    "spinner": { "theme": "tech", "intervalMs": 100, "cells": 6 },
    "tiers": {
      "tps":  { "slow": 20, "normal": 50, "fast": 100 },
      "ttft": { "fast": 10000, "ok": 20000 }
    }
  }]]
}
```

- `enabled: false` disables the whole TUI integration (meter, sidebar blocks, commands) without uninstalling — restart to apply. `/surplus-tui` disables it for the current session.
- `offers.filterByPin: true` restricts the sidebar and `/surplus-offers` to offers matching the model's routing pin (host URL or provider family).
- Spinner themes: `tech` (cyan/blue/purple), `red`, or `"theme": "none"` to disable. Custom `colors` array also works.
- `tiers.tps` / `tiers.ttft` tune the color thresholds for the speed meter.

The server plugin's routing pins (for GLM models → the Z.ai coding host) are in `BASE_PINS` at the top of `surplus-control.js`; edit and reinstall to change them.

## Model discovery

The catalog is scraped from the Surplus inference endpoint (`https://www.surplusintelligence.ai/api/inference/v1/models`) in the **background at startup**, then cached to `~/.cache/opencode/models-surplus.json` and merged into the single `surplus` provider **before** opencode resolves providers (two-phase: sync cache load, async refresh). **Only models with text output are kept** — the catalog's image/video/audio-only models are excluded. To scrape manually (e.g. for CI or first setup):

```bash
node sync-models.mjs                # discover + cache only
node sync-models.mjs --write-config # also write models into provider "surplus" in opencode.json
                                    # (models already in a surplus-NN tier provider are skipped — no duplicates)
node sync-models.mjs --pricing      # seed/refresh the pricing cache (surplus-pricing.json) for session cost
node sync-models.mjs --query gpt    # list matching models with live discounts
```

## Floor-failure prompt (backoff-prompt mode)

When a request fails with `minimum_discount_not_met`, the floor proxy annotates the error so the plugin reliably detects it:

- **Default (flag off):** the failure is surfaced normally — no prompt, no automatic floor change.
- **Flag on (`/surplus-flag yes`):** the plugin **immediately** raises a dialog to **adjust the discount tier** — it recommends the strictest tier below the current floor that live offers pass, plus the other tiers and off. Picking one persists the floor and re-submits your last message through the new floor.

State lives in `surplus-control.json` (`_flags.backoffPrompt`, `_backoffPrompt`); `surplus_backoff` reports/clears pending prompts. An automatic retry loop (re-driving a failed request with backoff) is planned future work.

## Benchmarks (long-term, design)

See [`BENCHMARKS.md`](BENCHMARKS.md) for the design of a benchmark-vs-market comparison tool (`surplus_benchmarks` / `/surplus-benchmarks`) that recommends models and estimates daily/project spend. Not implemented yet.

---

## Troubleshooting

- **Sidebar surplus rows don't appear** → no Surplus provider/model is active in this session, or the API key isn't in `auth.json` under a `surplus*` ID.
- **`/surplus-*` commands missing** → opencode wasn't restarted after install, the plugin isn't in `tui.json`, or `enabled` is false.
- **Floor errors (`minimum_discount_not_met`)** → the `/min{N}` floor is stricter than any current offer. With `/surplus-flag yes` a dialog immediately offers a recommended tier to adjust to; otherwise the request just fails (no auto-change). You can always lower the floor manually with `/surplus-tier`.
- **Model picker shows one "Surplus Intelligence" group with each model once** — the discovered catalog lives in the single `surplus` provider. Models you've explicitly configured in a `surplus-70/80/90/95` tier provider appear there too (once per tier — that's the floor shortcut); catalog models are skipped from the catalog if they already exist in a tier provider.
- **Floor changes don't apply** → floors apply via the local floor proxy, which reads the model's floor from `surplus-control.json` on every request. If you edited the file manually or the proxy isn't running (check the port in the plugin log), restart opencode.
- **Model discovery fails / `/surplus-models` is empty** → run `node sync-models.mjs`. If it reports no models, the Surplus edge's Brotli compression can trip Node's undici; all plugin API calls send `Accept-Encoding: identity` to work around it.

---

## License

MIT — see `LICENSE`.
