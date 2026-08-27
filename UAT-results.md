# UAT Results — opencode-surplus

Recorded live during the guided walkthrough. All fixes installed and re-verified.

Date: 2026-08-27

| # | Test | Result | Notes |
|---|---|---|---|
| T1 | Install & restart | **PASS** | Fresh session after install. |
| T2 | Catalog cached | **PASS** | `sync-models.mjs` → "Discovered 194 models"; cache written. |
| T3 | Models resolve in /models | **PASS** | deepseek-v4-flash appears once, selectable. |
| T4 | /surplus-models dialog | **PASS** | Catalog listed, each model once. |
| T5 | Sidebar floor | **PASS** | On glm-5.3-flash session footer showed `Floor ≥90% (min90)`. |
| T6 | Set floor ≥90%, applies next request | **PASS (re-run)** | Fixed footer staleness: after `/surplus-tier`, footer updates immediately. |
| T7 | Persistence across restart | **PASS** | Floor survived restart. |
| T8 | Floor off | **PASS (re-run)** | Fixed: footer shows `--` immediately on Off. |
| T9 | surplus_settier tool (min 80) | **PASS (re-run)** | Fixed tier-snap: min 80 → floor 80 (was 95). |
| T10 | Flag toggle | **PASS** | Dialog confirms ON/OFF with the new semantics (immediate prompt vs normal fail). |
| T11 | Flag OFF: normal fail | **PASS (re-run)** | Floor ≥95% failed normally — no dialog/toast/change. |
| T12 | Prompt mode dialog | **PASS (re-run)** | Fixed (message extraction + model resolution + offers shape): immediate dialog with recommended tier (≥80). |
| T13 | Prompt adjust + retry | **PASS (re-run)** | Fixed UX: selecting a tier replaces the dialog with a confirmation and re-submits through the new floor (succeeds). |
| T14 | surplus_backoff report | **PASS** | Reports pending tier prompts + mode. |
| T15 | Cooldown (no loop) | **N/A** | Cooldown removed with the retry loop (future work); prompt-mode re-prompts each failure. |
| T16 | Pin filter config | **SKIPPED** | Too complex per user request. |
| T17 | pinnedOnly tool | **SKIPPED** | Same area, skipped. |
| T18 | /surplus-tui disable | **PASS** | Meter, sidebar, and /surplus-* commands disappeared for the session. |
| T19 | Config disable | **SKIPPED** | Per user request (no config-editing tests). |
| T20 | TPS meter | **PASS** | Meter shows TPS/AVG/TTFT while streaming. |
| T21 | Today block | **PASS** | "Today 96.1% off · $0.001/1M · $0.1032". |
| T22 | /surplus-spend | **PASS** | Shows today's + session spend and averages. |
| T23 | /surplus-pin | **PASS** | Picker opened; TUI updated automatically too. |
| T24 | /surplus-status | **PASS** | Shows model, provider, floor ≥90%, pin none, overrides, session stats, best 90.9% off, strictest passing surplus-90. |
