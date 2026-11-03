// catalog.js — Surplus model catalog discovery and its on-disk cache.
// Shared by the server plugin (index.js) and the standalone sync-models.mjs,
// so it must not import anything from OpenCode.
//
// Cache: ~/.cache/opencode/models-surplus.json
//   { [id]: { id, name, context?, output?, tools?, input?, cost? } }
// cost is USD per 1M tokens: { input, output, cacheRead, cacheWrite }.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"

export const SURPLUS_INFERENCE_URL = "https://www.surplusintelligence.ai/api/inference/v1"

export function modelsCachePath() {
  return `${process.env.XDG_CACHE_HOME ?? `${homedir()}/.cache`}/opencode/models-surplus.json`
}

export function loadModelsCache() {
  try {
    return JSON.parse(readFileSync(modelsCachePath(), "utf8"))
  } catch {
    return {}
  }
}

export function saveModelsCache(models) {
  const p = modelsCachePath()
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(`${p}.tmp`, JSON.stringify(models, null, 2) + "\n")
  renameSync(`${p}.tmp`, p)
}

const perMillion = (v) => {
  if (v === undefined || v === null || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n * 1e6 : undefined
}

// Fetch the catalog; keep only models with text output.
export async function discoverModels(signal) {
  // Accept-Encoding: identity — the Surplus edge's Brotli trips Node's undici.
  const res = await fetch(`${SURPLUS_INFERENCE_URL}/models`, {
    signal: signal ?? AbortSignal.timeout(30_000),
    headers: { "Accept-Encoding": "identity" },
  })
  if (!res.ok) throw new Error(`model discovery returned ${res.status}`)
  const data = await res.json()
  const out = {}
  for (const m of data.data ?? []) {
    if (!m?.id) continue
    const outMods = m.architecture?.output_modalities
    if (Array.isArray(outMods) && outMods.length > 0 && !outMods.includes("text")) continue
    const input = perMillion(m.pricing?.prompt)
    const output = perMillion(m.pricing?.completion)
    out[m.id] = {
      id: m.id,
      name: m.name || m.id,
      context: m.context_length ?? m.top_provider?.context_length,
      output: m.top_provider?.max_completion_tokens ?? undefined,
      tools: Array.isArray(m.supported_features) ? m.supported_features.includes("tools") : undefined,
      input: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : undefined,
      cost:
        input !== undefined && output !== undefined
          ? {
              input,
              output,
              cacheRead: perMillion(m.pricing?.input_cache_read) ?? input * 0.1,
              cacheWrite: perMillion(m.pricing?.input_cache_write) ?? input,
            }
          : undefined,
    }
  }
  return out
}
