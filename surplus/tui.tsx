/** @jsxImportSource @opentui/solid */
// tui.tsx — TUI part of the Surplus Intelligence plugin for OpenCode V2.
//
// Loaded automatically beside the server part (index.js) from
// ~/.config/opencode/plugins/surplus/. All Surplus data comes from the server
// part over the RPC in rpc.js (the TUI cannot read credentials in V2).
//
// WHAT IT ADDS
//   • TPS meter in the prompt footer: live tokens/s, session average, TTFT.
//   • "Today" block in the sidebar: today's blended $/1M, % off vs list, spend.
//   • Sidebar footer: discount floor, top 3 offers (blended to your usage),
//     routing pin, and this session's discount / avg $/1M / tokens.
//   • /surplus-* commands (palette group "Surplus"), no LLM round-trip:
//     status (alias /surplus), offers, tier, spend, pin, clear, flag, models, tui.
//   • Floor-failure dialog (backoff-prompt mode ON): lower the floor and retry.
//
// OPTIONS (plugin entry in opencode.jsonc, object form):
//   { "package": "./plugins/surplus", "options": {
//       "enabled": true, "offers": { "filterByPin": false },
//       "spinner": { "theme": "tech", "intervalMs": 100, "cells": 6 },
//       "tiers": { "tps": { "slow": 20, "normal": 50, "fast": 100 },
//                  "ttft": { "fast": 10000, "ok": 20000 } } } }

import { Plugin } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { createSignal, For, Show } from "solid-js"
import { SurplusRpc } from "./rpc.js"

const TIERS = [95, 90, 80, 70] as const
const WINDOW_MS = 5_000
const STALE_MS = 1_500
const MIN_DURATION_MS = 1_000
const MAX_CALIBRATION_RATIOS = 10
const DOT_GLYPHS = ["⠁", "⠂", "⠄", "⠈", "⠐", "⠠", "⠒", "⠑", "⠡", "⠢", "⠤", "⠨", "⠰", "⠸", "⠘", "⠔", "⠖", "⠦"]
const THEME_PRESETS: Record<string, string[]> = {
  tech: ["#00e5ff", "#2979ff", "#651fff"],
  red: ["#ff1744", "#ff5252", "#ff8a80"],
}

type Offer = { provider: string; price: number; discount: number }
type RawOffer = {
  provider: string
  seller_base_url: string
  price_input_per_1m: number
  price_output_per_1m: number
  direct_input_per_1m: number
  direct_output_per_1m: number
}
type SettledRow = { at: number; model: string; inT: number; outT: number; cost: number; direct: number }
type Usage = { cost: number; tokens: number; avgPer1M: number; direct?: number; discountPct?: number; cacheRead: number; input: number }
type CalibPair = { fresh: number; cache: number; out: number; cost: number; direct: number; at: number }
type CalibRates = { fresh: number; cache: number; out: number }
type CalibStore = { rates: Record<string, CalibRates & { direct: CalibRates; at: number; n: number; mape: number }>; pairs: Record<string, CalibPair[]> }
type ServerState = {
  overrides: Record<string, { pin?: string | null; floor?: number }>
  flags: { backoffPrompt?: boolean }
  basePins: Record<string, string>
  providerID: string
}
type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function normalizeModelID(id: string | undefined): string {
  if (!id) return ""
  const slash = id.indexOf("/")
  return slash > 0 ? id.slice(slash + 1) : id
}

function fmtTokens(n: number | undefined, digits = 2): string {
  if (n === undefined || !Number.isFinite(n)) return "--"
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(digits)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return `${Math.round(n)}`
}

function shortPin(pin: string | null | undefined): string {
  if (!pin) return "none"
  if (!pin.startsWith("http")) return pin
  try {
    return new URL(pin).host
  } catch {
    return pin
  }
}

function filterOffersByPin(offers: RawOffer[], pin: string | null | undefined) {
  if (!pin) return offers
  const isURL = /^https?:\/\//.test(pin)
  const host = isURL ? new URL(pin).hostname : undefined
  const p = pin.toLowerCase()
  return offers.filter((o) => {
    if (isURL) {
      try {
        return new URL(o.seller_base_url).hostname === host
      } catch {
        return false
      }
    }
    return String(o.provider ?? "").toLowerCase().includes(p) || String(o.seller_base_url ?? "").toLowerCase().includes(p)
  })
}

// Blend a seller's per-token rates to the user's input:output mix and cache-hit
// fraction (the offers API has no cache price; the standard 10% read rate is
// applied to the cached share of input). Top 3 by blended price.
function blendOffers(raw: RawOffer[], wIn: number, cacheFrac: number): Offer[] {
  const wOut = 1 - wIn
  const cacheAdj = 1 - 0.9 * Math.min(Math.max(cacheFrac, 0), 0.95)
  return raw
    .filter((o) => o.direct_output_per_1m > 0)
    .map((o) => {
      const price = (wIn * o.price_input_per_1m * cacheAdj + wOut * o.price_output_per_1m) / 1e6
      const direct = (wIn * o.direct_input_per_1m * cacheAdj + wOut * o.direct_output_per_1m) / 1e6
      return { provider: o.provider, price, discount: Math.round((1 - price / direct) * 1000) / 10 }
    })
    .sort((a, b) => a.price - b.price)
    .slice(0, 3)
}

function rankOffers(raw: RawOffer[]) {
  return raw
    .map((o) => ({
      provider: o.provider,
      host: o.seller_base_url,
      inputUsd: o.price_input_per_1m / 1e6,
      discount: Math.round((1 - o.price_input_per_1m / o.direct_input_per_1m) * 1000) / 10,
    }))
    .sort((a, b) => b.discount - a.discount)
}

function todayUsage(rows: SettledRow[]) {
  if (!rows.length) return undefined
  let cost = 0
  let direct = 0
  let inT = 0
  let outT = 0
  for (const r of rows) {
    cost += r.cost
    direct += r.direct
    inT += r.inT
    outT += r.outT
  }
  const tokens = inT + outT
  return {
    cost,
    tokens,
    direct,
    in: inT,
    out: outT,
    avgPer1M: tokens > 0 ? (cost / tokens) * 1e6 : 0,
    discountPct: cost > 0 && direct > 0 ? Math.round((1 - cost / direct) * 1000) / 10 : undefined,
  }
}

// Least-squares fit of cost = fresh*a + cache*b + out*c, returned as $/1M.
function fitRates(pairs: CalibPair[], field: "cost" | "direct"): CalibRates | undefined {
  const k = 3
  const M = Array.from({ length: k }, () => Array(k + 1).fill(0))
  let n = 0
  for (const p of pairs) {
    const A = [p.fresh, p.cache, p.out]
    const y = p[field]
    if (typeof y !== "number" || !Number.isFinite(y) || !A.every((v) => Number.isFinite(v))) continue
    n++
    for (let j = 0; j < k; j++) {
      M[j][k] += A[j] * y
      for (let l = 0; l < k; l++) M[j][l] += A[j] * A[l]
    }
  }
  if (n < 5) return undefined
  for (let i = 0; i < k; i++) {
    let piv = i
    for (let j = i + 1; j < k; j++) if (Math.abs(M[j][i]) > Math.abs(M[piv][i])) piv = j
    ;[M[i], M[piv]] = [M[piv], M[i]]
    for (let j = i + 1; j < k; j++) {
      const f = M[j][i] / M[i][i]
      for (let l = i; l <= k; l++) M[j][l] -= f * M[i][l]
    }
  }
  const x = Array(k).fill(0)
  for (let i = k - 1; i >= 0; i--) {
    x[i] = M[i][k]
    for (let j = i + 1; j < k; j++) x[i] -= M[i][j] * x[j]
    x[i] /= M[i][i]
  }
  if (!x.every((v) => Number.isFinite(v) && v >= 0)) return undefined
  return { fresh: x[0] * 1e6, cache: x[1] * 1e6, out: x[2] * 1e6 }
}

function median(values: number[]): number {
  if (!values.length) return 1
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function formatTps(v: number): string | undefined {
  if (!Number.isFinite(v) || v <= 0) return undefined
  if (v >= 100) return Math.round(v).toString()
  if (v >= 10) return v.toFixed(1)
  return v.toFixed(2)
}

function estimateTokens(delta: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 4))
}

function lerpColor(a: RGBA, b: RGBA, t: number): RGBA {
  return RGBA.fromValues(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, 1)
}

function gradientColor(colors: RGBA[], t: number): RGBA {
  if (!colors.length) return RGBA.fromHex("#888888")
  if (colors.length === 1) return colors[0]
  const seg = Math.max(0, Math.min(1, t)) * (colors.length - 1)
  const i = Math.min(Math.floor(seg), colors.length - 2)
  return lerpColor(colors[i], colors[i + 1], seg - i)
}

function resolveConfig(options: Record<string, any>) {
  const sp = options.spinner ?? {}
  const preset = THEME_PRESETS[sp.theme ?? "tech"] ?? THEME_PRESETS.tech
  const colors = (Array.isArray(sp.colors) && sp.colors.length ? sp.colors : preset).map((c: string) => RGBA.fromHex(c))
  const tp = options.tiers?.tps ?? {}
  const tt = options.tiers?.ttft ?? {}
  return {
    enabled: options.enabled !== false,
    filterByPin: options.offers?.filterByPin ?? false,
    spinner: {
      colors,
      intervalMs: typeof sp.intervalMs === "number" && sp.intervalMs > 0 ? sp.intervalMs : 100,
      enabled: sp.enabled !== false && (sp.theme ?? "tech") !== "none",
      cells: typeof sp.cells === "number" && sp.cells >= 2 ? Math.floor(sp.cells) : 6,
    },
    tps: { slow: tp.slow ?? 20, normal: tp.normal ?? 50, fast: tp.fast ?? 100 },
    ttft: { fast: tt.fast ?? 10000, ok: tt.ok ?? 20000 },
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "surplus",
  async setup(context) {
    const config = resolveConfig(context.options ?? {})
    if (!config.enabled) return

    const theme = context.theme
    const color = {
      text: () => theme.text.base,
      muted: () => theme.text.muted,
      accent: () => theme.text.feedback.info.base,
      success: () => theme.text.feedback.success.base,
      warning: () => theme.text.feedback.warning.base,
      error: () => theme.text.feedback.error.base,
    }
    const discountColor = (pct: number) => (pct >= 90 ? color.success() : pct >= 80 ? color.warning() : color.error())

    // One reactive tick drives every view; bump() after any state change.
    const [tick, setTick] = createSignal(0)
    const bump = () => setTick((n) => n + 1)
    const [visible, setVisible] = createSignal(true)

    const location = () => context.location ?? context.data.location.default()
    const rpc = () => context.client.rpc(SurplusRpc)
    const call = async <T,>(method: string, input?: unknown, fallback?: T): Promise<T> => {
      try {
        return (await (rpc() as any)[method](input ?? {}, { location: location() })) as T
      } catch {
        return fallback as T
      }
    }

    // ---- server state ------------------------------------------------------
    let server: ServerState = { overrides: {}, flags: {}, basePins: {}, providerID: "surplus-intelligence" }
    const refreshState = async () => {
      server = await call<ServerState>("state", undefined, server)
      bump()
    }
    const isSurplus = (providerID: string | undefined) => !!providerID && (providerID === server.providerID || providerID.startsWith("surplus"))
    const pinFor = (model: string) => {
      const o = server.overrides[model] ?? {}
      return o.pin !== undefined ? o.pin : server.basePins[model]
    }
    const floorFor = (model: string) => server.overrides[model]?.floor

    // ---- session helpers ---------------------------------------------------
    const currentSessionID = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const modelOf = (sessionID: string | undefined) => {
      const selected = context.ui.model.current()
      const stored = sessionID ? context.data.session.get(sessionID)?.model : undefined
      const providerID = stored?.providerID ?? selected?.providerID
      const id = stored?.id ?? selected?.modelID
      return { providerID, model: isSurplus(providerID) ? normalizeModelID(id) : "" }
    }
    const assistantMessages = (sessionID: string) =>
      context.data.session.message.list(sessionID).filter((m: any) => m.type === "assistant" && m.tokens) as any[]

    let calib: CalibStore = { rates: {}, pairs: {} }

    const sessionUsage = (sessionID: string): Usage => {
      const messages = assistantMessages(sessionID)
      const last = messages[messages.length - 1]
      const rates = last ? calib.rates[normalizeModelID(last.model?.id)] : undefined
      if (rates) {
        let cost = 0
        let direct = 0
        let tokens = 0
        let cacheRead = 0
        let input = 0
        for (const m of messages) {
          const t = m.tokens as Tokens
          const fresh = t.input || 0
          const cache = t.cache?.read || 0
          const out = (t.output || 0) + (t.reasoning || 0)
          cost += (fresh * rates.fresh + cache * rates.cache + out * rates.out) / 1e6
          if (rates.direct) direct += (fresh * rates.direct.fresh + cache * rates.direct.cache + out * rates.direct.out) / 1e6
          tokens += fresh + out + cache + (t.cache?.write || 0)
          cacheRead += cache
          input += fresh
        }
        return {
          cost,
          tokens,
          avgPer1M: tokens > 0 ? (cost / tokens) * 1e6 : 0,
          direct,
          discountPct: cost > 0 && direct > 0 ? Math.round((1 - cost / direct) * 1000) / 10 : undefined,
          cacheRead,
          input,
        }
      }
      const session = context.data.session.get(sessionID)
      const t = session?.tokens
      if (!t) return { cost: 0, tokens: 0, avgPer1M: 0, cacheRead: 0, input: 0 }
      const tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
      const cost = session?.cost ?? 0
      return { cost, tokens, avgPer1M: tokens > 0 ? (cost / tokens) * 1e6 : 0, cacheRead: t.cache.read, input: t.input }
    }

    // ---- spend + offers ----------------------------------------------------
    const spend = {
      today: undefined as ReturnType<typeof todayUsage>,
      offers: [] as Offer[],
      offersFor: "",
      loading: false,
    }

    const blendWeights = (sessionID: string | undefined) => {
      const total = (spend.today?.in ?? 0) + (spend.today?.out ?? 0)
      const wIn = total > 0 ? (spend.today?.in ?? 0) / total : 0.75
      const su = sessionID ? sessionUsage(sessionID) : undefined
      return { wIn, cacheFrac: su && su.input > 0 ? su.cacheRead / su.input : 0 }
    }

    const rawOffers = async (model: string, filterByPin = false) => {
      const { offers } = await call<{ offers: RawOffer[] }>("offers", { model }, { offers: [] })
      return filterByPin ? filterOffersByPin(offers ?? [], pinFor(model)) : (offers ?? [])
    }

    const refreshOffers = async (sessionID: string | undefined, force = false) => {
      const { model } = modelOf(sessionID)
      if (!model) {
        if (spend.offersFor) {
          spend.offersFor = ""
          spend.offers = []
          bump()
        }
        return
      }
      if (!force && spend.offersFor === model) return
      spend.offersFor = model
      const bw = blendWeights(sessionID)
      spend.offers = blendOffers(await rawOffers(model, config.filterByPin), bw.wIn, bw.cacheFrac)
      bump()
    }

    // Match this session's assistant messages to settled rows and refit the
    // real per-token rates; the server re-prices models from them.
    let calibrating = false
    const calibrate = async (sessionID: string, rows: SettledRow[]) => {
      if (calibrating) return
      calibrating = true
      try {
        await calibrateOnce(sessionID, rows)
      } finally {
        calibrating = false
      }
    }
    const calibrateOnce = async (sessionID: string, rows: SettledRow[]) => {
      await context.data.session.message.sync(sessionID).catch(() => {})
      let changed = false
      for (const m of assistantMessages(sessionID)) {
        const t = m.tokens as Tokens
        const model = normalizeModelID(m.model?.id)
        const at = m.time?.completed ?? m.time?.created ?? 0
        if (!model || !at) continue
        const fresh = t.input || 0
        const cache = t.cache?.read || 0
        const out = (t.output || 0) + (t.reasoning || 0)
        const pairs = calib.pairs[model] ?? []
        if (pairs.some((p) => p.at === at && p.fresh === fresh && p.out === out && typeof p.direct === "number")) continue
        let best: SettledRow | undefined
        let bd = Infinity
        for (const s of rows) {
          if (s.model !== model || Math.abs(s.at - at) > 120_000) continue
          const d = Math.abs(s.inT - (fresh + cache)) + Math.abs(s.outT - out)
          if (d < bd) {
            bd = d
            best = s
          }
        }
        if (!best || bd >= Math.max(50, (fresh + cache) * 0.3)) continue
        calib.pairs[model] = [...pairs, { fresh, cache, out, cost: best.cost, direct: best.direct, at }].slice(-600)
        changed = true
      }
      if (!changed) return
      for (const [model, pairs] of Object.entries(calib.pairs)) {
        const rates = fitRates(pairs, "cost")
        const direct = fitRates(pairs, "direct")
        if (!rates || !direct) continue
        let ae = 0
        let tot = 0
        for (const p of pairs) {
          ae += Math.abs((p.fresh * rates.fresh + p.cache * rates.cache + p.out * rates.out) / 1e6 - p.cost)
          tot += p.cost
        }
        calib.rates[model] = { ...rates, direct, at: Date.now(), n: pairs.length, mape: tot > 0 ? (ae / tot) * 100 : 0 }
      }
      await call("setCalibration", calib)
    }

    const refreshSpend = async () => {
      if (spend.loading) return
      spend.loading = true
      try {
        const { rows } = await call<{ rows: SettledRow[] }>("settled", undefined, { rows: [] })
        spend.today = todayUsage(rows ?? [])
        bump()
        // Calibration syncs session messages, which can be slow; never let it
        // block the spend display or the next refresh.
        const sessionID = currentSessionID()
        if (sessionID && rows?.length) void calibrate(sessionID, rows).catch(() => {})
      } catch {}
      spend.loading = false
      bump()
    }

    // ---- TPS tracker -------------------------------------------------------
    type Sample = { at: number; raw: number }
    const tracker = {
      samples: {} as Record<string, Sample[]>,
      startedAt: {} as Record<string, number>,
      firstDelta: {} as Record<string, number>,
      lastDelta: {} as Record<string, number>,
      estimated: {} as Record<string, number>,
      ttft: {} as Record<string, number>,
      stats: {} as Record<string, { out: number; ms: number; ratios: number[] }>,
      thinking: {} as Record<string, boolean>,
    }

    const N = config.spinner.cells
    const spawnGlyph = () => (Math.random() < 0.18 ? " " : DOT_GLYPHS[Math.floor(Math.random() * DOT_GLYPHS.length)])
    let stream: string[] = Array.from({ length: N }, spawnGlyph)
    let hueFrame = 0
    let spinnerTimer: ReturnType<typeof setInterval> | undefined
    const anyThinking = () => Object.values(tracker.thinking).some(Boolean)
    const syncSpinner = () => {
      if (config.spinner.enabled && anyThinking() && !spinnerTimer) {
        spinnerTimer = setInterval(() => {
          stream.unshift(spawnGlyph())
          if (stream.length > N) stream.pop()
          hueFrame++
          bump()
        }, config.spinner.intervalMs)
      } else if ((!anyThinking() || !config.spinner.enabled) && spinnerTimer) {
        clearInterval(spinnerTimer)
        spinnerTimer = undefined
      }
    }
    const setThinking = (sessionID: string, value: boolean) => {
      if (tracker.thinking[sessionID] === value) return
      tracker.thinking[sessionID] = value
      if (value) {
        stream = Array.from({ length: N }, spawnGlyph)
        hueFrame = 0
      }
      syncSpinner()
    }
    const recordDelta = (sessionID: string, messageID: string, delta: string) => {
      const at = Date.now()
      const raw = estimateTokens(delta)
      tracker.samples[sessionID] = [...(tracker.samples[sessionID] ?? []).filter((s) => s.at >= at - WINDOW_MS), { at, raw }]
      if (tracker.firstDelta[messageID] === undefined) {
        tracker.firstDelta[messageID] = at
        const started = tracker.startedAt[messageID]
        if (started !== undefined) tracker.ttft[sessionID] = Math.max(0, at - started)
      }
      tracker.lastDelta[messageID] = at
      tracker.estimated[messageID] = (tracker.estimated[messageID] ?? 0) + raw
    }
    const forgetMessage = (sessionID: string, messageID: string) => {
      delete tracker.estimated[messageID]
      delete tracker.firstDelta[messageID]
      delete tracker.lastDelta[messageID]
      delete tracker.startedAt[messageID]
      delete tracker.samples[sessionID]
      setThinking(sessionID, false)
    }

    const unsubscribers: (() => void)[] = []
    const on = (type: any, handler: (event: any) => void) => unsubscribers.push(context.data.on(type, handler))

    on("session.step.started", (e) => {
      tracker.startedAt[e.data.assistantMessageID] = Date.now()
    })
    on("session.text.delta", (e) => {
      recordDelta(e.data.sessionID, e.data.assistantMessageID, e.data.delta)
      setThinking(e.data.sessionID, false)
      bump()
    })
    on("session.reasoning.delta", (e) => {
      recordDelta(e.data.sessionID, e.data.assistantMessageID, e.data.delta)
      setThinking(e.data.sessionID, true)
      bump()
    })
    on("session.tool.input.started", (e) => {
      delete tracker.samples[e.data.sessionID]
      setThinking(e.data.sessionID, false)
      bump()
    })
    on("session.step.ended", (e) => {
      const { sessionID, assistantMessageID: id, tokens } = e.data
      const stats = (tracker.stats[sessionID] ??= { out: 0, ms: 0, ratios: [] })
      const actual = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
      const first = tracker.firstDelta[id]
      const last = tracker.lastDelta[id]
      const ms = first !== undefined && last !== undefined ? Math.max(last - first, MIN_DURATION_MS) : 0
      if (actual > 0 && ms > 0) {
        stats.out += actual
        stats.ms += ms
        const est = tracker.estimated[id] ?? 0
        if (est > 0) stats.ratios = [...stats.ratios, Math.min(Math.max(actual / est, 0.3), 3)].slice(-MAX_CALIBRATION_RATIOS)
      }
      forgetMessage(sessionID, id)
      bump()
      void refreshSpend()
    })
    on("session.step.failed", (e) => {
      forgetMessage(e.data.sessionID, e.data.assistantMessageID)
      bump()
    })
    on("session.model.selected", (e) => {
      void refreshOffers(e.data.sessionID, true)
    })

    // ---- floor-failure dialog (backoff-prompt mode) ------------------------
    const lastUserText = (sessionID: string) => {
      const users = context.data.session.message.list(sessionID).filter((m: any) => m.type === "user") as any[]
      return users[users.length - 1]?.text?.trim() || undefined
    }
    const onFloor = async (data: { sessionID: string; model: string; currentTier: number | null; targetTier: number | null }) => {
      if (!server.flags.backoffPrompt) return
      const options: { title: string; value: number | null; description?: string }[] = []
      if (data.targetTier) options.push({ title: `Set floor to ≥${data.targetTier}% and retry`, value: data.targetTier, description: "recommended: strictest tier live offers pass" })
      for (const t of TIERS) if (t !== data.targetTier && t < (data.currentTier ?? Infinity)) options.push({ title: `Set floor to ≥${t}% and retry`, value: t })
      options.push({ title: "Set floor to off and retry", value: 0, description: "no minimum discount" })
      options.push({ title: "Cancel", value: null, description: "leave the floor as-is" })
      const tier = await context.ui.dialog.select({ title: `Discount floor ≥${data.currentTier ?? "?"}% not met for ${data.model}`, options })
      if (tier === null || tier === undefined) return
      await call("setOverride", { model: data.model, floor: tier })
      const text = lastUserText(data.sessionID)
      if (!text) return
      context.ui.toast.show({ title: "Surplus", message: `Floor ${tier ? `≥${tier}%` : "off"} — retrying your last message`, variant: "info" })
      await context.client.session.prompt({ sessionID: data.sessionID, text }).catch(() => {})
    }
    try {
      unsubscribers.push(rpc().events.on("floor", (e: any) => void onFloor(e.data)))
      unsubscribers.push(rpc().events.on("changed", () => void refreshState()))
    } catch {}

    // ---- commands ----------------------------------------------------------
    const alert = (title: string, lines: string[]) => context.ui.dialog.alert({ title, message: lines.filter((l) => l !== undefined).join("\n") })
    const requireModel = (title: string) => {
      const sessionID = currentSessionID()
      const { model, providerID } = modelOf(sessionID)
      if (!model) {
        void alert(title, ["No Surplus model is active.", "Select a Surplus Intelligence model first."])
        return undefined
      }
      return { sessionID, model, providerID: providerID ?? "" }
    }
    const afterChange = async (sessionID?: string) => {
      await refreshState()
      await refreshOffers(sessionID, true)
    }

    const commands = [
      {
        id: "surplus.status",
        title: "Surplus status",
        description: "Active model, floor, pin, best discount",
        slash: { name: "surplus-status", aliases: ["surplus"] },
        run: async () => {
          const m = requireModel("Surplus status")
          if (!m) return
          const offers = rankOffers(await rawOffers(m.model))
          const best = offers[0]
          const floor = floorFor(m.model)
          const lines = [
            `Model:    ${m.model}`,
            `Provider: ${m.providerID}`,
            `Floor:    ${floor ? `≥${floor}% (min${floor})` : "off"}`,
            `Pin:      ${pinFor(m.model) ?? "none"}`,
          ]
          if (m.sessionID) {
            const s = sessionUsage(m.sessionID)
            if (s.tokens > 0) lines.push(`Session:  $${s.cost.toFixed(4)} · avg $${s.avgPer1M.toFixed(3)}/1M · ${fmtTokens(s.tokens)} tok`)
          }
          if (best) {
            const passing = TIERS.find((t) => best.discount >= t)
            lines.push(`Best:     ${best.discount}% off (${best.provider}, $${best.inputUsd}/1M in)`)
            lines.push(passing ? `Strictest floor that passes: ≥${passing}%` : "No floor tier currently passes.")
          } else lines.push("No healthy offers right now.")
          await alert("Surplus status", lines)
        },
      },
      {
        id: "surplus.offers",
        title: "Surplus offers",
        description: "Live marketplace offers for the active model",
        slash: { name: "surplus-offers" },
        run: async () => {
          const m = requireModel("Surplus offers")
          if (!m) return
          const offers = rankOffers(await rawOffers(m.model, config.filterByPin))
          if (!offers.length) return void (await alert("Surplus offers", [`No healthy offers for ${m.model} right now.`]))
          const best = offers[0]
          const passing = TIERS.find((t) => best.discount >= t)
          await alert("Surplus offers", [
            `Healthy offers for ${m.model}${config.filterByPin && pinFor(m.model) ? " (filtered to pin)" : ""} (best ${best.discount}% off):`,
            ...offers.slice(0, 10).map((o, i) => `${i + 1}. ${o.provider} ${o.host} — $${o.inputUsd.toFixed(4)}/1M in (~${o.discount}% off)`),
            passing ? `\nStrictest floor that passes: ≥${passing}%` : "\nNo floor tier currently passes.",
          ])
        },
      },
      {
        id: "surplus.tier",
        title: "Surplus tier",
        description: "Set the discount floor for the active model (≥70/80/90/95% or off)",
        slash: { name: "surplus-tier" },
        run: async () => {
          const m = requireModel("Surplus tier")
          if (!m) return
          const tier = await context.ui.dialog.select<number>({
            title: `Discount floor for ${m.model}`,
            placeholder: "Select a floor…",
            current: floorFor(m.model) ?? 0,
            options: [
              { title: "Off (no minimum)", value: 0, description: "Surplus routes to any seller" },
              ...TIERS.map((t) => ({ title: `≥${t}% off (min${t})`, value: t as number, description: `only sellers at least ${t}% below list` })),
            ],
          })
          if (tier === undefined) return
          await call("setOverride", { model: m.model, floor: tier })
          await afterChange(m.sessionID)
          context.ui.toast.show({ title: "Surplus", message: tier ? `Floor for ${m.model}: ≥${tier}% (next request)` : `Floor for ${m.model}: off`, variant: "success" })
        },
      },
      {
        id: "surplus.spend",
        title: "Surplus spend",
        description: "Today's and this session's spend and average price per 1M tokens",
        slash: { name: "surplus-spend" },
        run: async () => {
          await refreshSpend()
          const u = spend.today
          const lines = [`Today's settled spend: ${u ? `$${u.cost.toFixed(4)}` : "--"}`]
          if (u) {
            lines.push(`Today's tokens: ${fmtTokens(u.tokens)} (avg $${u.avgPer1M.toFixed(3)}/1M)`)
            if (u.direct && u.discountPct !== undefined) lines.push(`Savings vs list: $${(u.direct - u.cost).toFixed(4)} (${u.discountPct}% off)`)
          }
          const sessionID = currentSessionID()
          if (sessionID) {
            const s = sessionUsage(sessionID)
            lines.push(
              s.tokens > 0
                ? `This session: $${s.cost.toFixed(4)} · ${fmtTokens(s.tokens)} tok (avg $${s.avgPer1M.toFixed(3)}/1M)`
                : "This session: no completed assistant turns yet.",
            )
          }
          await alert("Surplus spend", lines)
        },
      },
      {
        id: "surplus.pin",
        title: "Surplus pin",
        description: "Pin/unpin routing for the active model to a seller host",
        slash: { name: "surplus-pin" },
        run: async () => {
          const m = requireModel("Surplus pin")
          if (!m) return
          const offers = rankOffers(await rawOffers(m.model))
          const base = server.basePins[m.model]
          const options: { title: string; value: string; description?: string }[] = []
          if (base) options.push({ title: "Reset to baseline", value: `base:${base}`, description: base })
          options.push({ title: "Clear pin", value: "clear", description: "no pin; Surplus picks the best seller per request" })
          for (const o of offers.slice(0, 8)) options.push({ title: `${o.provider} — ${o.discount}% off`, value: `host:${o.host}`, description: `${o.host} · $${o.inputUsd.toFixed(4)}/1M in` })
          options.push({ title: "Custom host URL…", value: "custom", description: "type a seller base URL (https://host/v1)" })
          const picked = await context.ui.dialog.select({ title: `Pin for ${m.model}`, placeholder: "Select a host…", options })
          if (picked === undefined) return
          let pin: string | null
          if (picked === "clear") pin = null
          else if (picked === "custom") {
            const value = (await context.ui.dialog.prompt({ title: `Pin ${m.model} to a host`, placeholder: "https://host/v1" }))?.trim()
            if (!value) return
            pin = value
          } else pin = picked.slice(picked.indexOf(":") + 1)
          await call("setOverride", { model: m.model, pin })
          await afterChange(m.sessionID)
          context.ui.toast.show({ title: "Surplus", message: `Pinned ${m.model} -> ${shortPin(pin)} (next request)`, variant: "success" })
        },
      },
      {
        id: "surplus.clear",
        title: "Surplus clear",
        description: "Clear pin/floor overrides for the active model",
        slash: { name: "surplus-clear" },
        run: async () => {
          const m = requireModel("Surplus clear")
          if (!m) return
          if (!server.overrides[m.model]) return void (await alert("Surplus clear", [`No overrides stored for ${m.model}.`]))
          await call("setOverride", { model: m.model, clear: true })
          await afterChange(m.sessionID)
          context.ui.toast.show({ title: "Surplus", message: `Cleared overrides for ${m.model}`, variant: "success" })
        },
      },
      {
        id: "surplus.flag",
        title: "Surplus flag",
        description: "Toggle backoff-prompt mode (adjust-floor dialog on floor failure)",
        slash: { name: "surplus-flag" },
        run: async () => {
          const value = await context.ui.dialog.select<boolean>({
            title: "Surplus backoff-prompt mode",
            current: server.flags.backoffPrompt ?? false,
            options: [
              { title: "ON — prompt to adjust the floor on failure", value: true },
              { title: "OFF — normal failure message, no prompt", value: false },
            ],
          })
          if (value === undefined) return
          await call("setFlags", { backoffPrompt: value })
          await refreshState()
          context.ui.toast.show({ title: "Surplus", message: `Backoff-prompt mode ${value ? "ON" : "OFF"}`, variant: "success" })
        },
      },
      {
        id: "surplus.models",
        title: "Surplus models",
        description: "List the discovered Surplus model catalog",
        slash: { name: "surplus-models" },
        run: async () => {
          const { models } = await call<{ models: { id: string; name: string }[] }>("models", undefined, { models: [] })
          if (!models?.length) return void (await alert("Surplus models", ["No models discovered yet (discovery runs in the background at startup)."]))
          const active = modelOf(currentSessionID()).model
          await alert("Surplus models", [
            `Discovered ${models.length} Surplus models.`,
            ...models.slice(0, 25).map((m) => `${m.id === active ? "* " : "  "}${m.id} (${m.name})`),
            models.length > 25 ? `\n… and ${models.length - 25} more (use the surplus_models tool with a query).` : "",
          ])
        },
      },
      {
        id: "surplus.tui",
        title: "Surplus TUI toggle",
        description: "Hide or show the Surplus meter and sidebar blocks for this TUI session",
        slash: { name: "surplus-tui" },
        run: () => {
          setVisible(!visible())
          context.ui.toast.show({ title: "Surplus", message: visible() ? "Surplus display shown" : "Surplus display hidden (/surplus-tui to show)", variant: "info" })
        },
      },
    ]
    context.keymap.layer(() => ({
      mode: "global",
      commands: commands.map((c) => ({ ...c, group: "Surplus", palette: true as const })),
    }))

    // ---- views -------------------------------------------------------------
    const Meter = (props: { sessionID: string }) => {
      const view = () => {
        tick()
        const stats = tracker.stats[props.sessionID]
        const cal = median(stats?.ratios ?? [])
        const now = Date.now()
        const samples = (tracker.samples[props.sessionID] ?? []).filter((s) => s.at >= now - WINDOW_MS)
        const last = samples[samples.length - 1]
        const live =
          last && now - last.at <= STALE_MS
            ? (samples.reduce((sum, s) => sum + s.raw, 0) * cal) / (Math.max(now - samples[0].at, MIN_DURATION_MS) / 1000)
            : undefined
        const avg = stats && stats.ms > 0 ? stats.out / (stats.ms / 1000) : undefined
        const ttft = tracker.ttft[props.sessionID]
        const tpsColor = (v: number) => (v < config.tps.slow ? color.error() : v < config.tps.normal ? color.warning() : v < config.tps.fast ? color.success() : color.accent())
        const ttftColor = (v: number) => (v < config.ttft.fast ? color.success() : v < config.ttft.ok ? color.warning() : color.error())
        const thinking = tracker.thinking[props.sessionID] === true && config.spinner.enabled
        const bright = gradientColor(config.spinner.colors, (hueFrame % 60) / 60)
        return {
          live: live !== undefined ? (formatTps(live) ?? "--") : "--",
          liveFg: live !== undefined ? tpsColor(live) : color.muted(),
          avg: avg !== undefined ? (formatTps(avg) ?? "--") : "--",
          avgFg: avg !== undefined ? tpsColor(avg) : color.muted(),
          ttft: ttft !== undefined ? `${(ttft / 1000).toFixed(1)}s` : "--",
          ttftFg: ttft !== undefined ? ttftColor(ttft) : color.muted(),
          spinner: thinking ? " " + stream.join("") : "",
          spinnerFg: thinking ? lerpColor(bright, color.muted(), 0.2) : color.muted(),
        }
      }
      return (
        <box flexDirection="row">
          <text fg={color.muted()}>TPS </text>
          <text fg={view().liveFg}>{view().live}</text>
          <text fg={color.muted()}> · AVG </text>
          <text fg={view().avgFg}>{view().avg}</text>
          <text fg={color.muted()}> · TTFT </text>
          <text fg={view().ttftFg}>{view().ttft}</text>
          <text fg={view().spinnerFg}>{view().spinner}</text>
        </box>
      )
    }

    const Today = () => {
      const u = () => {
        tick()
        return spend.today
      }
      return (
        <box flexDirection="column">
          <text fg={color.text()}>
            <b>Today</b>
          </text>
          <box flexDirection="row">
            <text fg={u()?.discountPct !== undefined ? discountColor(u()!.discountPct!) : color.muted()}>
              {u()?.discountPct !== undefined ? `${u()!.discountPct!.toFixed(1)}% off` : u() ? "--" : "no settled usage yet"}
            </text>
            <text fg={color.muted()}>{u() ? ` · $${u()!.avgPer1M.toFixed(3)}/1M · $${u()!.cost.toFixed(4)}` : ""}</text>
          </box>
        </box>
      )
    }

    const Footer = (props: { sessionID: string }) => {
      const view = () => {
        tick()
        const { model } = modelOf(props.sessionID)
        if (model && spend.offersFor !== model) void refreshOffers(props.sessionID)
        const s = model ? sessionUsage(props.sessionID) : undefined
        return { model, floor: model ? floorFor(model) : undefined, pin: model ? pinFor(model) : undefined, offers: model ? spend.offers : [], session: s }
      }
      return (
        <Show when={view().model}>
          <box flexDirection="column">
            <box flexDirection="row">
              <text fg={color.muted()}>Floor </text>
              <text fg={color.accent()}>{view().floor ? `≥${view().floor}% (min${view().floor})` : "off"}</text>
            </box>
            <For each={view().offers}>
              {(o) => (
                <box flexDirection="row">
                  <text fg={discountColor(o.discount)}>{`${o.discount.toFixed(1)}% off`}</text>
                  <text fg={color.muted()}>{` · $${o.price.toFixed(5)}/1M · ${o.provider}`}</text>
                </box>
              )}
            </For>
            <box flexDirection="row">
              <text fg={color.muted()}>Pin   </text>
              <text fg={color.muted()}>{shortPin(view().pin)}</text>
            </box>
            <Show when={(view().session?.tokens ?? 0) > 0}>
              <text fg={color.accent()}>
                {`${view().session?.discountPct !== undefined ? view().session!.discountPct!.toFixed(1) : "--"}% off · $${view().session!.avgPer1M.toFixed(5)}/1M · ${fmtTokens(view().session!.tokens, 1)} tok`}
              </text>
            </Show>
          </box>
        </Show>
      )
    }

    const unslot = [
      context.ui.slot({
        append: "prompt.footer.status",
        render: (input) => (
          <Show when={visible() && input.sessionID}>
            <Meter sessionID={input.sessionID!} />
          </Show>
        ),
      }),
      context.ui.slot({
        append: "sidebar.content",
        render: () => (
          <Show when={visible()}>
            <Today />
          </Show>
        ),
      }),
      context.ui.slot({
        append: "sidebar.footer",
        render: (input) => (
          <Show when={visible()}>
            <Footer sessionID={input.sessionID} />
          </Show>
        ),
      }),
    ]

    // ---- startup + timers --------------------------------------------------
    await refreshState()
    calib = await call<CalibStore>("calibration", undefined, calib)
    if (!calib?.rates) calib = { rates: {}, pairs: {} }
    void refreshSpend()
    const timers = [
      setInterval(() => void refreshSpend(), 30_000),
      setInterval(() => void refreshOffers(currentSessionID(), true), 60_000),
      // prune stale TPS samples and repaint the live meter
      setInterval(() => {
        const cutoff = Date.now() - WINDOW_MS
        for (const [sid, samples] of Object.entries(tracker.samples)) {
          const pruned = samples.filter((s) => s.at >= cutoff)
          if (pruned.length) tracker.samples[sid] = pruned
          else delete tracker.samples[sid]
        }
        bump()
      }, 1000),
    ]

    return () => {
      for (const t of timers) clearInterval(t)
      if (spinnerTimer) clearInterval(spinnerTimer)
      for (const u of unsubscribers) u()
      for (const u of unslot) u()
    }
  },
})
