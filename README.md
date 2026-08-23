# opencode-surplus

Surplus Intelligence status and routing controls for the [opencode](https://opencode.ai) TUI.

If you buy LLM tokens through [Surplus Intelligence](https://www.surplusintelligence.ai), this plugin puts your costs and the live marketplace right in your terminal:

- **Live TPS meter** next to the input box — tokens per second, average speed, and time-to-first-token.
- **"Today" block** at the top of the sidebar — today's blended price per 1M tokens, % off vs list, and total spend (from Surplus's settled usage records).
- **Routing status** in the sidebar footer — your discount floor, the top 3 marketplace offers (blended to *your* usage), the routing pin, and this session's cost / avg / token total.
- **`/surplus-*` commands** — instant, free, no LLM round-trip (see below).

It ships as two optional-but-complementary files:

| File | Kind | What it adds |
|---|---|---|
| `surplus-sidebar.tsx` | TUI plugin | The meter, sidebar blocks, and `/surplus-*` commands |
| `surplus-control.js` | server plugin | `surplus_offers` / `surplus_pin` / `surplus_tier` / `surplus_spend` / `surplus_clear` agent tools |

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

The Surplus API enforces discount floors via the **URL path**, not the request body. Configure the tier providers in your `opencode.json` so requests route to the right floor:

```jsonc
{
  "provider": {
    "surplus-70": {
      "name": "Surplus 70",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://api.surplusintelligence.ai/min70/v1" },
      "models": { "deepseek-v4-flash-0731": { "name": "DeepSeek V4 Flash 0731" } }
    },
    "surplus-90": {
      "name": "Surplus 90",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://api.surplusintelligence.ai/min90/v1" },
      "models": { "deepseek-v4-flash-0731": { "name": "DeepSeek V4 Flash 0731" } }
    }
    // ... 80 and 95 the same way
  }
}
```

Then run `opencode auth login` for each provider ID you use (or copy the existing surplus credential), pick the model+provider in `/models`, and the sidebar shows the matching floor.

> Note: Surplus **ignores** `max_price_per_1m` / `X-Max-Price-Per-1M` (verified live). The floor is the `/min{N}` URL. Pick the provider matching the floor you want.

---

## `/surplus-*` commands

Run these with `/` (autocomplete) or Ctrl-P (command palette, category **Surplus**). They run in-process — no model call, instant, free:

| Command | What it shows |
|---|---|
| `/surplus-status` (alias `/surplus`) | Active model, provider, discount floor, pin, offers, session stats |
| `/surplus-offers` | Top 10 healthy sellers for the active model |
| `/surplus-tier` | Strictest discount tier provider that currently passes |
| `/surplus-spend` | Today's spend + tokens + blended $/1M + savings vs list, and this session's spend/avg |
| `/surplus-pin` | Interactive picker to pin the active model to a seller host (or reset/clear/type a URL) |
| `/surplus-clear` | Clears stored overrides for the active model |

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
    "spinner": { "theme": "tech", "intervalMs": 100, "cells": 6 },
    "tiers": {
      "tps":  { "slow": 20, "normal": 50, "fast": 100 },
      "ttft": { "fast": 10000, "ok": 20000 }
    }
  }]]
}
```

- Spinner themes: `tech` (cyan/blue/purple), `red`, or `"theme": "none"` to disable. Custom `colors` array also works.
- `tiers.tps` / `tiers.ttft` tune the color thresholds for the speed meter.

The server plugin's routing pins (for GLM models → the Z.ai coding host) are in `BASE_PINS` at the top of `surplus-control.js`; edit and reinstall to change them.

---

## Troubleshooting

- **Sidebar surplus rows don't appear** → no Surplus provider/model is active in this session, or the API key isn't in `auth.json` under a `surplus*` ID.
- **`/surplus-*` commands missing** → opencode wasn't restarted after install, or the plugin isn't in `tui.json`.
- **Floor errors (`minimum_discount_not_met`)** → your `/min{N}` provider is stricter than any current offer; pick a lower tier provider (e.g. `surplus-80` instead of `surplus-95`).

---

## License

MIT — see `LICENSE`.
