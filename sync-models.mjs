#!/usr/bin/env node
// sync-models.mjs
// Standalone model discovery for the Surplus Intelligence marketplace.
//
// Writes the same catalog cache the plugin reads at startup
// (~/.cache/opencode/models-surplus.json), so the model picker is populated
// even before the plugin's own background refresh has run. In OpenCode V2 the
// plugin publishes the catalog and prices models itself; nothing is written to
// opencode.json(c).
//
//   node sync-models.mjs                # discover + cache
//   node sync-models.mjs --query <str>  # also list matching models; with
//                                       # SURPLUS_API_KEY set, adds live discounts
//
// Does NOT require OpenCode to be running. No secrets are written.

import { discoverModels, modelsCachePath, saveModelsCache } from "./surplus/catalog.js"

const SURPLUS_API = "https://api.surplusintelligence.ai"

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
  for (const legacy of ["--write-config", "--pricing"]) {
    if (args.includes(legacy)) console.warn(`${legacy} is no longer needed: the V2 plugin publishes and prices the catalog itself.`)
  }
  const queryIndex = args.indexOf("--query")
  const query = queryIndex >= 0 ? args[queryIndex + 1] : undefined

  const models = await discoverModels()
  console.log(`Discovered ${Object.keys(models).length} text-output models`)
  saveModelsCache(models)
  console.log(`Cache written: ${modelsCachePath()}`)

  if (query) {
    const key = process.env.SURPLUS_API_KEY
    const q = query.toLowerCase()
    const matches = Object.values(models).filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q))
    console.log(`\nModels matching "${query}":`)
    for (const m of matches.slice(0, 50)) {
      const disc = await bestDiscount(m.id, key)
      console.log(`- ${m.id} (${m.name ?? m.id})${disc !== undefined ? ` — best ${disc}% off` : ""}`)
    }
  }
}

main().catch((err) => {
  console.error(`sync-models failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
