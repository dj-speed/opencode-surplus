// index.js — server part of the Surplus Intelligence plugin for OpenCode V2.
//
// Loaded automatically from ~/.config/opencode/plugins/surplus/. The TUI part
// (tui.tsx, same directory) talks to this file through the RPC in rpc.js.
//
// WHAT IT DOES
//   • Model discovery: scrapes the Surplus catalog (text-output models only),
//     caches it in ~/.cache/opencode/models-surplus.json, and publishes it as
//     the model inventory of the Surplus provider (default ID
//     "surplus-intelligence"; override with the `providerID` plugin option).
//   • Pricing: every model is priced from (best first) the rates calibrated
//     from settled usage, the cheapest live marketplace offer, then the
//     catalog list price — so OpenCode's native "spent" numbers are realistic.
//   • Discount floors: the floor is the /min{N} path of the request URL. A
//     `model.request` hook rewrites the base URL per request, so changing a
//     floor applies to the very next request (no proxy, no restart).
//   • Routing pins: an `http.request` hook injects `provider` /
//     `provider_base_url` into the request body for the pinned seller.
//   • Floor-failure prompt: an `http.response` hook marks floor/price-gate
//     failures with `minimum_discount_not_met` and, with backoff-prompt mode
//     ON, emits an RPC `floor` event the TUI turns into a tier dialog.
//   • Agent tools: surplus_offers, surplus_pin, surplus_tier, surplus_settier,
//     surplus_flag, surplus_models, surplus_backoff, surplus_spend, surplus_clear.
//
// NO SECRETS HERE: the API key is read from OpenCode's credential store at
// runtime (the connection for the Surplus provider). Settings live in the
// plugin's own storage (ctx.storage), never in this file.

import { Model, Plugin, Provider } from "@opencode/plugin"
import { discoverModels, loadModelsCache, saveModelsCache } from "./catalog.js"
import { SurplusRpc } from "./rpc.js"

const SURPLUS_API = "https://api.surplusintelligence.ai"

// Discount floor tiers, strictest first.
const TIERS = [95, 90, 80, 70]

// Floor/price-gate failure text (annotated marker, raw Surplus wording, 402).
const FLOOR_ERROR_RE = /minimum_discount_not_met|no marketplace sellers currently meet|meet the minimum.*(discount|off)|estimated discount|x402|402/i

const PRICING_TTL_MS = 15 * 60 * 1000
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000
const MARKET_CONCURRENCY = 8

// EXAMPLE ONLY — the author's personal routing pins (GLM -> Z.ai coding host)
// so upstream prompt caches stay warm. Replace or empty this map; with no pin
// Surplus routes each request to the best healthy seller.
export const BASE_PINS = {
  "glm-5.2": "https://api.z.ai/api/coding/paas/v4",
  "glm-5.3": "https://api.z.ai/api/coding/paas/v4",
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// "surplus/glm-5.3" -> "glm-5.3", so every layer addresses the same key.
function normalizeModelID(id) {
  if (typeof id !== "string") return id
  const slash = id.indexOf("/")
  return slash > 0 ? id.slice(slash + 1) : id
}

function nextLowerTier(from) {
  return TIERS.find((t) => t < (from ?? Infinity)) ?? null
}

function summarizeOffers(offers) {
  const list = Array.isArray(offers) ? offers : (offers?.offers ?? [])
  const rows = list
    .filter((o) => o.available && o.healthy && o.direct_input_per_1m > 0)
    .map((o) => ({
      provider: o.provider,
      host: o.seller_base_url,
      // markets API prices are millionths of a USD per 1M tokens
      input_usd_per_1m: o.price_input_per_1m / 1_000_000,
      discount_pct: Math.round((1 - o.price_input_per_1m / o.direct_input_per_1m) * 1000) / 10,
    }))
  const seen = new Set()
  return rows.filter((r) => !seen.has(r.host + r.input_usd_per_1m) && seen.add(r.host + r.input_usd_per_1m))
}

function bestDiscountPct(offers) {
  const rows = summarizeOffers(offers)
  if (!rows.length) return undefined
  return rows.reduce((a, b) => (b.discount_pct > a.discount_pct ? b : a)).discount_pct
}

function filterRowsByPin(rows, pin) {
  if (!pin) return rows
  const isURL = /^https?:\/\//.test(pin)
  const host = isURL ? new URL(pin).hostname : undefined
  return rows.filter((r) => {
    if (isURL) {
      try {
        return new URL(r.host).hostname === host
      } catch {
        return false
      }
    }
    const p = pin.toLowerCase()
    return (r.provider ?? "").toLowerCase().includes(p) || (r.host ?? "").toLowerCase().includes(p)
  })
}

// Run `fn` over `items` with at most `limit` in flight.
async function mapLimit(items, limit, fn) {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "surplus",
  async setup(ctx) {
    const PID = typeof ctx.options.providerID === "string" ? ctx.options.providerID : "surplus-intelligence"
    const controller = new AbortController()
    const timers = []

    // ---- persisted settings (plugin storage) ------------------------------
    const getOverrides = async () => (await ctx.storage.get("overrides")) ?? {}
    const getFlags = async () => (await ctx.storage.get("flags")) ?? {}
    const getCalibration = async () => (await ctx.storage.get("calibration")) ?? { rates: {}, pairs: {} }
    const getPricing = async () => (await ctx.storage.get("pricing")) ?? { at: 0, costs: {} }

    let rpc
    const emitChanged = async () => {
      try {
        await rpc?.events.emit("changed", {})
      } catch {}
    }
    const mutateOverrides = async (fn) => {
      const o = await getOverrides()
      fn(o)
      await ctx.storage.set("overrides", o)
      await emitChanged()
      return o
    }
    const activePin = async (model) => {
      const o = (await getOverrides())[model] ?? {}
      return o.pin !== undefined ? o.pin : BASE_PINS[model]
    }

    // ---- credentials & Surplus API ----------------------------------------
    const apiKey = async () => {
      const connection = await ctx.integration.connection.active(PID).catch(() => undefined)
      if (!connection) return undefined
      const credential = await ctx.integration.connection.resolve(connection).catch(() => undefined)
      return credential?.type === "key" ? credential.key : undefined
    }
    const surplusGet = async (path, { text = false, signal } = {}) => {
      const key = await apiKey()
      if (!key) throw new Error(`no Surplus API key: connect the "${PID}" provider first (/connect)`)
      const res = await fetch(`${SURPLUS_API}${path}`, {
        signal,
        headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
      })
      if (!res.ok) throw new Error(`${path} returned ${res.status}`)
      return text ? res.text() : res.json()
    }
    const markets = (model, signal) => surplusGet(`/api/markets/${encodeURIComponent(model)}`, { signal })

    // ---- model inventory ---------------------------------------------------
    // Captured inputs for the provider transform; refreshed in the background
    // and applied with ctx.provider.reload().
    const source = {
      catalog: loadModelsCache(),
      pricing: (await getPricing()).costs ?? {},
      rates: (await getCalibration()).rates ?? {},
    }

    const costFor = (id, entry) => {
      const r = source.rates[id]
      if (typeof r?.fresh === "number" && typeof r?.cache === "number" && typeof r?.out === "number") {
        return { input: r.fresh, output: r.out, cache: { read: r.cache, write: r.fresh } }
      }
      const p = source.pricing[id]
      if (p) return { input: p.input, output: p.output, cache: { read: p.cacheRead, write: p.input } }
      const c = entry.cost
      if (c) return { input: c.input, output: c.output, cache: { read: c.cacheRead, write: c.cacheWrite } }
      return undefined
    }

    const buildModels = () => {
      const providerID = Provider.ID.make(PID)
      return Object.values(source.catalog).map((entry) => {
        const base = Model.Info.default(providerID, Model.ID.make(entry.id))
        const cost = costFor(entry.id, entry)
        const context = Number.isInteger(entry.context) && entry.context > 0 ? entry.context : base.limit.context
        const output = Number.isInteger(entry.output) && entry.output > 0 ? Math.min(entry.output, context) : Math.min(base.limit.output, context)
        return {
          ...base,
          name: entry.name ?? entry.id,
          capabilities: {
            ...base.capabilities,
            tools: entry.tools ?? base.capabilities.tools,
            input: Array.isArray(entry.input) && entry.input.length ? entry.input : ["text"],
          },
          cost: cost ? [cost] : [],
          limit: { context, output },
        }
      })
    }

    await ctx.provider.transform((editor) => {
      if (!Object.keys(source.catalog).length) return
      const models = buildModels()
      if (editor.get(PID)) {
        editor.models.set(PID, models)
      } else {
        editor.add({
          info: {
            ...Provider.Info.empty(Provider.ID.make(PID)),
            name: "Surplus Intelligence",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `${SURPLUS_API}/v1` },
          },
          models,
        })
      }
    })

    const refreshCatalog = async () => {
      const models = await discoverModels(controller.signal)
      if (!Object.keys(models).length) return
      saveModelsCache(models)
      source.catalog = models
      await ctx.provider.reload()
    }

    const refreshPricing = async () => {
      const current = await getPricing()
      if (Date.now() - (current.at ?? 0) < PRICING_TTL_MS) return
      if (!(await apiKey())) return
      const costs = {}
      await mapLimit(Object.keys(source.catalog), MARKET_CONCURRENCY, async (id) => {
        try {
          const ok = ((await markets(id, controller.signal)).offers ?? []).filter(
            (o) => o.available && o.healthy && o.price_output_per_1m > 0,
          )
          if (!ok.length) return
          const best = ok.reduce((a, b) => (b.price_input_per_1m < a.price_input_per_1m ? b : a))
          costs[id] = {
            input: best.price_input_per_1m / 1e6,
            output: best.price_output_per_1m / 1e6,
            cacheRead: best.price_input_per_1m / 1e7,
          }
        } catch {}
      })
      if (!Object.keys(costs).length) return
      await ctx.storage.set("pricing", { at: Date.now(), costs })
      source.pricing = costs
      await ctx.provider.reload()
    }

    // Background refresh at startup: catalog first (pricing iterates it).
    void refreshCatalog()
      .catch(() => {})
      .then(() => refreshPricing())
      .catch(() => {})
    timers.push(setInterval(() => void refreshCatalog().catch(() => {}), CATALOG_TTL_MS))
    timers.push(setInterval(() => void refreshPricing().catch(() => {}), PRICING_TTL_MS))

    // ---- request hooks: floors, pins, floor-failure detection ---------------
    await ctx.session.hook(
      "model.request",
      async (event) => {
        const model = normalizeModelID(event.model.id)
        const floor = (await getOverrides())[model]?.floor ?? 0
        if (floor > 0) event.baseURL = `${SURPLUS_API}/min${floor}/v1`
      },
      { providerID: PID },
    )

    await ctx.session.hook(
      "http.request",
      async (event) => {
        const pin = await activePin(normalizeModelID(event.model.id))
        if (!pin) return
        const req = event.request
        if (!/json/i.test(req.headers.get("content-type") ?? "")) return
        let body
        try {
          body = JSON.parse(await req.clone().text())
        } catch {
          return
        }
        if (!body || typeof body !== "object") return
        body[/^https?:\/\//.test(pin) ? "provider_base_url" : "provider"] = pin
        const headers = new Headers(req.headers)
        headers.delete("content-length")
        event.request = new Request(req.url, {
          method: req.method,
          headers,
          body: JSON.stringify(body),
          signal: req.signal,
        })
      },
      { providerID: PID },
    )

    const recentFloorEvents = new Map()
    const reportFloorFailure = async (sessionID, model) => {
      if (!((await getFlags()).backoffPrompt ?? false)) return
      const key = `${sessionID}:${model}`
      if (Date.now() - (recentFloorEvents.get(key) ?? 0) < 60_000) return
      recentFloorEvents.set(key, Date.now())
      const currentTier = (await getOverrides())[model]?.floor ?? null
      const best = await markets(model)
        .then(bestDiscountPct)
        .catch(() => undefined)
      const targetTier =
        best === undefined
          ? nextLowerTier(currentTier)
          : (TIERS.find((t) => t < (currentTier ?? Infinity) && best >= t) ?? null)
      await rpc?.events.emit("floor", { sessionID, model, currentTier, targetTier })
    }

    await ctx.session.hook(
      "http.response",
      async (event) => {
        const res = event.response
        if (res.status < 400) return
        const text = await res.clone().text().catch(() => "")
        const floorGate = res.status === 402 || /discount|minimum|floor|x402|payment/i.test(text)
        if (!floorGate) return
        let body = text
        let message = text || "discount floor not met"
        try {
          const parsed = JSON.parse(text)
          const err = parsed?.error
          if (typeof err?.message === "string") message = err.message
          else if (typeof err === "string") message = err
          else if (typeof parsed?.code === "string") message = parsed.code
          if (!/minimum_discount_not_met/.test(message)) message = `minimum_discount_not_met: ${message}`
          parsed.error = { ...(err && typeof err === "object" ? err : {}), message }
          body = JSON.stringify(parsed)
        } catch {
          body = JSON.stringify({ error: { message: `minimum_discount_not_met: ${message}` } })
        }
        const headers = new Headers(res.headers)
        headers.delete("content-length")
        headers.delete("content-encoding")
        event.response = new Response(body, { status: res.status, statusText: res.statusText, headers })
        if (FLOOR_ERROR_RE.test(message)) void reportFloorFailure(event.sessionID, normalizeModelID(event.model.id)).catch(() => {})
      },
      { providerID: PID },
    )

    // ---- RPC for the TUI part ---------------------------------------------
    const parseSettled = (csv) => {
      const fields = (line) => {
        const out = []
        let field = ""
        let quoted = false
        for (let i = 0; i < line.length; i++) {
          const ch = line[i]
          if (ch === '"') {
            if (quoted && line[i + 1] === '"') {
              field += '"'
              i++
              continue
            }
            quoted = !quoted
          } else if (ch === "," && !quoted) {
            out.push(field)
            field = ""
          } else field += ch
        }
        out.push(field)
        return out
      }
      const lines = csv.trim().split(/\r?\n/)
      if (lines.length < 2) return []
      const header = fields(lines[0])
      const col = (name) => header.indexOf(name)
      const iAt = col("created_at")
      const iModel = col("model")
      const iIn = col("input_tokens")
      const iOut = col("output_tokens")
      const iCost = col("buyer_cost_usd") >= 0 ? col("buyer_cost_usd") : col("cost_usd")
      const iDirect = col("direct_cost_usd")
      if (iCost < 0) return []
      return lines.slice(1).map((line) => {
        const f = fields(line)
        return {
          at: iAt >= 0 ? +new Date(f[iAt]) : 0,
          model: iModel >= 0 ? (f[iModel] ?? "") : "",
          inT: iIn >= 0 ? Number(f[iIn]) || 0 : 0,
          outT: iOut >= 0 ? Number(f[iOut]) || 0 : 0,
          cost: Number(f[iCost]) || 0,
          direct: iDirect >= 0 ? Number(f[iDirect]) || 0 : 0,
        }
      })
    }

    rpc = await ctx.rpc.register(SurplusRpc, {
      state: async () => ({
        overrides: await getOverrides(),
        flags: await getFlags(),
        basePins: BASE_PINS,
        providerID: PID,
      }),
      setOverride: async (input) => {
        const { model, pin, floor, clear } = input ?? {}
        const id = normalizeModelID(model)
        if (!id) throw new Error("model is required")
        await mutateOverrides((o) => {
          if (clear) {
            delete o[id]
            return
          }
          const next = { ...(o[id] ?? {}) }
          if (pin !== undefined) next.pin = pin
          if (floor !== undefined) next.floor = floor
          o[id] = next
        })
        return {}
      },
      setFlags: async (input) => {
        const flags = { ...(await getFlags()), ...(typeof input?.backoffPrompt === "boolean" ? { backoffPrompt: input.backoffPrompt } : {}) }
        await ctx.storage.set("flags", flags)
        await emitChanged()
        return flags
      },
      offers: async (input, context) => {
        const id = normalizeModelID(input?.model)
        if (!id || !(await apiKey())) return { offers: [] }
        const data = await markets(id, context.signal).catch(() => ({ offers: [] }))
        return { offers: (data.offers ?? []).filter((o) => o.available && o.healthy && o.direct_input_per_1m > 0) }
      },
      settled: async (_input, context) => {
        if (!(await apiKey())) return { rows: [] }
        const now = new Date()
        const from = now.toISOString().slice(0, 10)
        const to = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)
        const csv = await surplusGet(`/v1/buyer/usage/export?format=csv&from=${from}&to=${to}`, {
          text: true,
          signal: context.signal,
        }).catch(() => "")
        return { rows: csv ? parseSettled(csv) : [] }
      },
      models: async () => ({
        models: Object.values(source.catalog).map((m) => ({ id: m.id, name: m.name ?? m.id })),
      }),
      calibration: async () => getCalibration(),
      setCalibration: async (input) => {
        const store = { rates: input?.rates ?? {}, pairs: input?.pairs ?? {} }
        await ctx.storage.set("calibration", store)
        source.rates = store.rates
        await ctx.provider.reload()
        return {}
      },
    })

    // ---- agent tools --------------------------------------------------------
    const str = (description) => ({ type: "string", description })
    const num = (description) => ({ type: "number", description })
    const bool = (description) => ({ type: "boolean", description })
    const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false })
    const text = (content) => ({ content })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "surplus_offers",
        description:
          "Query the Surplus Intelligence marketplace for live seller offers of a model. Returns healthy sellers with estimated discount percentages. Use before choosing a discount floor or a pin target.",
        input: schema(
          {
            model: str("Model ID, e.g. kimi-k3"),
            pinnedOnly: bool("Only show offers matching the model's routing pin (host or provider family)."),
          },
          ["model"],
        ),
        execute: async (input, context) => {
          const id = normalizeModelID(input.model)
          let rows = summarizeOffers(await markets(id, context.signal))
          if (input.pinnedOnly) rows = filterRowsByPin(rows, await activePin(id))
          if (!rows.length) return text(`No healthy offers for ${id} right now.`)
          const best = rows.reduce((a, b) => (b.discount_pct > a.discount_pct ? b : a))
          return text(
            [
              `Healthy offers for ${id} (best estimated discount: ${best.discount_pct}%):`,
              ...rows.slice(0, 10).map((r) => `- ${r.provider} ${r.host} — $${r.input_usd_per_1m}/1M in (~${r.discount_pct}% off)`),
              `\nHighest floor that passes: min${Math.floor(best.discount_pct)}. Pin a host with surplus_pin.`,
            ].join("\n"),
          )
        },
      })

      editor.add({
        name: "surplus_pin",
        description:
          "Pin (or unpin) Surplus routing for a model to a single seller host, persistently. Keeps the upstream prompt cache warm across requests. Omit provider to reset to the baseline pin.",
        input: schema(
          {
            model: str("Model ID, e.g. glm-5.2"),
            provider: str("Seller host base URL (https://host/v1) or provider family name (e.g. zai). Omit to reset."),
          },
          ["model"],
        ),
        execute: async (input) => {
          const id = normalizeModelID(input.model)
          const reset = input.provider === undefined || input.provider === ""
          const pin = reset ? (BASE_PINS[id] ?? null) : input.provider
          await mutateOverrides((o) => {
            o[id] = { ...(o[id] ?? {}), pin }
          })
          return text(pin ? `Pinned ${id} -> ${pin}.` : `Cleared pin for ${id}; no baseline pin applies.`)
        },
      })

      editor.add({
        name: "surplus_tier",
        description:
          "Report the strictest discount floor (70/80/90/95%) that currently passes for a model, from live offers. Does not change anything; use surplus_settier to apply a floor.",
        input: schema({ model: str("Model ID, e.g. kimi-k3"), min: num("Minimum discount percent to consider, 0-100") }, ["model"]),
        execute: async (input, context) => {
          const id = normalizeModelID(input.model)
          const min = typeof input.min === "number" ? input.min : 0
          if (!(min >= 0 && min <= 100)) throw new Error("min must be 0-100")
          const rows = summarizeOffers(await markets(id, context.signal))
          if (!rows.length) return text(`No healthy offers for ${id} right now.`)
          const best = rows.reduce((a, b) => (b.discount_pct > a.discount_pct ? b : a))
          const passing = TIERS.filter((t) => t >= min).find((t) => best.discount_pct >= t)
          return text(
            [
              `Best offer for ${id}: ${best.discount_pct}% off (${best.provider} ${best.host}).`,
              passing ? `A ≥${passing}% floor passes right now.` : `No floor ≥${min}% currently passes for ${id}.`,
              `Apply one with surplus_settier (or /surplus-tier).`,
            ].join("\n"),
          )
        },
      })

      editor.add({
        name: "surplus_settier",
        description:
          "Set the discount floor for a model. Persists immediately and applies to the next request (routed via the /min{N} URL). Values between tiers snap up to the next configured tier; 0 = no floor.",
        input: schema({ model: str("Model ID, e.g. kimi-k3"), min: num("Discount floor percent, 0-95") }, ["model", "min"]),
        execute: async (input) => {
          const id = normalizeModelID(input.model)
          if (!(input.min >= 0 && input.min <= 95)) throw new Error("min must be between 0 and 95")
          const ascending = [...TIERS].sort((a, b) => a - b)
          const floor = input.min === 0 ? 0 : (ascending.find((t) => t >= input.min) ?? ascending[ascending.length - 1])
          await mutateOverrides((o) => {
            o[id] = { ...(o[id] ?? {}), floor }
          })
          return text(
            floor === 0
              ? `Floor for ${id}: off (no minimum discount). Applies to the next request.`
              : `Floor for ${id}: ≥${floor}%. Applies to the next request (routed via /min${floor}).`,
          )
        },
      })

      editor.add({
        name: "surplus_flag",
        description:
          "Toggle backoff-prompt mode. OFF (default): a discount-floor failure just fails. ON: the TUI immediately offers to lower the floor (with a recommended tier) and retry.",
        input: schema({ enabled: bool("true = prompt mode, false = off. Omit to just report.") }),
        execute: async (input) => {
          if (typeof input.enabled === "boolean") {
            await ctx.storage.set("flags", { ...(await getFlags()), backoffPrompt: input.enabled })
            await emitChanged()
          }
          const on = (await getFlags()).backoffPrompt ?? false
          return text(`Backoff-prompt mode: ${on ? "ON (prompts to adjust the floor on failure)" : "OFF (floor failures fail normally)"}`)
        },
      })

      editor.add({
        name: "surplus_models",
        description: "List the discovered Surplus model catalog, with live best discounts for the first matches.",
        input: schema({
          query: str("Only list models whose ID/name contains this string"),
          limit: num("Max models to annotate with live offers (default 25, max 50)"),
        }),
        execute: async (input, context) => {
          const all = Object.values(source.catalog)
          if (!all.length) return text("No models discovered yet. Discovery runs in the background at startup; try again shortly or run `node sync-models.mjs`.")
          const q = input.query?.toLowerCase()
          const list = q ? all.filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q)) : all
          const limit = Math.max(0, Math.min(Number(input.limit) || 25, 50))
          const lines = await Promise.all(
            list.slice(0, limit).map(async (m) => {
              const best = await markets(m.id, context.signal).then(bestDiscountPct).catch(() => undefined)
              return best === undefined ? `- ${m.id} — no healthy offers right now` : `- ${m.id} — best ${best}% off`
            }),
          )
          return text(
            [
              `Discovered ${all.length} surplus models${q ? ` (${list.length} matching "${input.query}")` : ""}.`,
              ...lines,
              list.length > limit ? `\n(${list.length - limit} more not annotated — pass limit to see more)` : "",
            ].join("\n"),
          )
        },
      })

      editor.add({
        name: "surplus_backoff",
        description: "Report backoff-prompt mode and per-model discount floors. Pass clear=true to reset the floor-failure dedupe so the next failure prompts again.",
        input: schema({ clear: bool("Reset pending floor-failure state") }),
        execute: async (input) => {
          if (input.clear) {
            recentFloorEvents.clear()
            return text("Cleared pending floor-failure state.")
          }
          const overrides = await getOverrides()
          const floors = Object.entries(overrides)
            .filter(([, v]) => v?.floor)
            .map(([m, v]) => `${m} ≥${v.floor}%`)
          return text(
            [
              `Backoff-prompt mode: ${(await getFlags()).backoffPrompt ? "ON" : "OFF"}`,
              `Floors: ${floors.length ? floors.join(", ") : "none"}`,
            ].join("\n"),
          )
        },
      })

      editor.add({
        name: "surplus_spend",
        description: "Report actual Surplus spending: wallet balance, total spend, and savings vs direct pricing, from settled records.",
        input: schema({}),
        execute: async (_input, context) => {
          const [me, savings] = await Promise.all([
            surplusGet("/v1/buyer/me", { signal: context.signal }),
            surplusGet("/v1/buyer/savings", { signal: context.signal }),
          ])
          const fmt = (v) => (typeof v === "number" ? `$${v.toFixed(4)}` : JSON.stringify(v))
          const lines = []
          for (const [k, v] of Object.entries(me ?? {})) if (/balance|spend|usage|cost|total/i.test(k)) lines.push(`${k}: ${fmt(v)}`)
          for (const [k, v] of Object.entries(savings ?? {})) if (/saving|direct/i.test(k)) lines.push(`savings.${k}: ${fmt(v)}`)
          const pm = me?.models ?? me?.per_model
          if (pm) for (const [m, v] of Object.entries(pm)) lines.push(`  ${m}: ${typeof v === "object" ? fmt(v.cost_usd ?? v.total_cost ?? v.spend) : fmt(v)}`)
          return text(lines.length ? lines.join("\n") : `raw: ${JSON.stringify({ me, savings }).slice(0, 1500)}`)
        },
      })

      editor.add({
        name: "surplus_clear",
        description: "Remove all stored overrides (pin, floor) for a model.",
        input: schema({ model: str("Model ID, e.g. kimi-k3") }, ["model"]),
        execute: async (input) => {
          const id = normalizeModelID(input.model)
          await mutateOverrides((o) => {
            delete o[id]
          })
          return text(`Cleared overrides for ${id}.`)
        },
      })
    })

    return () => {
      controller.abort()
      for (const t of timers) clearInterval(t)
    }
  },
})
