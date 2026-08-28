#!/usr/bin/env node
// sync-models.mjs
// Standalone model discovery for the Surplus Intelligence marketplace.
//
// Scrapes the OpenAI-compatible model catalog at the Surplus inference endpoint
// and writes it to the shared cache (~/.cache/opencode/models-surplus.json)
// that surplus-control.js / surplus-sidebar.tsx read at startup.
//
//   node sync-models.mjs                # discover + cache only
//   node sync-models.mjs --write-config # also write models into opencode.json
//   node sync-models.mjs --query <str>  # print matching discovered models
//
// Does NOT require opencode to be running. No secrets are written.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

const SURPLUS_INFERENCE_URL = "https://www.surplusintelligence.ai/api/inference/v1"
const SURPLUS_API = "https://api.surplusintelligence.ai"

function configDir() {
  return `${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/opencode`
}
function dataDir() {
  return `${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/opencode`
}
function cacheDir() {
  return `${process.env.XDG_CACHE_HOME ?? `${homedir()}/.cache`}/opencode`
}
function cachePath() {
  return `${cacheDir()}/models-surplus.json`
}
function pricingPath() {
  return `${dataDir()}/surplus-pricing.json`
}
function configPath() {
  return `${configDir()}/opencode.json`
}
function authPath() {
  return `${dataDir()}/auth.json`
}

function readJSON(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n")
  renameSync(tmp, path)
}

function authKey() {
  const auth = readJSON(authPath(), {})
  for (const [id, v] of Object.entries(auth)) {
    if (id.startsWith("surplus") && v?.key) return v.key
  }
  return undefined
}

async function discoverModels(baseURL = SURPLUS_INFERENCE_URL) {
  const url = baseURL.endsWith("/") ? `${baseURL}models` : `${baseURL}/models`
  console.log(`Fetching models from ${url} ...`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  let res
  try {
    // Accept-Encoding: identity — the Surplus edge compresses responses with
    // Brotli, which Node's undici fails to decompress (ERR__ERROR_FORMAT_PADDING_2).
    res = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept-Encoding": "identity" },
    })
  } finally {
    clearTimeout(timeout)
  }
  if (!res.ok) throw new Error(`discovery failed: ${res.status} ${res.statusText}`)
  const data = await res.json()
  const out = {}
  for (const model of data.data ?? []) {
    if (!model?.id) continue
    // Keep only models that can output text (skip image/video/audio/voice-only).
    const outMods = model.architecture?.output_modalities
    if (Array.isArray(outMods) && outMods.length > 0 && !outMods.includes("text")) continue
    out[model.id] = { id: model.id, name: model.name || model.id }
  }
  return out
}

// Best live marketplace pricing for a model (used by --pricing). Returns
// undefined when no key/healthy offers.
async function marketCost(model, key) {
  if (!key) return undefined
  try {
    const res = await fetch(`${SURPLUS_API}/api/markets/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
    })
    if (!res.ok) return undefined
    const data = await res.json()
    const ok = (data.offers ?? []).filter((o) => o.available && o.healthy && o.price_output_per_1m > 0)
    if (!ok.length) return undefined
    const best = ok.reduce((a, b) => (b.price_input_per_1m < a.price_input_per_1m ? b : a))
    return {
      input: best.price_input_per_1m / 1e6,
      output: best.price_output_per_1m / 1e6,
      cache_read: best.price_input_per_1m / 1e7,
    }
  } catch {
    return undefined
  }
}

// Best live discount from the marketplace API (used only when a key is present;
// otherwise models are listed without availability).
async function bestDiscount(model, key) {
  if (!key) return undefined
  try {
    const res = await fetch(`${SURPLUS_API}/api/markets/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
    })
    if (!res.ok) return undefined
    const data = await res.json()
    const rows = (data.offers ?? [])
      .filter((o) => o.available && o.healthy && o.direct_input_per_1m > 0)
      .map((o) => (1 - o.price_input_per_1m / o.direct_input_per_1m) * 100)
    return rows.length ? Math.round(Math.max(...rows) * 10) / 10 : undefined
  } catch {
    return undefined
  }
}

async function main() {
  const args = process.argv.slice(2)
  const writeConfig = args.includes("--write-config")
  const pricing = args.includes("--pricing")
  const queryIndex = args.indexOf("--query")
  const query = queryIndex >= 0 ? args[queryIndex + 1] : undefined

  let baseURL = SURPLUS_INFERENCE_URL
  const cfg = readJSON(configPath(), {})
  if (cfg.provider?.surplus?.options?.baseURL) {
    baseURL = cfg.provider.surplus.options.baseURL
  }
  if (cfg.provider?.surplus?.options?.modelsDiscovery?.baseURL) {
    baseURL = cfg.provider.surplus.options.modelsDiscovery.baseURL
  }

  const models = await discoverModels(baseURL)
  console.log(`Discovered ${Object.keys(models).length} models`)

  writeJSON(cachePath(), models)
  console.log(`Cache written: ${cachePath()}`)

  if (pricing) {
    // Seed/refresh the pricing cache so opencode reports session costs. Mirrors
    // the plugin's background refresh: price every discovered model (under the
    // `surplus` provider) plus any models on-disk tier providers list.
    const providers = new Map()
    for (const [pid, pr] of Object.entries(cfg.provider ?? {})) {
      if (!pid.startsWith("surplus")) continue
      for (const mid of Object.keys(pr.models ?? {})) {
        if (!providers.has(mid)) providers.set(mid, new Set())
        providers.get(mid).add(pid)
      }
    }
    for (const mid of Object.keys(models)) {
      if (!providers.has(mid)) providers.set(mid, new Set())
      providers.get(mid).add("surplus")
    }
    const key = authKey()
    if (!key) {
      console.error("No surplus key in auth.json — skipping pricing fetch.")
    } else {
      const out = {}
      const ids = [...providers.keys()]
      let priced = 0
      for (let i = 0; i < ids.length; i++) {
        const mid = ids[i]
        const cost = await marketCost(mid, key)
        if (cost) {
          for (const pid of providers.get(mid)) out[`${pid}/${mid}`] = cost
          priced++
        }
        if (i % 25 === 0) console.log(`  priced ${i}/${ids.length} ...`)
      }
      if (Object.keys(out).length) {
        writeJSON(pricingPath(), out)
        console.log(`Pricing written (${priced} models): ${pricingPath()}`)
      } else {
        console.log("No pricing fetched.")
      }
    }
  }

  if (query) {
    const key = authKey()
    const matches = Object.entries(models).filter(([id, m]) =>
      id.toLowerCase().includes(query.toLowerCase()) || (m.name ?? "").toLowerCase().includes(query.toLowerCase())
    )
    console.log(`\nModels matching "${query}":`)
    for (const [id, m] of matches.slice(0, 50)) {
      const disc = await bestDiscount(id, key)
      console.log(`- ${id} (${m.name ?? id})${disc !== undefined ? ` — best ${disc}% off` : ""}`)
    }
  }
  if (writeConfig) {
    // Write the catalog into the single `surplus` provider (no base URL — each
    // model carries its own URL via `provider.api`, so floors apply per model).
    // Mirror the runtime config-hook rule: models that already exist in a
    // `surplus-NN` tier provider are skipped here so nothing is listed twice.
    const elsewhere = new Set()
    for (const [pid, p] of Object.entries(cfg.provider ?? {})) {
      if (pid.startsWith("surplus") && pid !== "surplus") {
        for (const mid of Object.keys(p.models ?? {})) elsewhere.add(mid)
      }
    }
    const existing = cfg.provider?.surplus ?? {}
    const written = {}
    for (const [id, m] of Object.entries(models)) {
      if (elsewhere.has(id)) continue
      written[id] = { id, name: m.name ?? id, provider: { api: `${SURPLUS_API}/v1` } }
    }
    cfg.provider = cfg.provider ?? {}
    cfg.provider.surplus = {
      ...existing,
      name: existing.name ?? "Surplus Intelligence",
      npm: existing.npm ?? "@ai-sdk/openai-compatible",
      options: { ...(existing.options ?? {}), modelsDiscovery: { enabled: false } },
      models: { ...(existing.models ?? {}), ...written },
    }
    writeJSON(configPath(), cfg)
    console.log(`Wrote ${Object.keys(written).length} models into provider "surplus" in ${configPath()}`)
  }
}

main().catch((err) => {
  console.error(`sync-models failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
