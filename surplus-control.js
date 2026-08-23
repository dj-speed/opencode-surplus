// surplus-control.js
// Server-side Surplus Intelligence plugin for opencode.
//
// This is the companion to the TUI plugin `surplus-sidebar.tsx`. It adds
// agent-callable tools and request-body routing controls. Both plugins are
// optional together — the sidebar works without this file, and these tools
// work without the sidebar.
//
// WHAT IT ADDS
//   surplus_offers <model>            — query live marketplace offers + discounts
//   surplus_pin <model> [provider]    — pin/unpin routing to one seller host (persistent)
//   surplus_tier <model>              — recommend the strictest tier provider that passes
//   surplus_spend                     — report actual spending from settled records
//   surplus_clear <model>             — drop all session overrides for a model
//
// INSTALL
//   Drop this file into `~/.config/opencode/plugins/` (create it if needed) and
//   restart opencode. No npm install required. The tools appear automatically.
//
// REQUIREMENTS
//   - You must have a Surplus Intelligence API key stored in opencode's
//     `auth.json` under a provider ID that starts with "surplus" (e.g. from
//     `opencode auth login` after configuring the surplus provider).
//   - The opencode.json provider setup (surplus-70/80/90/95 with the /min{N}
//     base URLs) is recommended but not required for these tools.
//
// HOW PRICING FLOORS WORK (important)
//   Discount floors are enforced by the URL, not the request body. The Surplus
//   API ignores `max_price_per_1m` / `X-Max-Price-Per-1M` entirely (verified
//   live: even 0.0000001 returns 200). The only working mechanism is the
//   `/min{N}` path segment, selected by choosing a provider (`surplus-70`,
//   `surplus-80`, `surplus-90`, `surplus-95`) in opencode.json.
//   `surplus_tier` therefore only recommends providers; it does NOT cap prices
//   on the wire. When a request doesn't meet the floor the API rejects it with
//   `minimum_discount_not_met` — so no client-side watcher/toast is needed.
//
// ROUTING PINS
//   A pin forces a model to one seller host so upstream prompt caches stay warm
//   across calls. Pins are injected into every request body via `chat.params`,
//   layered over the static GLM Z.ai pins below. Pins survive model/tier
//   switches within a session.
//
// NO SECRETS HERE: the API key is never stored in this file; it is read from
// opencode's auth.json at runtime.
//
// PERSISTENT OVERRIDES
//   Live in `~/.local/share/opencode/surplus-control.json` (machine-local,
//   never synced or committed). `surplus_clear` removes a model's entry. The
//   `chat.params` hook re-reads this file on every request, so a pin set from
//   the TUI (`/surplus-pin`) takes effect immediately without a restart.

import { tool } from "@opencode-ai/plugin"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"

const SURPLUS_API = "https://api.surplusintelligence.ai"

// Persistent overrides live here so they survive restarts. Never synced,
// never version-controlled; `surplus_clear` removes entries.
function statePath() {
  return `${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/opencode/surplus-control.json`
}

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"))
  } catch {
    return {}
  }
}

function saveState(state) {
  const p = statePath()
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n")
  renameSync(tmp, p)
}

// EXAMPLE ONLY — not a requirement.
// These are the author's personal routing pins: GLM models are forced to the
// Z.ai "coding" host (a specific discounted marketplace offer) so upstream
// prompt caches stay warm across calls. You almost certainly do NOT want these
// exact pins. Delete this map (pins become fully optional) or replace it with
// your own: key = model ID, value = a seller host base URL ("https://host/v1")
// or a provider family name (e.g. "zai"). Leave it empty and Surplus routes to
// the best healthy seller per request.
// Baseline pins: always applied unless the session overrides them.
const BASE_PINS = {
  "glm-5.2": "https://api.z.ai/api/coding/paas/v4",
  "glm-5.3": "https://api.z.ai/api/coding/paas/v4",
}

function authKey() {
  for (const base of [
    process.env.XDG_DATA_HOME,
    `${homedir()}/.local/share`,
  ]) {
    const p = base && `${base}/opencode/auth.json`
    if (!p || !existsSync(p)) continue
    try {
      const auth = JSON.parse(readFileSync(p, "utf8"))
      for (const [id, v] of Object.entries(auth))
        if (id.startsWith("surplus") && v?.key) return v.key
    } catch {}
  }
  return undefined
}

async function markets(model) {
  const key = authKey()
  if (!key) throw new Error("no surplus key found in auth.json")
  const res = await fetch(`${SURPLUS_API}/api/markets/${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!res.ok) throw new Error(`markets API returned ${res.status}`)
  return res.json()
}

function summarizeOffers(offers) {
  const rows = (offers ?? [])
    .filter((o) => o.available && o.healthy && o.direct_input_per_1m > 0)
    .map((o) => ({
      provider: o.provider,
      host: o.seller_base_url,
      // markets API prices are in millionths of a USD per 1M tokens
      input_usd_per_1m: o.price_input_per_1m / 1_000_000,
      discount_pct: Math.round((1 - o.price_input_per_1m / o.direct_input_per_1m) * 1000) / 10,
    }))
  const seen = new Set()
  return rows.filter((r) => !seen.has(r.host + r.input_usd_per_1m) && seen.add(r.host + r.input_usd_per_1m))
}

export const SurplusControlPlugin = async ({ client }) => {
  // modelID -> { pin?: string | null, maxPrice?: number } — persisted across restarts
  const session = loadState()
  const persist = () => saveState(session)

  // Pricing cache for native cost displays. Refreshed in the BACKGROUND ONLY -
  // never inside the config hook (async/network work there hangs startup).
  // Boot 1 after install: no prices yet. Every later boot: applied instantly
  // from disk via a synchronous read.
  const refreshPricingInBackground = () => {
  ;(async () => {
    try {
    let cfg
    try {
      cfg = JSON.parse(
        readFileSync(`${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/opencode/opencode.json`, "utf8")
      )
    } catch {
      return
    }
    const out = {}
    await Promise.all(
      Object.entries(cfg.provider ?? {})
        .filter(([pid]) => pid.startsWith("surplus"))
        .flatMap(([pid, p]) =>
          Object.keys(p.models ?? {}).map(async (mid) => {
            try {
              const ok = ((await markets(mid)).offers ?? []).filter(
                (o) => o.available && o.healthy && o.price_output_per_1m > 0
              )
              if (!ok.length) return
              const best = ok.reduce((a, b) => (b.price_input_per_1m < a.price_input_per_1m ? b : a))
                out[`${pid}/${mid}`] = {
                  input: best.price_input_per_1m / 1e6,
                  output: best.price_output_per_1m / 1e6,
                  cache_read: best.price_input_per_1m / 1e7,
                }
            } catch {}
          })
        )
    )
    if (Object.keys(out).length) {
      const p = `${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/opencode/surplus-pricing.json`
      const tmp = `${p}.tmp`
      writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n")
      renameSync(tmp, p)
    }
    } catch {}
  })()
  }
  refreshPricingInBackground()

  return {
    config: (cfg) => {
      let cache
      try {
        cache = JSON.parse(
          readFileSync(`${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/opencode/surplus-pricing.json`, "utf8")
        )
      } catch {
        return
      }
      for (const [key, cost] of Object.entries(cache)) {
        const [pid, ...rest] = key.split("/")
        const model = cfg.provider?.[pid]?.models?.[rest.join("/")]
        if (model) model.cost = { ...(model.cost ?? {}), ...cost }
      }
      // Provider IDs can change when a model is moved between discount tiers.
      // Reuse a cached model price until the next background refresh completes.
      const byModel = {}
      for (const [key, cost] of Object.entries(cache)) byModel[key.slice(key.indexOf("/") + 1)] = cost
      for (const [pid, provider] of Object.entries(cfg.provider ?? {})) {
        if (!pid.startsWith("surplus")) continue
        for (const [mid, model] of Object.entries(provider.models ?? {})) {
          if (!model.cost && byModel[mid]) model.cost = byModel[mid]
        }
      }
    },

    "chat.params": async (input, output) => {
      const modelID = input.model?.modelID ?? input.model?.api?.id
      if (!modelID) return
      // Re-read from disk each request so TUI-side pin writes (via /surplus-pin)
      // take effect immediately without a restart.
      const o = loadState()[modelID] ?? {}
      const patch = {}
      const pin = o.pin !== undefined ? o.pin : BASE_PINS[modelID]
      if (pin) patch[/^https?:\/\//.test(pin) ? "provider_base_url" : "provider"] = pin
      if (!Object.keys(patch).length) return
      output.options = { ...output.options, ...patch }
    },

    tool: {
      surplus_offers: tool({
        description:
          "Query the Surplus Intelligence marketplace for live seller offers of a model. Returns healthy sellers with estimated discount percentages. Use before choosing a tier (minNN) or pin target.",
        args: {
          model: tool.schema.string().describe("Model ID, e.g. kimi-k3"),
        },
        async execute(args) {
          const data = await markets(args.model)
          const rows = summarizeOffers(data.offers)
          if (!rows.length) return `No healthy offers for ${args.model} right now.`
          const best = rows.reduce((a, b) => (b.discount_pct > a.discount_pct ? b : a))
          return [
            `Healthy offers for ${args.model} (best estimated discount: ${best.discount_pct}%):`,
            ...rows.map((r) => `- ${r.provider} ${r.host} — $${r.input_usd_per_1m}/1M in (~${r.discount_pct}% off)`),
            `\nHighest tier that passes: min${Math.floor(best.discount_pct)}. Pin a host with surplus_pin.`,
          ].join("\n")
        },
      }),

      surplus_pin: tool({
        description:
          "Pin (or unpin) Surplus routing for a model to a single seller host persistently. Keeps upstream prompt cache stable across requests and tier switches. Pass an empty provider to reset to the baseline.",
        args: {
          model: tool.schema.string().describe("Model ID, e.g. glm-5.2"),
          provider: tool.schema.string().optional().describe(
            "Seller host base URL (https://host/v1) or provider family name (e.g. zai). Omit to reset."
          ),
        },
        async execute(args) {
          const reset = args.provider === undefined || args.provider === ""
          const pin = reset ? BASE_PINS[args.model] : args.provider
          session[args.model] = { ...session[args.model], pin }
          persist()
          return pin
            ? `Pinned ${args.model} -> ${pin} for this session.`
            : `Cleared pin for ${args.model}; no baseline pin applies.`
        },
      }),

      surplus_tier: tool({
        description:
          "Report the strictest minimum-discount tier that currently passes for a model by querying live offers. The floor is enforced by the provider's /min{N} URL, so this recommends which provider to select rather than changing the wire request. Example: min 80 means the surplus-80 provider works when offers are >=80% off.",
        args: {
          model: tool.schema.string().describe("Model ID, e.g. kimi-k3"),
          min: tool.schema.number().describe("Minimum discount percent, 0-100, e.g. 80"),
        },
        async execute(args) {
          if (!(args.min >= 0 && args.min <= 100)) throw new Error("min must be 0-100")
          const data = await markets(args.model)
          const rows = summarizeOffers(data.offers)
          if (!rows.length) return `No healthy offers for ${args.model} right now.`
          const best = rows.reduce((a, b) => (b.discount_pct > a.discount_pct ? b : a))
          const tiers = [95, 90, 80, 70].filter((t) => t >= args.min)
          const passing = tiers.find((t) => best.discount_pct >= t)
          return [
            `Best offer for ${args.model}: ${best.discount_pct}% off (${best.provider} ${best.host}).`,
            passing
              ? `The surplus-${passing} provider passes (>=${passing}%).`
              : `No tier >= ${args.min}% currently passes for ${args.model}.`,
            `Strictest provider that works right now: surplus-${Math.floor(best.discount_pct / 10) * 10}.`,
            `Select the provider in opencode (surplus-70/80/90/95) to enforce the floor via the /min{N} URL.`,
          ].join("\n")
        },
      }),

      surplus_spend: tool({
        description:
          "Report actual Surplus spending: wallet balance, total spend, savings vs direct pricing, and per-model breakdown, from settled usage records.",
        args: {},
        async execute() {
          const key = authKey()
          if (!key) throw new Error("no surplus key found in auth.json")
          const get = async (path) => {
            const res = await fetch(`${SURPLUS_API}${path}`, { headers: { Authorization: `Bearer ${key}` } })
            if (!res.ok) throw new Error(`${path} returned ${res.status}`)
            return res.json()
          }
          const [me, savings] = await Promise.all([get("/v1/buyer/me"), get("/v1/buyer/savings")])
          const fmt = (v) => (typeof v === "number" ? `$${v.toFixed(4)}` : JSON.stringify(v))
          const lines = []
          for (const [k, v] of Object.entries(me ?? {}))
            if (/balance|spend|usage|cost|total/i.test(k)) lines.push(`${k}: ${fmt(v)}`)
          for (const [k, v] of Object.entries(savings ?? {}))
            if (/saving|direct/i.test(k)) lines.push(`savings.${k}: ${fmt(v)}`)
          if (me?.models || me?.per_model) {
            const pm = me.models ?? me.per_model
            for (const [m, v] of Object.entries(pm)) lines.push(`  ${m}: ${typeof v === "object" ? fmt(v.cost_usd ?? v.total_cost ?? v.spend) : fmt(v)}`)
          }
          return lines.length ? lines.join("\n") : `raw: ${JSON.stringify({ me, savings }).slice(0, 1500)}`
        },
      }),

      surplus_clear: tool({
        description: "Remove all session overrides (pin, max price) for a model.",
        args: {
          model: tool.schema.string().describe("Model ID, e.g. kimi-k3"),
        },
        async execute(args) {
          delete session[args.model]
          persist()
          return `Cleared session overrides for ${args.model}.`
        },
      }),
    },
  }
}
