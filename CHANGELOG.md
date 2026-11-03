# Changelog

All notable changes to **opencode-surplus** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v2.0.0] - 2026-11-03

This release moves the plugin to OpenCode 2 (tested on 2.2.5). The old 1.x plugin doesn't run on OpenCode 2, so if you're still on 1.x, stay on `v1.1.0`.

### Changed

The two old plugin files are now one folder, `surplus/`. OpenCode finds it on its own in `~/.config/opencode/plugins/surplus/`, so you no longer need an entry in `tui.json` or `cli.json`.

Your API key now comes from OpenCode itself (set it with `/connect`) instead of being read from `auth.json`. In OpenCode 2 only the server side of a plugin can see credentials, so all calls to Surplus happen there and the sidebar asks the server for what it needs.

Discount floors no longer need the little local proxy. The plugin points each request at the right Surplus address directly. A new floor still kicks in on your next message. Pins and the "floor not met" pop-up work the same as before, just wired up differently under the hood.

All Surplus models now appear under the one `surplus-intelligence` provider, with their real context limits, tool support and prices. The separate `surplus-70`, `surplus-80`, `surplus-90` and `surplus-95` providers are gone. Use `/surplus-tier` to set a floor instead.

Your pins, floors and settings are stored by OpenCode now, not in `surplus-control.json`, `surplus-rates.json` and `surplus-pricing.json`. They don't carry over, so set them again after upgrading.

`sync-models.mjs` no longer needs `--write-config` or `--pricing`, because the plugin handles both itself. `--query` reads your key from `SURPLUS_API_KEY`.

`/surplus-tui` now hides or shows the meter and sidebar until you restart, rather than turning the plugin off, because OpenCode 2 doesn't let a plugin switch itself off.

## [v1.1.0] - 2026-08-28

### Fixed

- **Session spend for discovered models.** The background pricing refresh now prices **every** discovered catalog model (writes `surplus/<model>` keys) instead of only the few models you had explicitly configured, gated by a 15-minute TTL to bound API calls. The `config` hook applies the pricing cache **after** the catalog merge, so models in the discovered `surplus` provider get a real `model.cost` — previously their session spend showed $0.
- **`sync-models.mjs --write-config` no longer duplicates models.** It now mirrors the runtime config hook and skips catalog models that already live in a `surplus-70/80/90/95` tier provider, so writing the catalog into `opencode.json` never lists the same model twice in the picker.

### Added

- **`sync-models.mjs --pricing`** — seed/refresh `surplus-pricing.json` (the cache opencode uses to report session costs) from the command line, for first setup or CI.

### Changed

- The on-disk catalog persists into `opencode.json` (provider `surplus`), so the model list is present even if the plugin is ever removed — discovery no longer has to be the only thing keeping the list alive.

## [v1.0.0] - 2026-08-27

Initial feature-complete release.

### Added

- **Single `surplus` provider** — every marketplace model listed once (~194 text-output models), discovered automatically.
- **Local floor proxy** — the provider routes through a per-request proxy, so discount-floor changes apply to the **next request** with no opencode restart.
- **Floor-failure prompt mode** — with `/surplus-flag yes`, a `minimum_discount_not_met` failure immediately shows a dialog with a **recommended tier** (the strictest one that currently passes); picking it re-routes your next request. Flag off → failures fail normally.
- **Live TPS meter**, **Today spend block**, and **routing status** (floor, top offers, pin, session totals) in the sidebar.
- **`/surplus-*` TUI commands** — instant, free, no LLM round-trip: `status`, `offers`, `tier`, `flag`, `models`, `spend`, `pin`, `clear`, `tui`.
- **`surplus_*` agent tools** — `surplus_models`, `surplus_offers`, `surplus_pin`, `surplus_tier`, `surplus_settier`, `surplus_flag`, `surplus_backoff`, `surplus_spend`, `surplus_clear`.
- **`sync-models.mjs`** — manual catalog scrape (`--write-config`, `--query`).
- **UAT** (T1–T24) recorded in `UAT-results.md`; benchmark design in `BENCHMARKS.md`.
- **One-command installer** (`install.sh`) for the TUI + server plugins.

### Notes

- No API keys or secrets in this package; the key is read from `auth.json` at runtime.
- An automatic retry loop (re-driving a failed request with backoff) is planned future work.

[v1.1.0]: https://github.com/dj-speed/opencode-surplus/releases/tag/v1.1.0
[v1.0.0]: https://github.com/dj-speed/opencode-surplus/releases/tag/v1.0.0
