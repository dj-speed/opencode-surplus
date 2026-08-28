# Changelog

All notable changes to **opencode-surplus** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
