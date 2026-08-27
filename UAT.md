# opencode-surplus — Feature Guide & UAT

Complete instructions for every feature shipped in this version, followed by a
**User Acceptance Test** for signoff.

---

## 1. Prerequisites

- opencode ≥ 1.18.x, restarted after install.
- A Surplus Intelligence API key in opencode (`opencode auth login`, provider ID
  starting with `surplus`) — read from `auth.json`, never stored in the plugin.
- A `surplus` provider in `opencode.json` (the config hook fills it with the
  discovered catalog and points it at the local floor proxy):

  ```jsonc
  { "provider": { "surplus": {
      "name": "Surplus Intelligence",
      "npm": "@ai-sdk/openai-compatible",
      "options": {},
      "models": { "deepseek-v4-flash": { "name": "DeepSeek V4 Flash" } }
  } } }
  ```

  > If you already have `surplus-70/80/90/95` tier providers from an earlier
  > setup, leave them — they still work as floor shortcuts, and catalog models
  > you've placed there are skipped from the catalog so nothing is listed twice.

- Installed via `./install.sh` (copies `surplus-sidebar.tsx`,
  `surplus-control.js`, `sync-models.mjs` into `~/.config/opencode/`).

> If you're upgrading from an older install, re-run `./install.sh` and restart.

---

## 2. Feature instructions

### 2.1 Model discovery (scrape models)

The catalog is scraped from `…/api/inference/v1/models` and cached to
`~/.cache/opencode/models-surplus.json`. The plugin loads the cache **before**
provider resolution (so models resolve immediately) and refreshes it **in the
background at startup**.

| Surface | What it does |
|---|---|---|
| Startup (automatic) | Background scrape + cache write + merge into the single `surplus` provider |
| `node sync-models.mjs` | Manual scrape + cache (**text-output models only**) |
| `node sync-models.mjs --write-config` | Scrape **and** write the model list into provider `surplus` in `opencode.json` |
| `node sync-models.mjs --query gpt` | List matching models with live discounts |
| `/surplus-models` | TUI: list the cached catalog (25 shown) |
| `surplus_models` (agent tool) | Same, with a `query`/`limit`, annotated with best discount |

Expected: 150–250 text-output models cached, each listed **once** in the single
"Surplus Intelligence" group. After restart, catalog models resolve (no more
`Model not found` for marketplace models).

### 2.2 Discount floors / tiers

Floors are enforced by the `/min{N}` **URL** (Surplus ignores body caps). All
discovered models live in **one `surplus` catalog provider** (each listed once)
whose baseURL points at a **local floor proxy** the plugin runs. On every request
the proxy routes the model to `…/min{floor}/v1`, so floor changes are instant.

| Surface | What it does |
|---|---|
| `/surplus-tier` | Picker: set floor for the active model (off / ≥70 / ≥80 / ≥90 / ≥95). Persists; **applies to the next request** |
| `surplus_settier { model, min }` | Same, agent-callable. `min` 0-95; values snap up (65 → 70) |
| Sidebar footer | Shows ONE floor: `≥90% (min90)` |
| `/surplus-status` | Shows the single floor + provider |

Floors persist in `~/.local/share/opencode/surplus-control.json` and are read by
the proxy on every request. (Legacy `surplus-70/80/90/95` tier providers you've
configured still work as immediate floor shortcuts.)

### 2.3 Floor-failure prompt (backoff-prompt mode)

When a request fails with `minimum_discount_not_met`, the floor proxy annotates
the error so the plugin reliably detects it. The behavior depends on the mode.

| Surface | Behavior |
|---|---|
| Flag OFF (default) | The failure is surfaced normally — no prompt, no automatic floor change |
| Flag ON (`/surplus-flag yes` or `surplus_flag {enabled:true}`) | **Immediately** raises a dialog to **adjust the discount tier** — it recommends the strictest tier below the current floor that live offers pass, plus the other tiers and off; picking one persists it and re-submits your last message through the new floor |
| `/surplus-flag` | Toggle the mode |
| `surplus_backoff` | Report/clear pending tier prompts + mode (`{clear:true}`) |

An automatic retry loop (re-driving a failed request with backoff) is planned
future work.

### 2.4 Offer filtering by pin

| Surface | Behavior |
|---|---|
| `offers.filterByPin: true` (tui.json option) | Sidebar + `/surplus-offers` show only offers matching the model's routing pin (host URL or provider family) |
| `surplus_offers { pinnedOnly: true }` | Same, agent-side |

Pins come from `/surplus-pin` or `BASE_PINS` in `surplus-control.js`.

### 2.5 TUI integration toggle

| Surface | Behavior |
|---|---|
| `"enabled": false` in the tui.json plugin tuple | Skips meter/sidebar/commands entirely (restart to apply) |
| `/surplus-tui` | Disables the TUI integration for the current session (self-deactivates; re-enable via `/plugins` or config) |

---

## 3. UAT — signoff checklist

Run each test in a fresh opencode session. Expected results are in **bold**.
Mark **[PASS]**/**[FAIL]**; add notes.

### 3.1 Install & model discovery

- [ ] **T1 — Install.** `./install.sh` succeeds; restart opencode.
- [ ] **T2 — Catalog cached.** `node sync-models.mjs` prints **"Discovered N models"** (N ≥ 100, **text-output models only** — image/video/audio-only excluded) and writes `~/.cache/opencode/models-surplus.json`.
- [ ] **T3 — Models resolve.** Open `/models`; search a catalog model (e.g. `deepseek-v4-flash`). **It appears once, under the single "Surplus Intelligence" group, and is selectable.**
- [ ] **T4 — `/surplus-models`.** Runs `/surplus-models`. **Dialog lists the cached catalog (each model once**, active model marked `*`).

### 3.2 Tiers / floors

- [ ] **T5 — Sidebar floor.** On a session using a surplus model, sidebar footer shows **`Floor ≥NN% (minNN)`** (or `--`).
- [ ] **T6 — Set floor.** `/surplus-tier` → pick `≥90%`. **Dialog confirms the floor is saved and "Applies to the next request"; `/surplus-status` shows `≥90%`.** Send a prompt — **it routes through the `/min90` URL** (no restart).
- [ ] **T7 — Persistence.** `/surplus-status` shows the stored floor. Restart opencode → **floor still applied**.
- [ ] **T8 — Off.** `/surplus-tier` → "Off". **Floor shows `off` / `--`; the next request uses no floor.**
- [ ] **T9 — `surplus_settier` tool.** Ask the agent to call `surplus_settier` for the active model (`min: 80`). **It reports the new floor and that it applies to the next request.**

### 3.3 Floor-failure prompt

- [ ] **T10 — Flag toggle.** `/surplus-flag` → ON. **Dialog confirms "Backoff-prompt mode: ON" (immediately prompts to adjust the discount tier on a floor failure).** Set back to OFF after.
- [ ] **T11 — Flag OFF (normal fail).** `/surplus-flag` → OFF, set a floor stricter than current offers (e.g. `≥95%`) via `/surplus-tier`, send a prompt. **The request fails with a normal error message — no dialog, no toast, no floor change.**
- [ ] **T12 — Prompt mode (flag ON).** `/surplus-flag` → ON, set `≥95%`, send a prompt. **A dialog appears promptly (no ~60s wait): "Discount floor ≥95% not met" with a RECOMMENDED tier option (the passing tier from live offers, e.g. ≥90%), plus the other tiers and "Off".**
- [ ] **T13 — Prompt adjust + retry.** In that dialog pick a tier. **The floor is saved and your last message is re-submitted through the new floor.**
- [ ] **T14 — `surplus_backoff`.** Ask the agent to call `surplus_backoff`. **Reports pending tier prompts + mode.**
- [ ] **T15 — N/A.** The cooldown logic was removed with the retry loop; prompt-mode failures re-prompt each time (no automatic adjustments to loop).

### 3.4 Pin filtering

- [ ] **T16 — Pin filter config.** Add `"offers": { "filterByPin": true }` to the tui.json plugin tuple, restart. On a pinned model, `/surplus-offers` shows **only pin-matching sellers**, labeled "(filtered to pin)".
- [ ] **T17 — `pinnedOnly` tool.** `surplus_offers` with `pinnedOnly: true`. **Only pin-matching offers.**

### 3.5 TUI toggle

- [ ] **T18 — `/surplus-tui`.** Run `/surplus-tui` → confirm. **Meter, sidebar blocks, and `/surplus-*` commands disappear for this session.**
- [ ] **T19 — Config disable.** Set `"enabled": false` in the tui.json plugin tuple, restart. **No surplus TUI elements or commands; agent tools still work.**

### 3.6 Regression (existing features still work)

- [ ] **T20 — TPS meter.** Type/prompt a surplus model. **Meter shows TPS/AVG/TTFT while streaming.**
- [ ] **T21 — Today block.** Sidebar top shows **Today's blended $/1M, % off, spend**.
- [ ] **T22 — `/surplus-spend`.** Shows **today's + this session's spend and averages**.
- [ ] **T23 — `/surplus-pin`.** Picker opens with offers + baseline/clear/custom options.
- [ ] **T24 — `/surplus-status`.** Shows **model, provider, floor, pin, overrides, best discount, session stats**.

---

## 4. Signoff

| Area | Result | Sign-off |
|---|---|---|
| Model discovery (T1–T4) | PASS / FAIL | |
| Tiers / floors (T5–T9) | PASS / FAIL | |
| Floor-failure prompt (T10–T15) | PASS / FAIL | |
| Pin filtering (T16–T17) | PASS / FAIL | |
| TUI toggle (T18–T19) | PASS / FAIL | |
| Regression (T20–T24) | PASS / FAIL | |

**Overall decision:** APPROVE / REJECT with comments

Signed: ______________________  Date: ______________

---

## 5. Troubleshooting

- **"surplus models isn't scraping"** → Surplus's edge compresses with Brotli,
  which Node's undici can't decode. Fixed via `Accept-Encoding: identity` on
  every API call (all files). Verify: `node sync-models.mjs` prints a count.
- **No surplus rows in the sidebar** → no surplus provider/model active, or no
  key in `auth.json`.
- **`/surplus-*` missing** → not restarted after install, not in `tui.json`, or
  `enabled: false`.
- **Duplicate rows per model in the picker** → the catalog lives once in the `surplus` provider; models you explicitly configured in `surplus-70/80/90/95` tier providers appear once per tier (that's the floor shortcut) and are skipped from the catalog.
- **Floor changes don't apply immediately** → floors are applied by the local
  floor proxy, which reads the model's floor from `surplus-control.json` on every
  request. If the proxy isn't running (check for a `127.0.0.1:<port>` baseURL on
  the `surplus` provider), restart opencode.
