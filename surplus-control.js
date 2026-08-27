// surplus-control.js
// Server-side Surplus Intelligence plugin for opencode.
//
// This is the companion to the TUI plugin `surplus-sidebar.tsx`. It adds
// agent-callable tools, request-body routing controls, model discovery, and
// discount-floor auto-backoff. Both plugins are optional together — the
// sidebar works without this file, and these tools work without the sidebar.
//
// WHAT IT ADDS
//   surplus_offers <model>          — query live marketplace offers + discounts
//   surplus_pin <model> [provider]  — pin/unpin routing to one seller host (persistent)
//   surplus_tier <model>            — recommend the strictest tier provider that passes
//   surplus_settier <model> <min>   — configure the discount floor for a model
//   surplus_flag [enabled]          — toggle backoff-prompt mode (auto vs prompt)
//   surplus_models [query]          — list discovered models (+ live availability)
//   surplus_backoff [clear]         — report/clear auto-backoff state
//   surplus_spend                   — report actual spending from settled records
//   surplus_clear <model>           — drop all session overrides for a model
//
// MODEL DISCOVERY
//   The plugin scrapes the Surplus model catalog from the OpenAI-compatible
//   inference endpoint (https://www.surplusintelligence.ai/api/inference/v1)
//   using the two-phase strategy from opencode-persistent-model-discovery:
//     1. Sync: load ~/.cache/opencode/models-surplus.json and merge into every
//        surplus provider's model map before opencode resolves providers.
//     2. Async: refresh the catalog in the background and rewrite the cache.
//   Gate per provider with `options.modelsDiscovery.enabled` (default ON for
//   surplus providers). A standalone `sync-models.mjs` script does the same
//   fetch outside opencode. Only models with text output are kept — the
//   catalog's image/video/audio-only models are skipped.
//
// DISCOUNT FLOORS (important)
//   Discount floors are enforced by the URL, not the request body. The Surplus
//   API ignores `max_price_per_1m` / `X-Max-Price-Per-1M` entirely (verified
//   live: even 0.0000001 returns 200). The only working mechanism is the
//   `/min{N}` path segment. Because opencode caches a model's base URL at
//   startup, this plugin runs a LOCAL FLOOR PROXY (see startFloorProxy): the
//   single `surplus` catalog provider (every model listed once) points at it,
//   and the proxy reads each model's current floor from the overrides store on
//   every request and forwards to `.../min{N}/v1`. Floor changes apply to the
//   NEXT request — no restart. Explicit tier providers (`surplus-70/80/90/95`)
//   the user has configured are left as-is and still work as floor shortcuts.
//
// FLOOR-FAILURE PROMPT (backoff-prompt mode)
//   When a request fails with `minimum_discount_not_met`, the plugin (with
//   backoff-prompt mode ON via `/surplus-flag yes`) immediately writes a
//   pending prompt the TUI shows: a dialog offering a RECOMMENDED tier (the
//   strictest tier below the current floor that live offers pass) plus the
//   other tiers and off — pick one and your last message is re-submitted
//   through the new floor. With mode OFF (default) the failure is surfaced
//   as-is; no prompt, no auto-change. (An automatic retry loop is planned
//   future work.) The floor proxy annotates upstream 402/price-gate errors so
//   the message reliably contains `minimum_discount_not_met`.
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
//   never synced or committed). Per-model: `{ pin?, maxPrice?, floor? }`.
//   Global keys (leading `_`): `_flags.backoffPrompt`, `_backoffPrompt`,
//   `_tui`. The `chat.params` hook re-reads this file on every request, so a
//   pin or floor set from the TUI takes effect immediately without a restart.

import { tool } from "@opencode-ai/plugin"
import { createServer } from "node:http"
import { request as httpsRequest } from "node:https"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

const SURPLUS_API = "https://api.surplusintelligence.ai"

// OpenAI-compatible model catalog endpoint (tested by
// opencode-persistent-model-discovery: 242 models).
const SURPLUS_INFERENCE_URL = "https://www.surplusintelligence.ai/api/inference/v1"

// Tier floor providers, strictest first. Floors are enforced by the /min{N}
// URL; each tier gets its own provider (see config hook).
const TIERS = [95, 90, 80, 70]

// Matches floor/price-gate failures in an error message. Covers the annotated
// `minimum_discount_not_met` marker (proxy), the legacy tier providers' raw
// Surplus text ("No marketplace sellers currently meet the minimum …"), and
// the x402/402 codes seen when the proxy is down.
const FLOOR_ERROR_RE = /minimum_discount_not_met|no marketplace sellers currently meet|meet the minimum.*(discount|off)|estimated discount|x402|402/i

// Pricing cache freshness: a boot skips the per-model market refresh if the
// cache was written within this window (bounds API calls once it's seeded).
const PRICING_TTL_MS = 15 * 60 * 1000

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

// ---------------------------------------------------------------------------
// State store (~/.local/share/opencode/surplus-control.json)
// ---------------------------------------------------------------------------

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

// Read-modify-write helper so the server and TUI never clobber each other.
function mutateState(mutator) {
  const state = loadState()
  mutator(state)
  saveState(state)
  return state
}

// ---------------------------------------------------------------------------
// Model catalog cache (~/.cache/opencode/models-surplus.json)
// Format: { [modelID]: { id, name } }
// ---------------------------------------------------------------------------

function modelsCachePath() {
  return `${process.env.XDG_CACHE_HOME ?? `${homedir()}/.cache`}/opencode/models-surplus.json`
}

function loadModelsCache() {
  try {
    return JSON.parse(readFileSync(modelsCachePath(), "utf8"))
  } catch {
    return {}
  }
}

function saveModelsCache(models) {
  const p = modelsCachePath()
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(models, null, 2) + "\n")
  renameSync(tmp, p)
}

async function discoverModels() {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 20000)
  try {
    // Accept-Encoding: identity — the Surplus edge compresses responses with
    // Brotli, which Node's undici fails to decompress (ERR__ERROR_FORMAT_PADDING_2).
    const res = await fetch(`${SURPLUS_INFERENCE_URL}/models`, {
      signal: controller.signal,
      headers: { "Accept-Encoding": "identity" },
    })
    if (!res.ok) throw new Error(`model discovery returned ${res.status}`)
    const data = await res.json()
    const out = {}
    for (const model of data.data ?? []) {
      if (!model?.id) continue
      // Keep only models that can output text. The catalog also lists image /
      // video / audio / voice output-only models, which aren't usable here.
      const outMods = model.architecture?.output_modalities
      if (Array.isArray(outMods) && outMods.length > 0 && !outMods.includes("text")) continue
      out[model.id] = { id: model.id, name: model.name || model.id }
    }
    return out
  } finally {
    clearTimeout(timeoutId)
  }
}

// ---------------------------------------------------------------------------
// Auth / marketplace
// ---------------------------------------------------------------------------

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
    headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
  })
  if (!res.ok) throw new Error(`markets API returned ${res.status}`)
  return res.json()
}

function summarizeOffers(offers) {
  // markets() returns { offers: [...] }; accept either that or a bare array.
  const list = Array.isArray(offers) ? offers : (offers?.offers ?? [])
  const rows = list
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

function bestDiscountPct(offers) {
  const rows = summarizeOffers(offers)
  if (!rows.length) return undefined
  return rows.reduce((a, b) => (b.discount_pct > a.discount_pct ? b : a)).discount_pct
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

// The strictest tier strictly below `from` (descending). Undefined when `from`
// is already the lowest tier.
function nextLowerTier(from) {
  return TIERS.find((t) => t < (from ?? Infinity)) ?? null
}

// A model id may come back prefixed with its provider ("surplus/glm-5.3-flash").
// Normalize to the bare id so the TUI, server, tools, and proxy all address the
// same overrides-store key.
function normalizeModelID(id) {
  if (typeof id !== "string") return id
  const slash = id.indexOf("/")
  return slash > 0 ? id.slice(slash + 1) : id
}

// The floor implied by a tier provider id ("surplus-95" -> 95).
function providerTier(pid) {
  const m = String(pid ?? "").match(/^surplus-(\d+)$/)
  return m ? Number(m[1]) : undefined
}

async function currentSessionModel(client, sessionID) {
  try {
    // The Session type has no `model`; the active model lives on messages
    // (assistant messages carry modelID/providerID, user messages a `model`).
    const res = await client.session.messages({ path: { id: sessionID } })
    const list = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    // Messages may be wrapped `{ info, parts }` (fields under `.info`) or flat.
    const flat = list.map((m) => m?.info ?? m)
    const latest = [...flat].reverse().find((m) => m.role === "assistant" && m.modelID)
    if (latest) return { providerID: latest.providerID, modelID: latest.modelID }
    const user = [...flat].reverse().find((m) => m.role === "user" && m.model?.modelID)
    if (user) return { providerID: user.model.providerID, modelID: user.model.modelID }
    return undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Floor-failure prompt (backoff-prompt mode)
// ---------------------------------------------------------------------------

// With backoff-prompt mode ON, a floor failure immediately writes a pending
// prompt for the TUI: a dialog offering a RECOMMENDED tier (the strictest tier
// below the current floor that live offers pass) plus the other tiers and off.
// With mode OFF the failure is just surfaced normally — this is a no-op.
async function handleFloorError(event, client) {
  const properties = event.properties ?? {}
  const sessionID = properties.sessionID
  // session.error errors are a discriminated union; the message is under
  // `data.message` (e.g. ApiError.data.message), not `error.message`.
  const err = properties.error ?? {}
  const message = typeof err.data?.message === "string" ? err.data.message : (typeof err.message === "string" ? err.message : "")
  if (!sessionID || !FLOOR_ERROR_RE.test(message)) return
  const model = await currentSessionModel(client, sessionID)
  if (!model || !model.providerID.startsWith("surplus")) return
  const state = loadState()
  if (!(state._flags?.backoffPrompt ?? false)) return

  const modelID = normalizeModelID(model.modelID)
  // The failing floor is the stored override, else the tier the provider id
  // implies (legacy surplus-NN providers bake the floor into their baseURL).
  const currentTier = state[modelID]?.floor ?? providerTier(model.providerID)
  try {
    const offers = await markets(modelID).catch(() => undefined)
    const best = offers ? bestDiscountPct(offers) : undefined
    const recommended = best === undefined
      ? nextLowerTier(currentTier)
      : TIERS.find((t) => t < (currentTier ?? Infinity) && best >= t) ?? null

    mutateState((st) => {
      const pending = st._backoffPrompt ?? {}
      pending[modelID] = { at: Date.now(), sessionID, currentTier, targetTier: recommended }
      st._backoffPrompt = pending
    })
  } catch {
    // Offer lookup is best-effort; a prompt without a recommendation still shows.
    mutateState((st) => {
      const pending = st._backoffPrompt ?? {}
      pending[modelID] = { at: Date.now(), sessionID, currentTier, targetTier: null }
      st._backoffPrompt = pending
    })
  }
}

// ---------------------------------------------------------------------------
// Background pricing refresh (deduplicated by model)
// ---------------------------------------------------------------------------

function refreshPricingInBackground() {
  ;(async () => {
    try {
      // Skip if a fresh run wrote pricing within the TTL — bounds API calls on
      // every boot once the cache is seeded.
      const p = `${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/opencode/surplus-pricing.json`
      try {
        if (existsSync(p) && Date.now() - statSync(p).mtimeMs < PRICING_TTL_MS) return
      } catch {}

      // Model -> providers that list it: disk config (tier providers + the
      // surplus stub) plus every discovered catalog model (merged into the
      // `surplus` provider by the config hook).
      const providers = new Map()
      let cfg
      try {
        cfg = JSON.parse(
          readFileSync(`${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/opencode/opencode.json`, "utf8")
        )
      } catch {
        cfg = {}
      }
      for (const [pid, pr] of Object.entries(cfg.provider ?? {})) {
        if (!pid.startsWith("surplus")) continue
        for (const mid of Object.keys(pr.models ?? {})) {
          if (!providers.has(mid)) providers.set(mid, new Set())
          providers.get(mid).add(pid)
        }
      }
      for (const mid of Object.keys(loadModelsCache())) {
        if (!providers.has(mid)) providers.set(mid, new Set())
        providers.get(mid).add("surplus")
      }

      const out = {}
      await Promise.all(
        [...providers.keys()].map(async (mid) => {
          try {
            const ok = ((await markets(mid)).offers ?? []).filter(
              (o) => o.available && o.healthy && o.price_output_per_1m > 0
            )
            if (!ok.length) return
            const best = ok.reduce((a, b) => (b.price_input_per_1m < a.price_input_per_1m ? b : a))
            const cost = {
              input: best.price_input_per_1m / 1e6,
              output: best.price_output_per_1m / 1e6,
              cache_read: best.price_input_per_1m / 1e7,
            }
            for (const pid of providers.get(mid)) out[`${pid}/${mid}`] = cost
          } catch {}
        })
      )
      if (Object.keys(out).length) {
        const tmp = `${p}.tmp`
        writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n")
        renameSync(tmp, p)
      }
    } catch {}
  })()
}

// ---------------------------------------------------------------------------
// Local floor proxy
//
// The Surplus discount floor is the /min{N} path of the request URL, and
// opencode caches a model's base URL at startup — so baking a floor into the
// provider URL would only change on restart. Instead, the `surplus` provider's
// baseURL points at this tiny localhost proxy. On EVERY request the proxy reads
// the model's current floor from the overrides store and forwards to
// `https://api.surplusintelligence.ai/min{floor}/v1`. Floors change instantly,
// with no restart, and the model picker keeps a single clean provider.
// ---------------------------------------------------------------------------

function startFloorProxy() {
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.on("end", () => {
      const body = Buffer.concat(chunks)
      let floor = 0
      try {
        const parsed = JSON.parse(body.toString("utf8") || "{}")
        const modelID = typeof parsed?.model === "string" ? normalizeModelID(parsed.model) : undefined
        floor = modelID ? (loadState()[modelID]?.floor ?? 0) : 0
      } catch {}
      const base = floor > 0 ? `${SURPLUS_API}/min${floor}/v1` : `${SURPLUS_API}/v1`
      // Incoming path is /v1/... (the provider baseURL ends in /v1 and the SDK
      // appends /chat/completions etc.). Map it onto the floor base URL.
      const inPath = req.url ?? "/"
      const rest = inPath.replace(/^\/v1/, "") || "/"
      const target = new URL(`${base}${rest}`)
      const headers = { ...req.headers }
      delete headers["host"]
      delete headers["accept-encoding"] // force identity upstream (undici brotli bug)
      headers["host"] = new URL(SURPLUS_API).host
      headers["accept-encoding"] = "identity"
      const up = httpsRequest(
        {
          method: req.method,
          hostname: target.hostname,
          port: 443,
          path: target.pathname + target.search,
          headers,
        },
        (upRes) => {
          const status = upRes.statusCode ?? 502
          if (status < 400) {
            res.writeHead(status, upRes.headers)
            upRes.pipe(res)
            return
          }
          // Buffer error bodies (small JSON) so floor/price-gate failures can
          // be annotated with the `minimum_discount_not_met` marker. Success
          // responses stream through untouched above.
          const errChunks = []
          upRes.on("data", (c) => errChunks.push(c))
          upRes.on("end", () => {
            let body = Buffer.concat(errChunks).toString("utf8")
            const floorGate = status === 402 || /discount|minimum|floor|x402|payment/i.test(body)
            if (floorGate) {
              let message = body || "discount floor not met"
              try {
                const parsed = JSON.parse(body)
                const err = parsed?.error
                if (typeof err?.message === "string") message = err.message
                else if (typeof err === "string") message = err
                else if (typeof parsed?.code === "string") message = parsed.code
                parsed.error = {
                  ...(err && typeof err === "object" ? err : {}),
                  message: `minimum_discount_not_met: ${message}`,
                }
                body = JSON.stringify(parsed)
              } catch {
                body = JSON.stringify({ error: { message: `minimum_discount_not_met: ${message}` } })
              }
            }
            res.writeHead(status, { ...upRes.headers, "content-length": Buffer.byteLength(body) })
            res.end(body)
          })
        },
      )
      up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
      if (body.length) up.write(body)
      up.end()
    })
  })
  return new Promise((resolve, reject) => {
    const marker = `${statePath()}.proxy`
    server.once("error", (err) => {
      try { writeFileSync(marker, JSON.stringify({ ok: false, error: String(err) })) } catch {}
      reject(err)
    })
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      try { writeFileSync(marker, JSON.stringify({ ok: true, port, url: `http://127.0.0.1:${port}/v1` })) } catch {}
      resolve({ server, port, url: `http://127.0.0.1:${port}/v1` })
    })
  })
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const SurplusControlPlugin = async ({ client }) => {
  // Start the floor proxy first so the config hook can point the surplus
  // provider at it. If it can't start (port/network issue) we fall back to
  // per-model `provider.api` URLs (floors apply on the next start).
  let proxy
  try {
    proxy = await startFloorProxy()
  } catch {}

  return {
    dispose: async () => {
      if (proxy) {
        try { proxy.server.close() } catch {}
      }
    },
    config: (cfg) => {
      // ---- Catalog provider (single, no duplicates) ----------------------
      // All discovered models live in ONE `surplus` provider so the model
      // picker lists each model exactly once. The provider sets NO baseURL:
      // each model carries its own URL (`provider.api`), which is how a floor
      // is applied per model (the /min{N} path). Tier providers the user has
      // configured explicitly are left untouched, and catalog models that
      // already exist in one of them are skipped here so nothing is listed
      // twice.
      const discovered = loadModelsCache()
      const elsewhere = new Set()
      for (const [pid, p] of Object.entries(cfg.provider ?? {})) {
        if (pid.startsWith("surplus") && pid !== "surplus") {
          for (const mid of Object.keys(p.models ?? {})) elsewhere.add(mid)
        }
      }
      if (Object.keys(discovered).length > 0 || cfg.provider?.surplus) {
        const existing = cfg.provider.surplus
        cfg.provider.surplus = {
          ...(existing ?? {}),
          name: existing?.name ?? "Surplus Intelligence",
          npm: existing?.npm ?? "@ai-sdk/openai-compatible",
          options: {
            ...(existing?.options ?? {}),
            // Keep discovery fully in our hands; don't let opencode's async
            // models discovery hit a default base URL on this provider.
            modelsDiscovery: { ...(existing?.options?.modelsDiscovery ?? {}), enabled: false },
            // Floors are applied per request by the local floor proxy, so the
            // provider points at it (instant floor changes, no restart).
            ...(proxy ? { baseURL: proxy.url } : {}),
          },
          models: { ...(existing?.models ?? {}) },
        }
        const state = loadState()
        for (const [mid, entry] of Object.entries(discovered)) {
          if (elsewhere.has(mid)) continue
          if (cfg.provider.surplus.models[mid]) continue
          cfg.provider.surplus.models[mid] = { id: mid, name: entry.name ?? mid }
        }
        // Fallback when the proxy isn't running: per-model base URL. Only used
        // if the provider has no baseURL (opencode prefers provider.options
        // over model.api.url), and then floors apply on the next start.
        if (!proxy) {
          for (const [mid, model] of Object.entries(cfg.provider.surplus.models)) {
            const floor = state[mid]?.floor
            const api = floor && floor > 0 ? `${SURPLUS_API}/min${floor}/v1` : `${SURPLUS_API}/v1`
            model.provider = { ...(model.provider ?? {}), api }
          }
        }
      }

      // ---- Apply cached marketplace pricing -----------------------------
      // Costs come from the background pricing refresh (surplus-pricing.json).
      // Applied AFTER the catalog merge so the discovered `surplus` provider
      // models get priced too — otherwise opencode reports $0 session cost.
      let cache
      try {
        cache = JSON.parse(
          readFileSync(`${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/opencode/surplus-pricing.json`, "utf8")
        )
      } catch {}
      if (cache) {
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
      }

      // ---- Model discovery ----------------------------------------------
      // Phase 2 (async, background): refresh the catalog + cache for next boot.
      ;(async () => {
        try {
          const models = await discoverModels()
          if (Object.keys(models).length) saveModelsCache(models)
        } catch {}
      })()

      // ---- Pricing refresh (background, deduplicated by model) ----------
      refreshPricingInBackground()
    },

    "chat.params": async (input, output) => {
      const modelID = normalizeModelID(input.model?.modelID ?? input.model?.api?.id)
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

    event: async ({ event }) => {
      if (event.type === "session.error") await handleFloorError(event, client)
    },

    tool: {
      surplus_offers: tool({
        description:
          "Query the Surplus Intelligence marketplace for live seller offers of a model. Returns healthy sellers with estimated discount percentages. Use before choosing a tier (minNN) or pin target.",
        args: {
          model: tool.schema.string().describe("Model ID, e.g. kimi-k3"),
          pinnedOnly: tool.schema.boolean().optional().describe(
            "Only show offers matching the model's routing pin (host or provider family)."
          ),
        },
        async execute(args) {
          const modelID = normalizeModelID(args.model)
          const data = await markets(modelID)
          let rows = summarizeOffers(data.offers)
          if (args.pinnedOnly) rows = filterRowsByPin(rows, activePin(modelID))
          if (!rows.length) return `No healthy offers for ${args.model} right now.`
          const best = rows.reduce((a, b) => (b.discount_pct > a.discount_pct ? b : a))
          return [
            `Healthy offers for ${args.model} (best estimated discount: ${best.discount_pct}%):`,
            ...rows.slice(0, 10).map((r) => `- ${r.provider} ${r.host} — $${r.input_usd_per_1m}/1M in (~${r.discount_pct}% off)`),
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
          const modelID = normalizeModelID(args.model)
          const reset = args.provider === undefined || args.provider === ""
          const pin = reset ? BASE_PINS[modelID] : args.provider
          mutateState((st) => {
            st[modelID] = { ...st[modelID], pin }
          })
          return pin
            ? `Pinned ${modelID} -> ${pin} for this session.`
            : `Cleared pin for ${modelID}; no baseline pin applies.`
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
          const modelID = normalizeModelID(args.model)
          if (!(args.min >= 0 && args.min <= 100)) throw new Error("min must be 0-100")
          const data = await markets(modelID)
          const rows = summarizeOffers(data.offers)
          if (!rows.length) return `No healthy offers for ${modelID} right now.`
          const best = rows.reduce((a, b) => (b.discount_pct > a.discount_pct ? b : a))
          const tiers = TIERS.filter((t) => t >= args.min)
          const passing = tiers.find((t) => best.discount_pct >= t)
          return [
            `Best offer for ${modelID}: ${best.discount_pct}% off (${best.provider} ${best.host}).`,
            passing
              ? `The surplus-${passing} provider passes (>=${passing}%).`
              : `No tier >= ${args.min}% currently passes for ${modelID}.`,
            `Strictest provider that works right now: surplus-${Math.floor(best.discount_pct / 10) * 10}.`,
            `Configure it with surplus_settier (or /surplus-tier) to set the floor for ${modelID}.`,
          ].join("\n")
        },
      }),

      surplus_settier: tool({
        description:
          "Configure the discount floor for a model. Persists immediately and applies to the next request: the local floor proxy routes the model through the /min{N} URL. The floor is enforced by the /min{N} path.",
        args: {
          model: tool.schema.string().describe("Model ID, e.g. kimi-k3"),
          min: tool.schema.number().describe("Discount floor percent, 0-95. Values between tiers snap up to the strictest configured tier >= min (e.g. 65 -> 70). 0 = no floor."),
        },
        async execute(args) {
          const modelID = normalizeModelID(args.model)
          if (!(args.min >= 0 && args.min <= 95)) throw new Error("min must be between 0 and 95")
          // TIERS is descending ([95,90,80,70]); search a sorted-ascending copy
          // so min 80 -> 80, min 65 -> 70 (strictest configured tier >= min).
          const ascending = [...TIERS].sort((a, b) => a - b)
          const floor = args.min === 0 ? 0 : (ascending.find((t) => t >= args.min) ?? ascending[ascending.length - 1])
          mutateState((st) => {
            st[modelID] = { ...st[modelID], floor }
          })
          if (floor === 0) {
            return `Floor for ${modelID}: off (no minimum discount). Applies to the next request.`
          }
          return `Floor for ${modelID}: >=${floor}%. Applies to the next request (routed via /min${floor}).`
        },
      }),

      surplus_flag: tool({
        description:
          "Toggle backoff-prompt mode. OFF (default): on a discount-floor failure the request just fails normally (no prompt, no auto-change). ON: immediately prompts you to adjust the discount tier (a recommended tier is suggested); picking one applies it to the next request.",
        args: {
          enabled: tool.schema.boolean().optional().describe("true = prompt mode, false = auto mode. Omit to just report."),
        },
        async execute(args) {
          if (args.enabled !== undefined) {
            mutateState((st) => {
              st._flags = { ...(st._flags ?? {}), backoffPrompt: args.enabled }
            })
          }
          const on = loadState()._flags?.backoffPrompt ?? false
          return `Backoff-prompt mode: ${on ? "ON (prompts to adjust tier after 60s)" : "OFF (auto-lowers the floor to the next passing tier)"}`
        },
      }),

      surplus_models: tool({
        description:
          "List models discovered for the Surplus marketplace (from the cached catalog), with live availability where it can be checked. The catalog is scraped from the Surplus inference endpoint at startup and by sync-models.mjs.",
        args: {
          query: tool.schema.string().optional().describe("Only list models whose ID/name contains this string"),
          limit: tool.schema.number().optional().describe("Max models to annotate with live offers (default 25)"),
        },
        async execute(args) {
          const models = loadModelsCache()
          const ids = Object.keys(models)
          if (!ids.length) {
            return "No models discovered yet. Restart opencode with a surplus provider configured (discovery runs at startup), run `node sync-models.mjs`, or trigger a refresh."
          }
          let list = ids.map((id) => ({ id, name: models[id]?.name ?? id }))
          if (args.query) list = list.filter((m) => m.id.toLowerCase().includes(args.query.toLowerCase()) || (m.name ?? "").toLowerCase().includes(args.query.toLowerCase()))
          const limit = Math.max(0, Math.min(Number(args.limit) || 25, 50))
          const annotated = await Promise.all(
            list.slice(0, limit).map(async (m) => {
              const off = await markets(m.id).catch(() => undefined)
              const best = off ? bestDiscountPct(off) : undefined
              return best === undefined
                ? `- ${m.id} — no healthy offers right now`
                : `- ${m.id} — best ${best}% off`
            })
          )
          const total = ids.length
          const capped = total > list.slice(0, limit).length
          return [
            `Discovered ${total} surplus models${args.query ? ` matching "${args.query}"` : ""}.`,
            ...annotated,
            capped ? `\n(${total - limit} more not annotated — pass limit to see more)` : "",
          ].join("\n")
        },
      }),

      surplus_backoff: tool({
        description:
          "Report current floor-failure prompt state (pending tier prompts and mode). Pass clear=true to wipe pending prompts.",
        args: {
          clear: tool.schema.boolean().optional(),
        },
        async execute(args) {
          if (args.clear) {
            mutateState((st) => {
              delete st._backoffPrompt
            })
            return "Cleared pending tier prompts."
          }
          const st = loadState()
          const pending = st._backoffPrompt ?? {}
          const keys = Object.keys(pending)
          const lines = [
            `Pending tier prompts: ${keys.length ? keys.map((m) => `${m} -> min${pending[m].targetTier ?? "?"}`).join(", ") : "none"}`,
            `Backoff-prompt mode: ${st._flags?.backoffPrompt ? "ON" : "OFF"}`,
          ]
          return lines.join("\n")
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
            const res = await fetch(`${SURPLUS_API}${path}`, {
              headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
            })
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
        description: "Remove all session overrides (pin, max price, floor) for a model.",
        args: {
          model: tool.schema.string().describe("Model ID, e.g. kimi-k3"),
        },
        async execute(args) {
          const modelID = normalizeModelID(args.model)
          mutateState((st) => {
            delete st[modelID]
          })
          return `Cleared session overrides for ${modelID}.`
        },
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// Pin filtering helpers (shared by surplus_offers + sidebar)
// ---------------------------------------------------------------------------

function activePin(model) {
  const o = loadState()[model] ?? {}
  return o.pin !== undefined ? o.pin : BASE_PINS[model]
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
    // family name: match the provider field or a hostname/URL containing it
    return (r.provider ?? "").toLowerCase().includes(pin.toLowerCase()) ||
      (r.host ?? "").toLowerCase().includes(pin.toLowerCase())
  })
}
