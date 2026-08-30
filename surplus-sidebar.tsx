/** @jsxImportSource @opentui/solid */
// surplus-sidebar.tsx
// TUI (interface) plugin for opencode showing Surplus Intelligence status.
//
// WHAT IT ADDS
//   • A live tokens-per-second meter (TPS | AVG | TTFT) next to the input box.
//   • A "Today" block at the top of the sidebar: today's blended $/1M, % off
//     vs list, and total spend (from Surplus's settled usage records).
//   • In the sidebar footer: the discount floor, top 3 marketplace offers
//     (blended to your usage), the routing pin, and this session's
//     cost / avg $/1M / token total.
//   • `/surplus-*` TUI commands (no LLM round-trip):
//       /surplus-status (alias /surplus) — model, provider, floor, pin, offers
//       /surplus-offers   — top healthy sellers for the active model
//       /surplus-tier     — strictest discount tier provider that passes
//       /surplus-spend    — today + this session's spend and averages
//       /surplus-pin      — interactive picker to pin a seller host
//       /surplus-clear    — clear stored overrides for the active model
//
// INSTALL
//   Copy this file to `~/.config/opencode/surplus-sidebar.tsx` and reference it
//   in `~/.config/opencode/tui.json`:
//       { "plugin": ["./surplus-sidebar.tsx"] }
//   Restart opencode. (The companion server plugin `surplus-control.js` goes in
//   `~/.config/opencode/plugins/` and is optional.)
//
// REQUIREMENTS
//   - opencode 1.18.x (TUI plugin API).
//   - A Surplus Intelligence API key in opencode's auth.json (provider ID
//     starting with "surplus"). The plugin reads the key at runtime — it is
//     never embedded here.
//   - Surplus providers configured in opencode.json so requests route through
//     the /min{N} URLs (see README). Without them the sidebar simply hides the
//     surplus-specific rows.
//
// CONFIGURATION (optional, via tui.json tuple form)
//   ["./surplus-sidebar.tsx", {
//     "spinner": { "theme": "tech", "intervalMs": 100, "cells": 6 },
//     "tiers":   { "tps": { "slow": 20, "normal": 50, "fast": 100 },
//                  "ttft": { "fast": 10000, "ok": 20000 } }
//   }]
//
// PRICING NUMBERS
//   "Today" and offer prices are blended averages based on your real usage:
//   - Today avg $/1M = settled cost / total tokens (input already includes
//     cached prompt tokens, priced at Surplus's cache-read rate).
//   - Offer $/1M = each seller's per-token rates weighted by your actual
//     input/output mix, adjusted for your cache-hit fraction (capped at 95%).
//   Session totals (cost / tokens) come from opencode's authoritative session
//   record and include cached tokens.
//
// NO SECRETS HERE: the API key and wallet are never in this file.
// See README.md in the package root for full install and troubleshooting.

import { RGBA } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { PluginOptions } from "@opencode-ai/plugin"
import { onCleanup } from "solid-js"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"

type DeltaSample = { at: number; rawTokens: number }

type SessionStats = {
  totalOutputTokens: number
  totalDurationMs: number
  calibrationRatios: number[]
}

type TrackerState = {
  useV2Events: boolean
  samplesBySession: Record<string, DeltaSample[]>
  messageCreatedAt: Record<string, number>
  firstDeltaByMessage: Record<string, number>
  lastDeltaByMessage: Record<string, number>
  estimatedTokensByMessage: Record<string, number>
  liveTtftBySession: Record<string, number>
  activeMessageBySession: Record<string, string | undefined>
  statsBySession: Record<string, SessionStats>
  thinkingBySession: Record<string, boolean>
}

type Listener = () => void

type TpsTiers = { slow: number; normal: number; fast: number }
type TtftTiers = { fast: number; ok: number }
type SpinnerCfg = { colors: RGBA[]; intervalMs: number; enabled: boolean; cells: number }
type ResolvedConfig = { enabled: boolean; filterByPin: boolean; spinner: SpinnerCfg; tps: TpsTiers; ttft: TtftTiers }

const TIERS = [95, 90, 80, 70] as const

type Offer = { provider: string; price: number; discount: number }
type Usage = { cost: number; tokens: number; avgPer1M: number; direct?: number; discountPct?: number; cacheRead?: number; in?: number; out?: number; input?: number }

// One settled (or accrued) Surplus usage record for today's export CSV.
type SettledRow = { at: number; model: string; inT: number; outT: number; cost: number; direct: number }

type SpendState = {
  today?: number
  todayTokens?: number
  todayAvgUsd?: number
  todayDiscountPct?: number
  todayIn?: number
  todayOut?: number
  sessionCost?: number
  sessionTokens?: number
  sessionAvgUsd?: number
  loading: boolean
  offers: Offer[]
  model?: string
  providerID?: string
  limit?: number
  pin?: string
  floor?: number
  loadingModel?: string
}

// ---------------------------------------------------------------------------
// Surplus data layer: reading the API key, settled-usage records, and the
// live marketplace offers. All pricing here is "blended" to the user's real
// usage so the numbers reflect actual cost, not sticker prices.
// ---------------------------------------------------------------------------

// Locate the Surplus API key in opencode's auth.json (provider ID starting
// with "surplus"). Returns undefined if none is configured; the plugin then
// hides surplus-specific rows instead of erroring.
function surplusKey() {
  for (const base of [process.env.XDG_DATA_HOME, `${homedir()}/.local/share`]) {
    const path = base && `${base}/opencode/auth.json`
    if (!path || !existsSync(path)) continue
    try {
      const auth = JSON.parse(readFileSync(path, "utf8"))
      for (const [id, value] of Object.entries(auth)) {
        if (id.startsWith("surplus") && (value as { key?: string })?.key) return (value as { key: string }).key
      }
    } catch {}
  }
  return undefined
}

function csvFields(line: string) {
  const fields: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; continue }
      quoted = !quoted
    } else if (char === "," && !quoted) {
      fields.push(field); field = ""
    } else field += char
  }
  fields.push(field)
  return fields
}

async function fetchSettledRows(): Promise<SettledRow[]> {
  const key = surplusKey()
  if (!key) return []
  const now = new Date()
  const from = now.toISOString().slice(0, 10)
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10)
  const response = await fetch(
    `https://api.surplusintelligence.ai/v1/buyer/usage/export?format=csv&from=${from}&to=${tomorrow}`,
    { headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" } },
  )
  if (!response.ok) return []
  const lines = (await response.text()).trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const header = csvFields(lines[0])
  const iAt = header.indexOf("created_at")
  const iModel = header.indexOf("model")
  const iIn = header.indexOf("input_tokens")
  const iOut = header.indexOf("output_tokens")
  const iCost = header.indexOf("buyer_cost_usd") >= 0 ? header.indexOf("buyer_cost_usd") : header.indexOf("cost_usd")
  const iDirect = header.indexOf("direct_cost_usd")
  if (iCost < 0) return []
  const rows: SettledRow[] = []
  for (const line of lines.slice(1)) {
    const f = csvFields(line)
    rows.push({
      at: iAt >= 0 ? +new Date(f[iAt]) : 0,
      model: iModel >= 0 ? f[iModel] ?? "" : "",
      inT: iIn >= 0 ? Number(f[iIn]) || 0 : 0,
      outT: iOut >= 0 ? Number(f[iOut]) || 0 : 0,
      cost: Number(f[iCost]) || 0,
      direct: iDirect >= 0 ? Number(f[iDirect]) || 0 : 0,
    })
  }
  return rows
}

async function actualTodayUsage(rows?: SettledRow[]): Promise<Usage | undefined> {
  if (!rows) rows = await fetchSettledRows()
  if (!rows.length) return undefined
  let cost = 0
  let direct = 0
  let tokens = 0
  let inTokens = 0
  let outTokens = 0
  for (const r of rows) {
    cost += r.cost
    direct += r.direct
    tokens += r.inT + r.outT
    inTokens += r.inT
    outTokens += r.outT
  }
  return {
    cost,
    tokens,
    avgPer1M: tokens > 0 ? (cost / tokens) * 1e6 : 0,
    direct,
    discountPct: cost > 0 && direct > 0 ? Math.round((1 - cost / direct) * 1000) / 10 : undefined,
    in: inTokens,
    out: outTokens,
  }
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "--"
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return `${Math.round(n)}`
}

// EXAMPLE ONLY — not a requirement.
// The author's personal routing pins (GLM models -> the Z.ai coding host) so
// prompt caches stay warm. Delete or replace with your own; an empty map means
// "no baseline pins" and Surplus routes to the best seller per request.
const BASE_PINS: Record<string, string> = {
  "glm-5.2": "zai-coding",
  "glm-5.3": "zai-coding",
}

function readSurplusOverrides() {
  try {
    return JSON.parse(readFileSync(`${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/opencode/surplus-control.json`, "utf8"))
  } catch {
    return {}
  }
}

// Blend a seller's per-token rates into a single $/1M figure using the user's
// actual input:output mix (from today's settled usage) and their actual cache-hit
// fraction (from the session). The offers API exposes no cache price, so the
// standard 10% cache-read rate is applied to the user's cached share of input.
// When `filterByPin` is set, only offers matching the model's routing pin are kept.
async function currentOffers(model: string, wIn = 0.75, cacheFrac = 0, filterByPin = false, pin?: string) {
  const key = surplusKey()
  if (!key) return { offers: [] }
  const response = await fetch(`https://api.surplusintelligence.ai/api/markets/${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
  })
  if (!response.ok) return { offers: [] }
  const data = await response.json()
  let all = (data.offers ?? []).filter((o: any) => o.available && o.healthy && o.direct_input_per_1m > 0 && o.direct_output_per_1m > 0)
  if (filterByPin && pin) all = filterOffersByPin(all, pin)
  const wOut = 1 - wIn
  const cacheAdj = 1 - 0.9 * Math.min(Math.max(cacheFrac, 0), 0.95)
  const offers = all
    .map((o: any) => {
      const effIn = o.price_input_per_1m * cacheAdj
      const effDirectIn = o.direct_input_per_1m * cacheAdj
      const price = (wIn * effIn + wOut * o.price_output_per_1m) / 1e6
      const direct = (wIn * effDirectIn + wOut * o.direct_output_per_1m) / 1e6
      return {
        provider: o.provider,
        price,
        discount: Math.round((1 - price / direct) * 1000) / 10,
      }
    })
    .sort((a: any, b: any) => a.price - b.price)
    .slice(0, 3)
  return { offers }
}

// Keep only offers for a pinned seller. A pin is either a host URL
// (https://host/v1 -> hostname match on seller_base_url) or a provider family
// name (e.g. "zai-coding" -> provider/URL substring match).
function filterOffersByPin(offers: any[], pin: string | undefined) {
  if (!pin) return offers
  const isURL = /^https?:\/\//.test(pin)
  const host = isURL ? new URL(pin).hostname : undefined
  return offers.filter((o) => {
    if (isURL) {
      try {
        return new URL(o.seller_base_url).hostname === host
      } catch {
        return false
      }
    }
    const prov = String(o.provider ?? "").toLowerCase()
    const url = String(o.seller_base_url ?? "").toLowerCase()
    return prov.includes(pin.toLowerCase()) || url.includes(pin.toLowerCase())
  })
}

function activePinFor(model: string): string | undefined {
  const overrides = readSurplusOverrides()[model]
  return overrides?.pin !== undefined ? overrides.pin : BASE_PINS[model]
}

// ---------------------------------------------------------------------------
// Sidebar UI components.
//   TodayBlock   — "Today" spend block, rendered at the top of the sidebar in
//                  the `sidebar_content` slot, under opencode's Context panel.
//   SpendDisplay — routing + session stats, rendered in the `sidebar_footer`
//                  slot: floor, top offers, pin, and this session's totals.
// ---------------------------------------------------------------------------

// "Today" block: today's blended price, % off vs list, and total settled spend.
function TodayBlock(props: { api: Parameters<TuiPlugin>[0]; spend: SpendState; subscribe: (listener: Listener) => () => void }) {
  let pctRef: TextRenderable | undefined
  let priceRef: TextRenderable | undefined
  let amtRef: TextRenderable | undefined
  const sync = () => {
    const theme = props.api.theme.current
    const today = props.spend.today
    const pct = props.spend.todayDiscountPct
    const avg = props.spend.todayAvgUsd
    if (pctRef) {
      pctRef.content = pct !== undefined ? `${pct.toFixed(1)}% off` : (today === undefined ? "" : "--")
      pctRef.fg = pct !== undefined
        ? pct >= 90 ? theme.success : pct >= 80 ? theme.warning : theme.error
        : theme.textMuted
    }
    if (priceRef) priceRef.content = avg !== undefined ? ` · $${avg.toFixed(3)}/1M` : ""
    if (amtRef) amtRef.content = today !== undefined ? ` · $${today.toFixed(4)}` : ""
    props.api.renderer.requestRender()
  }
  const unsubscribe = props.subscribe(sync)
  onCleanup(unsubscribe)
  sync()
  const muted = props.api.theme.current.textMuted
  const text = props.api.theme.current.text
  return (
    <box flexDirection="column">
      <text fg={text}>
        <b>Today</b>
      </text>
      <box flexDirection="row">
        <text ref={(el: TextRenderable) => { pctRef = el; sync() }} fg={muted}></text>
        <text ref={(el: TextRenderable) => { priceRef = el; sync() }} fg={muted}></text>
        <text ref={(el: TextRenderable) => { amtRef = el; sync() }} fg={muted}></text>
      </box>
    </box>
  )
}

function SpendDisplay(props: { api: Parameters<TuiPlugin>[0]; sessionID: string; spend: SpendState; config: ResolvedConfig; subscribe: (listener: Listener) => () => void }) {
  let floorRef: TextRenderable | undefined
  let offerPctRefs: (TextRenderable | undefined)[] = []
  let offerPriceRefs: (TextRenderable | undefined)[] = []
  let offerProvRefs: (TextRenderable | undefined)[] = []
  let pinRef: TextRenderable | undefined
  let sessRef: TextRenderable | undefined
  let sync = () => {}
  const loadModel = async () => {
    const messages = props.api.state.session.messages(props.sessionID)
    const latest = [...messages].reverse().find((message) => message.role === "assistant" || message.role === "user")
    const stored = props.api.state.session.get(props.sessionID)?.model
    const fallback = latest
      ? latest.role === "assistant"
        ? { id: latest.modelID, providerID: latest.providerID, variant: latest.variant }
        : { id: latest.model.modelID, providerID: latest.model.providerID, variant: latest.model.variant }
      : undefined
    const model = stored ?? fallback
    const providerID = model?.providerID
    const modelID = providerID?.startsWith("surplus") ? normalizeModelID(model.id) : undefined
    if (!modelID) {
      props.spend.model = undefined
      props.spend.providerID = undefined
      props.spend.offers = []
      props.spend.limit = undefined
      props.spend.pin = undefined
      props.spend.floor = undefined
      return
    }
    const overrides = readSurplusOverrides()[modelID] ?? {}
    const pin = overrides.pin !== undefined ? overrides.pin : BASE_PINS[modelID]
    const floor = overrides.floor !== undefined ? overrides.floor : tierFloor(providerID)
    // Refresh pin/floor on every pass so /surplus-tier + /surplus-pin changes
    // show immediately; the guards below only short-circuit the offers fetch.
    props.spend.pin = pin
    props.spend.floor = floor
    if (props.spend.loadingModel === modelID) return
    if (props.spend.model === modelID && props.spend.providerID === providerID) return
    props.spend.model = modelID
    props.spend.providerID = providerID
    props.spend.offers = []
    props.spend.limit = undefined
    props.spend.loadingModel = modelID
    try {
      const bw = blendWeights(props.spend, props.api, props.sessionID)
      const result = await currentOffers(modelID, bw.wIn, bw.cacheFrac, props.config.filterByPin, pin)
      props.spend.offers = result.offers
      if (overrides.maxPrice != null) props.spend.limit = overrides.maxPrice
    } catch {}
    props.spend.loadingModel = undefined
    sync()
  }
  sync = () => {
    const theme = props.api.theme.current
    void loadModel()
    const surplus = props.spend.model !== undefined
    const floor = props.spend.floor
    if (floorRef) { floorRef.content = surplus ? (floor !== undefined && floor > 0 ? `≥${floor}% (min${floor})` : "--") : ""; floorRef.fg = surplus ? theme.accent : theme.textMuted }
    for (let i = 0; i < offerPctRefs.length; i++) {
      const offer = props.spend.offers[i]
      if (offerPctRefs[i]) {
        offerPctRefs[i]!.content = surplus && offer ? `${offer.discount.toFixed(1)}% off` : ""
        offerPctRefs[i]!.fg = surplus && offer
          ? offer.discount >= 90 ? theme.success : offer.discount >= 80 ? theme.warning : theme.error
          : theme.textMuted
      }
      if (offerPriceRefs[i]) { offerPriceRefs[i]!.content = surplus && offer ? ` · $${offer.price.toFixed(5)}/1M` : ""; offerPriceRefs[i]!.fg = theme.textMuted }
      if (offerProvRefs[i]) { offerProvRefs[i]!.content = surplus && offer ? ` · ${offer.provider}` : ""; offerProvRefs[i]!.fg = theme.textMuted }
    }
    if (pinRef) { pinRef.content = surplus ? shortPin(props.spend.pin) : ""; pinRef.fg = theme.textMuted }
    const session = sessionUsage(props.api, props.sessionID)
    props.spend.sessionCost = session.cost
    props.spend.sessionTokens = session.tokens
    props.spend.sessionAvgUsd = session.avgPer1M
    if (sessRef) { sessRef.content = session.tokens > 0 ? `$${session.cost.toFixed(4)} · avg $${session.avgPer1M.toFixed(3)}/1M · ${fmtTokens(session.tokens)} tok` : ""; sessRef.fg = theme.accent }
    props.api.renderer.requestRender()
  }
  const unsubscribe = props.subscribe(sync)
  onCleanup(unsubscribe)
  sync()
  const muted = props.api.theme.current.textMuted
  const accent = props.api.theme.current.accent
  return (
    <box flexDirection="column">
      <box flexDirection="row"><text fg={muted}>Floor  </text><text ref={(el: TextRenderable) => { floorRef = el; sync() }} fg={accent}></text></box>
      {[0, 1, 2].map((i) => (
        <box flexDirection="row">
          <text ref={(el: TextRenderable) => { offerPctRefs[i] = el; sync() }} fg={muted}></text>
          <text ref={(el: TextRenderable) => { offerPriceRefs[i] = el; sync() }} fg={muted}></text>
          <text ref={(el: TextRenderable) => { offerProvRefs[i] = el; sync() }} fg={muted}></text>
        </box>
      ))}
      <box flexDirection="row"><text fg={muted}>Pin    </text><text ref={(el: TextRenderable) => { pinRef = el; sync() }} fg={muted}></text></box>
      <box flexDirection="row"><text ref={(el: TextRenderable) => { sessRef = el; sync() }} fg={accent}></text></box>
    </box>
  )
}

const THEME_PRESETS: Record<string, string[]> = {
  tech: ["#00e5ff", "#2979ff", "#651fff"],
  red: ["#ff1744", "#ff5252", "#ff8a80"],
}

// ---------------------------------------------------------------------------
// TPS meter: estimates live generation speed from streaming text/reasoning
// deltas, calibrating its byte-based estimates against opencode's reported
// token counts. Rendered next to the input box via `session_prompt_right`.
// ---------------------------------------------------------------------------

function resolveConfig(options: PluginOptions | undefined): ResolvedConfig {
  const o = (options ?? {}) as {
    enabled?: boolean
    offers?: { filterByPin?: boolean }
    spinner?: { theme?: string; colors?: string[]; intervalMs?: number; enabled?: boolean; cells?: number }
    tiers?: { tps?: Partial<TpsTiers>; ttft?: Partial<TtftTiers> }
  }
  const sp = o.spinner ?? {}
  let colors: RGBA[]
  if (Array.isArray(sp.colors) && sp.colors.length > 0) {
    colors = sp.colors.map((c) => RGBA.fromHex(c))
  } else {
    const preset = THEME_PRESETS[sp.theme ?? "tech"] ?? THEME_PRESETS.tech
    colors = preset.map((c) => RGBA.fromHex(c))
  }
  const cells = typeof sp.cells === "number" && sp.cells >= 2 ? Math.floor(sp.cells) : 6
  const spinner: SpinnerCfg = {
    colors,
    intervalMs: typeof sp.intervalMs === "number" && sp.intervalMs > 0 ? sp.intervalMs : 100,
    enabled: sp.enabled !== false && (sp.theme ?? "tech") !== "none",
    cells,
  }
  const tiers = o.tiers ?? {}
  const tp = tiers.tps ?? {}
  const tt = tiers.ttft ?? {}
  return {
    enabled: o.enabled !== false,
    filterByPin: o.offers?.filterByPin ?? false,
    spinner,
    tps: { slow: tp.slow ?? 20, normal: tp.normal ?? 50, fast: tp.fast ?? 100 },
    ttft: { fast: tt.fast ?? 10000, ok: tt.ok ?? 20000 },
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
function lerpColor(a: RGBA, b: RGBA, t: number): RGBA {
  return RGBA.fromValues(lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t), 1)
}
function gradientColor(colors: RGBA[], t: number): RGBA {
  if (colors.length === 0) return RGBA.fromHex("#888888")
  if (colors.length === 1) return colors[0]
  const c = Math.max(0, Math.min(1, t))
  const seg = c * (colors.length - 1)
  const i = Math.min(Math.floor(seg), colors.length - 2)
  const f = seg - i
  return lerpColor(colors[i], colors[i + 1], f)
}

const WINDOW_MS = 5_000
const STALE_MS = 1_500
const MIN_DURATION_MS = 1_000
const MAX_CALIBRATION_RATIOS = 10

function estimateTokens(delta: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 4))
}

function formatTps(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 100) return Math.round(value).toString()
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

function formatTtft(valueMs: number): string | undefined {
  if (!Number.isFinite(valueMs) || valueMs < 0) return undefined
  return `${(valueMs / 1000).toFixed(1)}s`
}

type SpeedTier = "slow" | "normal" | "fast" | "faster"
function speedTier(tps: number, c: TpsTiers): SpeedTier {
  if (tps < c.slow) return "slow"
  if (tps < c.normal) return "normal"
  if (tps < c.fast) return "fast"
  return "faster"
}
function tierColor(tier: SpeedTier, theme: TuiThemeCurrent): RGBA {
  switch (tier) {
    case "slow": return theme.error
    case "normal": return theme.warning
    case "fast": return theme.success
    case "faster": return theme.accent
  }
}
function tpsColor(tps: number, c: TpsTiers, theme: TuiThemeCurrent): RGBA {
  return tierColor(speedTier(tps, c), theme)
}

type TtftTier = "fast" | "ok" | "slow"
function ttftTier(ms: number, c: TtftTiers): TtftTier {
  if (ms < c.fast) return "fast"
  if (ms < c.ok) return "ok"
  return "slow"
}
function ttftColor(ms: number, c: TtftTiers, theme: TuiThemeCurrent): RGBA {
  switch (ttftTier(ms, c)) {
    case "fast": return theme.success
    case "ok": return theme.warning
    case "slow": return theme.error
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 1.0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 !== 0) return sorted[mid]
  return Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 1e10) / 1e10
}
function calibrationFactor(ratios: number[]): number {
  return ratios.length === 0 ? 1.0 : median(ratios)
}

function calculateLiveTps(samples: DeltaSample[], now: number, calibration: number): number | undefined {
  if (samples.length === 0) return undefined
  const cutoff = now - WINDOW_MS
  const relevant = samples.filter((s) => s.at >= cutoff)
  if (relevant.length === 0) return undefined
  const last = relevant[relevant.length - 1]
  if (now - last.at > STALE_MS) return undefined
  const oldest = relevant[0]
  const durationMs = Math.max(now - oldest.at, MIN_DURATION_MS)
  const totalRaw = relevant.reduce((sum, s) => sum + s.rawTokens, 0)
  return (totalRaw * calibration) / (durationMs / 1000)
}

function recordDelta(tracker: TrackerState, sessionID: string, messageID: string, at: number, delta: string) {
  const rawTokens = estimateTokens(delta)
  const cutoff = at - WINDOW_MS
  const existing = tracker.samplesBySession[sessionID] ?? []
  tracker.samplesBySession[sessionID] = [...existing.filter((s) => s.at >= cutoff), { at, rawTokens }]
  if (tracker.firstDeltaByMessage[messageID] === undefined) {
    tracker.firstDeltaByMessage[messageID] = at
    const created = tracker.messageCreatedAt[messageID]
    if (created !== undefined) {
      tracker.liveTtftBySession[sessionID] = Math.max(0, at - created)
    }
  }
  tracker.lastDeltaByMessage[messageID] = at
  tracker.estimatedTokensByMessage[messageID] = (tracker.estimatedTokensByMessage[messageID] ?? 0) + rawTokens
  tracker.activeMessageBySession[sessionID] = messageID
}

const DOT_GLYPHS = ["⠁", "⠂", "⠄", "⠈", "⠐", "⠠", "⠒", "⠑", "⠡", "⠢", "⠤", "⠨", "⠰", "⠸", "⠘", "⠔", "⠖", "⠦"]

function MeterDisplay(props: {
  api: Parameters<TuiPlugin>[0]
  sessionID: string
  tracker: TrackerState
  config: ResolvedConfig
  muted: RGBA
  spinnerCells: () => { glyph: string; color: RGBA }[]
  subscribe: (listener: Listener) => () => void
}) {
  let particleRef: TextRenderable | undefined
  let tpsRef: TextRenderable | undefined
  let avgRef: TextRenderable | undefined
  let ttftRef: TextRenderable | undefined
  const theme = props.api.theme.current
  const muted = props.muted

  const sync = () => {
    const stats = props.tracker.statsBySession[props.sessionID]
    const calibration = calibrationFactor(stats?.calibrationRatios ?? [])
    const samples = props.tracker.samplesBySession[props.sessionID] ?? []
    const now = Date.now()
    const live = calculateLiveTps(samples, now, calibration)
    const avg = stats && stats.totalDurationMs > 0 ? stats.totalOutputTokens / (stats.totalDurationMs / 1000) : undefined
    const ttft = props.tracker.liveTtftBySession[props.sessionID]
    const thinkingNow = props.tracker.thinkingBySession[props.sessionID] === true && props.config.spinner.enabled
    if (particleRef) {
      if (thinkingNow) {
        const cells = props.spinnerCells()
        particleRef.content = " " + cells.map((c) => c.glyph).join("")
        particleRef.fg = cells[0]?.color ?? muted
      } else {
        particleRef.content = ""
      }
    }
    if (tpsRef) {
      tpsRef.content = live !== undefined ? formatTps(live) ?? "--" : "--"
      tpsRef.fg = live !== undefined ? tpsColor(live, props.config.tps, theme) : muted
    }
    if (avgRef) {
      avgRef.content = avg !== undefined ? formatTps(avg) ?? "--" : "--"
      avgRef.fg = avg !== undefined ? tpsColor(avg, props.config.tps, theme) : muted
    }
    if (ttftRef) {
      ttftRef.content = ttft !== undefined ? formatTtft(ttft) ?? "--" : "--"
      ttftRef.fg = ttft !== undefined ? ttftColor(ttft, props.config.ttft, theme) : muted
    }
    props.api.renderer.requestRender()
  }

  const unsubscribe = props.subscribe(sync)
  onCleanup(unsubscribe)

  return (
    <box flexDirection="row" alignItems="center">
      <text fg={muted}>TPS </text>
      <text ref={(el: TextRenderable) => { tpsRef = el; sync() }} fg={muted}>--</text>
      <text fg={muted}>· AVG </text>
      <text ref={(el: TextRenderable) => { avgRef = el; sync() }} fg={muted}>--</text>
      <text fg={muted}>· TTFT </text>
      <text ref={(el: TextRenderable) => { ttftRef = el; sync() }} fg={muted}>--</text>
      <text ref={(el: TextRenderable) => { particleRef = el; sync() }} fg={muted}></text>
    </box>
  )
}

type TuiApi = Parameters<TuiPlugin>[0]

function overridesPath() {
  return `${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/opencode/surplus-control.json`
}

function writeSurplusOverrides(state: Record<string, unknown>) {
  writeFileSync(overridesPath(), JSON.stringify(state, null, 2) + "\n")
}

function modelsCachePath() {
  return `${process.env.XDG_CACHE_HOME ?? `${homedir()}/.cache`}/opencode/models-surplus.json`
}

function readModelsCache() {
  try {
    return JSON.parse(readFileSync(modelsCachePath(), "utf8"))
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Rate calibration from settled usage
//
// Surplus's chat-completions response does NOT reliably include cost (only
// some BYOK sellers return `cost_details`), so the only ground truth for what a
// session actually cost is the settled per-request records
// (/v1/buyer/usage/export). opencode already stores every assistant message's
// token breakdown (fresh input, cache read, output, reasoning), so we match
// those messages to settled rows by model + timestamp + tokens, then fit the
// REAL per-token rates (fresh in / cache read / output). Session cost = that
// session's tokens x the calibrated rates. Pairs + fitted rates persist in
// surplus-rates.json and accumulate across sessions.
// ---------------------------------------------------------------------------

type CalibPair = { fresh: number; cache: number; out: number; cost: number; at: number }
type CalibRates = { fresh: number; cache: number; out: number }
type CalibRatesEntry = CalibRates & { at: number; n: number; mape: number }
type CalibStore = { rates: Record<string, CalibRatesEntry>; pairs: Record<string, CalibPair[]> }

function ratesPath() {
  return `${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/opencode/surplus-rates.json`
}

let calibStore: CalibStore | undefined
let calibStoreAt = 0
function readCalibStore(): CalibStore {
  const now = Date.now()
  if (calibStore && now - calibStoreAt < 2000) return calibStore
  calibStoreAt = now
  try {
    calibStore = JSON.parse(readFileSync(ratesPath(), "utf8"))
  } catch {
    calibStore = { rates: {}, pairs: {} }
  }
  return calibStore ?? { rates: {}, pairs: {} }
}

function writeCalibStore(store: CalibStore) {
  calibStore = store
  try {
    writeFileSync(ratesPath(), JSON.stringify(store, null, 2) + "\n")
  } catch {}
}

// Least-squares fit of cost = fresh*fresh + cache*cache + out*out (per token),
// returned as $/1M. Returns undefined until enough distinct pairs exist.
function fitRates(pairs: CalibPair[]): CalibRates | undefined {
  const n = pairs.length
  if (n < 5) return undefined
  const k = 3
  const M = Array.from({ length: k }, () => Array(k + 1).fill(0))
  for (const p of pairs) {
    const A = [p.fresh, p.cache, p.out]
    for (let j = 0; j < k; j++) {
      M[j][k] += A[j] * p.cost
      for (let l = 0; l < k; l++) M[j][l] += A[j] * A[l]
    }
  }
  for (let i = 0; i < k; i++) {
    let piv = i
    for (let j = i + 1; j < k; j++) if (Math.abs(M[j][i]) > Math.abs(M[piv][i])) piv = j
    const tmp = M[i]; M[i] = M[piv]; M[piv] = tmp
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

// Match this session's assistant messages to settled rows and refit rates.
async function calibrateRates(api: TuiApi, sessionID: string, settled: SettledRow[]) {
  const store = readCalibStore()
  let changed = false
  for (const message of api.state.session.messages(sessionID)) {
    if (message.role !== "assistant") continue
    const t = message.tokens
    if (!t) continue
    const modelID = normalizeModelID(message.modelID)
    if (!modelID) continue
    const at = message.time?.completed ?? message.time?.created ?? 0
    if (!at) continue
    const fresh = t.input || 0
    const cache = t.cache?.read || 0
    const out = (t.output || 0) + (t.reasoning || 0)
    const pairs = store.pairs[modelID] ?? []
    if (pairs.some((p) => p.at === at && p.fresh === fresh && p.out === out)) continue
    const cand = settled.filter((s) => s.model === modelID && Math.abs(s.at - at) <= 120000)
    if (!cand.length) continue
    let best: SettledRow | undefined
    let bd = Infinity
    for (const s of cand) {
      const d = Math.abs(s.inT - (fresh + cache)) + Math.abs(s.outT - out)
      if (d < bd) { bd = d; best = s }
    }
    if (!best || bd >= Math.max(50, (fresh + cache) * 0.3)) continue
    store.pairs[modelID] = [...pairs, { fresh, cache, out, cost: best.cost, at }].slice(-600)
    changed = true
  }
  if (!changed) return
  for (const [modelID, pairs] of Object.entries(store.pairs)) {
    const rates = fitRates(pairs)
    if (!rates) continue
    let ae = 0
    let tot = 0
    for (const p of pairs) {
      const e = (p.fresh * rates.fresh + p.cache * rates.cache + p.out * rates.out) / 1e6
      ae += Math.abs(e - p.cost)
      tot += p.cost
    }
    store.rates[modelID] = { ...rates, at: Date.now(), n: pairs.length, mape: tot > 0 ? (ae / tot) * 100 : 0 }
  }
  writeCalibStore(store)
}

// A model id may come back prefixed with its provider ("surplus/glm-5.3-flash");
// strip the prefix so TUI, server, tools, and the overrides store agree.
function normalizeModelID(id: string): string {
  const slash = id.indexOf("/")
  return slash > 0 ? id.slice(slash + 1) : id
}

function activeModel(api: TuiApi): { sessionID: string; model: string; providerID: string } | undefined {
  const route = api.route.current
  const sessionID = route.name === "session" ? route.params?.sessionID : undefined
  if (!sessionID) return undefined
  const session = api.state.session.get(sessionID)
  const model = session?.model
  if (model?.providerID?.startsWith("surplus")) return { sessionID, model: normalizeModelID(model.id), providerID: model.providerID }
  const messages = api.state.session.messages(sessionID)
  const latest = [...messages].reverse().find((m) => m.role === "assistant" || m.role === "user")
  if (!latest) return { sessionID, model: "", providerID: "" }
  if (latest.role === "assistant") return { sessionID, model: normalizeModelID(latest.modelID), providerID: latest.providerID }
  return { sessionID, model: normalizeModelID(latest.model.modelID), providerID: latest.model.providerID }
}

function sessionUsage(api: TuiApi, sessionID: string): Usage {
  const messages = api.state.session.messages(sessionID)
  // Calibrated rates reflect what Surplus actually settled per token (fit from
  // opencode's message token breakdowns against the settled usage CSV), so a
  // session cost computed from them is far closer to reality than opencode's
  // pricing-cache estimate. Fall back to opencode's own session totals until a
  // model has enough matched pairs to calibrate (rates need >=5 pairs).
  const lastAssist = [...messages].reverse().find((m) => m.role === "assistant")
  const modelID = lastAssist ? normalizeModelID(lastAssist.modelID) : undefined
  const rates = modelID ? readCalibStore().rates[modelID] : undefined
  if (rates) {
    let cost = 0
    let tokens = 0
    let cacheRead = 0
    let input = 0
    for (const message of messages) {
      if (message.role !== "assistant") continue
      const t = message.tokens
      cost +=
        ((t.input || 0) * rates.fresh + (t.cache?.read || 0) * rates.cache + ((t.output || 0) + (t.reasoning || 0)) * rates.out) /
        1e6
      tokens += (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0)
      cacheRead += t.cache?.read || 0
      input += t.input || 0
    }
    return { cost, tokens, avgPer1M: tokens > 0 ? (cost / tokens) * 1e6 : 0, cacheRead, input }
  }
  const session = api.state.session.get(sessionID)
  const t = session?.tokens
  if (t) {
    // Authoritative session totals maintained by opencode; cache reads are
    // cumulative cached-context served across the whole session (can dwarf
    // input), so they must be included for a meaningful "session total".
    const tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
    const cost = session.cost ?? 0
    return { cost, tokens, avgPer1M: tokens > 0 ? (cost / tokens) * 1e6 : 0, cacheRead: t.cache.read, input: t.input }
  }
  let cost = 0
  let tokens = 0
  let cacheRead = 0
  let input = 0
  for (const message of messages) {
    if (message.role !== "assistant") continue
    cost += message.cost ?? 0
    input += message.tokens.input
    tokens += message.tokens.input + message.tokens.output + message.tokens.reasoning
    cacheRead += message.tokens.cache?.read ?? 0
  }
  return { cost, tokens, avgPer1M: tokens > 0 ? (cost / tokens) * 1e6 : 0, cacheRead, input }
}

function shortPin(pin: string | undefined): string {
  if (!pin) return "none"
  if (!pin.startsWith("http")) return pin
  try { return new URL(pin).host } catch { return pin }
}

function blendWeights(spend: SpendState, api: TuiApi, sessionID: string): { wIn: number; cacheFrac: number } {
  const total = (spend.todayIn ?? 0) + (spend.todayOut ?? 0)
  const wIn = total > 0 ? (spend.todayIn ?? 0) / total : 0.75
  const su = sessionUsage(api, sessionID)
  const cacheFrac = su.input > 0 ? su.cacheRead / su.input : 0
  return { wIn, cacheFrac }
}

async function allOffers(model: string, filterByPin = false, pin?: string): Promise<{ provider: string; host: string; inputUsd: number; discount: number }[]> {
  const key = surplusKey()
  if (!key) return []
  const res = await fetch(`https://api.surplusintelligence.ai/api/markets/${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${key}`, "Accept-Encoding": "identity" },
  })
  if (!res.ok) return []
  const data = await res.json()
  let rows = (data.offers ?? []).filter((o: any) => o.available && o.healthy && o.direct_input_per_1m > 0)
  if (filterByPin && pin) rows = filterOffersByPin(rows, pin)
  return rows
    .map((o: any) => ({
      provider: o.provider,
      host: o.seller_base_url,
      inputUsd: o.price_input_per_1m / 1e6,
      discount: Math.round((1 - o.price_input_per_1m / o.direct_input_per_1m) * 1000) / 10,
    }))
    .sort((a: any, b: any) => b.discount - a.discount)
}

// ---------------------------------------------------------------------------
// Tier helpers.
// ---------------------------------------------------------------------------

function tierFloor(providerID: string | undefined): number | undefined {
  const m = providerID?.match(/^surplus-(\d+)$/)
  return m ? Number(m[1]) : undefined
}

function lastUserText(api: TuiApi, sessionID: string): string | undefined {
  const messages = api.state.session.messages(sessionID)
  const lastUser = [...messages].reverse().find((m) => m.role === "user")
  if (!lastUser) return undefined
  const text = lastUser.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")
  return text.trim() || undefined
}

// Re-submit the last user message. The floor proxy applies the model's current
// floor on the next request, so after adjusting the floor this is a real retry.
async function retryLastUserMessage(api: TuiApi, sessionID: string) {
  const text = lastUserText(api, sessionID)
  if (!text) return false
  try {
    await api.client.session.prompt({
      path: { id: sessionID },
      body: { parts: [{ type: "text", text }] },
    })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// /surplus-* TUI commands. Registered in-process via api.command — they fetch
// live data and show a dialog, with NO model/LLM round-trip, so they're
// instant and free. They appear in both the "/" autocomplete and the Ctrl-P
// command palette under the "Surplus" category.
// ---------------------------------------------------------------------------
function registerSurplusCommands(api: TuiApi, config: ResolvedConfig, bump: () => void): () => void {
  const show = (title: string, lines: string[], variant: "info" | "success" | "warning" | "error" = "info") => {
    api.ui.dialog.replace(() => (
      <api.ui.DialogAlert
        title={title}
        message={lines.join("\n")}
        onConfirm={() => api.ui.dialog.clear()}
      />
    ))
  }

  const current = () => {
    const m = activeModel(api)
    return m ?? { sessionID: "", model: "", providerID: "" }
  }

  const writePin = (model: string, pin: string | null) => {
    const overrides = readSurplusOverrides()
    overrides[model] = { ...overrides[model], pin }
    writeSurplusOverrides(overrides)
    bump()
  }

  const pinAlert = (model: string, pin: string | null) => {
    show("Surplus pin", [
      `Pinned ${model} -> ${pin ?? "none"}.`,
      "Takes effect on the next request (server re-reads overrides per request).",
    ], "success")
  }

  const openPinPicker = async () => {
    const m = current()
    if (!m.model) { show("Surplus pin", ["No active session/model.", "Open a session first."], "warning"); return }
    const offers = await allOffers(m.model)
    const overrides = readSurplusOverrides()
    const currentPin = overrides[m.model]?.pin ?? BASE_PINS[m.model] ?? null
    const options: any[] = []
    if (BASE_PINS[m.model]) {
      options.push({
        title: "Reset to baseline",
        value: BASE_PINS[m.model],
        description: `zai default (${BASE_PINS[m.model]})`,
        onSelect: () => { writePin(m.model, BASE_PINS[m.model]); pinAlert(m.model, BASE_PINS[m.model]) },
      })
    }
    options.push({
      title: "Clear pin",
      value: null,
      description: "no pin; routing picks the best seller per request",
      onSelect: () => { writePin(m.model, null); pinAlert(m.model, null) },
    })
    for (const offer of offers.slice(0, 8)) {
      options.push({
        title: `${offer.provider} — ${offer.discount}% off`,
        value: offer.host,
        description: `${offer.host} · $${offer.inputUsd.toFixed(4)}/1M in`,
        onSelect: () => { writePin(m.model, offer.host); pinAlert(m.model, offer.host) },
      })
    }
    options.push({
      title: "Custom host URL…",
      value: "__custom__",
      description: "type a seller base URL (https://host/v1)",
      onSelect: () => {
        api.ui.dialog.replace(() => (
          <api.ui.DialogPrompt
            title={`Pin ${m.model} to a host`}
            placeholder="https://host/v1"
            onConfirm={(value) => {
              const host = value.trim()
              if (host) { writePin(m.model, host); pinAlert(m.model, host) }
              else api.ui.dialog.clear()
            }}
            onCancel={() => api.ui.dialog.clear()}
          />
        ))
      },
    })
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title={`Pin for ${m.model}`}
        placeholder="Select a host…"
        options={options}
        current={currentPin}
      />
    ))
  }

  return api.command?.register(() => [
    {
      title: "Surplus status",
      value: "surplus.status",
      description: "Active model/provider, overrides, best discount",
      category: "Surplus",
      slash: { name: "surplus-status", aliases: ["surplus"] },
      onSelect: async () => {
        const m = current()
        if (!m.model) { show("Surplus status", ["No active session/model.", "Open a session first."], "warning"); return }
        const overrides = readSurplusOverrides()[m.model] ?? {}
        const floor = overrides.floor !== undefined ? overrides.floor : tierFloor(m.providerID)
        const offers = await allOffers(m.model)
        const best = offers[0]
        const session = m.sessionID ? sessionUsage(api, m.sessionID) : { cost: 0, tokens: 0, avgPer1M: 0 }
        const lines = [
          `Model:   ${m.model}`,
          `Provider:${m.providerID}`,
          `Floor:   ${floor !== undefined ? `≥${floor}% (min${floor})` : "off"}`,
          `Pin:     ${overrides.pin ?? BASE_PINS[m.model] ?? "none"}`,
          `Overrides:${Object.keys(overrides).length ? JSON.stringify(overrides) : "none"}`,
        ]
        if (session.tokens > 0) {
          lines.push(`Session: $${session.cost.toFixed(4)} · avg $${session.avgPer1M.toFixed(3)}/1M · ${fmtTokens(session.tokens)} tok`)
        }
        if (best) {
          const passing = TIERS.find((t) => best.discount >= t) ?? 0
          lines.push(`Best:    ${best.discount}% off (${best.provider}, $${best.inputUsd}/1M in)`)
          lines.push(passing ? `Strictest passing provider: surplus-${passing}` : "No tier provider currently passes.")
        } else {
          lines.push("No healthy offers right now.")
        }
        show("Surplus status", lines)
      },
    },
    {
      title: "Surplus offers",
      value: "surplus.offers",
      description: "Live marketplace offers for the active model",
      category: "Surplus",
      slash: { name: "surplus-offers" },
      onSelect: async () => {
        const m = current()
        if (!m.model) { show("Surplus offers", ["No active session/model.", "Open a session first."], "warning"); return }
        const pin = activePinFor(m.model)
        const offers = await allOffers(m.model, config.filterByPin, pin)
        if (!offers.length) { show("Surplus offers", [`No healthy offers for ${m.model} right now.`], "warning"); return }
        const best = offers[0]
        const passing = TIERS.find((t) => best.discount >= t) ?? 0
        const filtered = config.filterByPin && pin ? " (filtered to pin)" : ""
        const lines = [
          `Healthy offers for ${m.model}${filtered} (best ${best.discount}% off):`,
          ...offers.slice(0, 10).map((o, i) => `${i + 1}. ${o.provider} ${o.host} — $${o.inputUsd.toFixed(4)}/1M in (~${o.discount}% off)`),
          passing ? `\nStrictest provider that passes: surplus-${passing}` : "\nNo tier provider currently passes.",
        ]
        show("Surplus offers", lines)
      },
    },
    {
      title: "Surplus tier",
      value: "surplus.tier",
      description: "Set the discount floor for the active model (≥70/80/90/95% or off)",
      category: "Surplus",
      slash: { name: "surplus-tier" },
      onSelect: async () => {
        const m = current()
        if (!m.model) { show("Surplus tier", ["No active session/model.", "Open a session first."], "warning"); return }
        const overrides = readSurplusOverrides()[m.model] ?? {}
        const currentFloor = overrides.floor !== undefined ? overrides.floor : tierFloor(m.providerID)
        const applyFloor = async (tier: number) => {
          const all = readSurplusOverrides()
          all[m.model] = { ...all[m.model], floor: tier }
          writeSurplusOverrides(all)
          bump()
          show("Surplus tier", [
            tier === 0 ? `Floor for ${m.model}: off (no minimum discount).` : `Floor for ${m.model}: ≥${tier}% off.`,
            "Applies to the next request (the floor proxy routes via the /min{N} URL).",
          ], "success")
        }
        api.ui.dialog.replace(() => (
          <api.ui.DialogSelect
            title={`Discount floor for ${m.model}`}
            placeholder="Select a floor…"
            options={[
              {
                title: "Off (no minimum)",
                value: 0,
                description: "route through the neutral surplus provider",
                onSelect: () => { void applyFloor(0) },
              },
              ...TIERS.map((t) => ({
                title: `≥${t}% off (min${t})`,
                value: t,
                description: `surplus-${t} provider`,
                onSelect: () => { void applyFloor(t) },
              })),
            ]}
            current={currentFloor}
          />
        ))
      },
    },
    {
      title: "Surplus spend",
      value: "surplus.spend",
      description: "Today's and this session's spend + average price per 1M tokens",
      category: "Surplus",
      slash: { name: "surplus-spend" },
      onSelect: async () => {
        const m = current()
        const usage = await actualTodayUsage()
        const lines = [
          `Today's settled spend: ${usage === undefined ? "--" : `$${usage.cost.toFixed(4)}`}`,
        ]
        if (usage) {
          lines.push(`Today's tokens: ${fmtTokens(usage.tokens)} (avg $${usage.avgPer1M.toFixed(3)}/1M)`)
          if (usage.direct !== undefined && usage.discountPct !== undefined) {
            lines.push(`Savings vs list: $${(usage.direct - usage.cost).toFixed(4)} (${usage.discountPct}% off)`)
          }
        }
        if (m.sessionID) {
          const session = sessionUsage(api, m.sessionID)
          lines.push(session.tokens > 0
            ? `This session: $${session.cost.toFixed(4)} · ${fmtTokens(session.tokens)} tok (avg $${session.avgPer1M.toFixed(3)}/1M)`
            : "This session: no completed assistant turns yet.")
        }
        show("Surplus spend", lines)
      },
    },
    {
      title: "Surplus pin",
      value: "surplus.pin",
      description: "Pin/unpin routing for the active model (pick a host)",
      category: "Surplus",
      slash: { name: "surplus-pin" },
      onSelect: () => { void openPinPicker() },
    },
    {
      title: "Surplus clear",
      value: "surplus.clear",
      description: "Clear pin/overrides for the active model",
      category: "Surplus",
      slash: { name: "surplus-clear" },
      onSelect: async () => {
        const m = current()
        if (!m.model) { show("Surplus clear", ["No active session/model.", "Open a session first."], "warning"); return }
        const overrides = readSurplusOverrides()
        if (!overrides[m.model]) {
          show("Surplus clear", [`No overrides stored for ${m.model}.`], "info")
          return
        }
        delete overrides[m.model]
        writeSurplusOverrides(overrides)
        bump()
        show("Surplus clear", `Cleared overrides for ${m.model}.`, "success")
      },
    },
    {
      title: "Surplus flag",
      value: "surplus.flag",
      description: "Toggle backoff-prompt mode (immediate adjust dialog on floor failure vs normal fail)",
      category: "Surplus",
      slash: { name: "surplus-flag" },
      onSelect: () => {
        const on = readSurplusOverrides()._flags?.backoffPrompt ?? false
        const setFlag = (v: boolean) => {
          const st = readSurplusOverrides()
          st._flags = { ...(st._flags ?? {}), backoffPrompt: v }
          writeSurplusOverrides(st)
          bump()
          show("Surplus flag", [`Backoff-prompt mode: ${v ? "ON (immediately prompts to adjust the discount tier on a floor failure)" : "OFF (floor failures fail normally, no prompt)"}.`], "success")
        }
        api.ui.dialog.replace(() => (
          <api.ui.DialogSelect
            title="Surplus backoff-prompt mode"
            placeholder="Select…"
            options={[
              { title: "ON — prompt to adjust the discount tier on failure", value: true, onSelect: () => setFlag(true) },
              { title: "OFF — normal failure message, no prompt", value: false, onSelect: () => setFlag(false) },
            ]}
            current={on}
          />
        ))
      },
    },
    {
      title: "Surplus models",
      value: "surplus.models",
      description: "List discovered Surplus models (from the local catalog cache)",
      category: "Surplus",
      slash: { name: "surplus-models" },
      onSelect: async () => {
        const models = readModelsCache()
        const ids = Object.keys(models)
        if (!ids.length) {
          show("Surplus models", [
            "No models discovered yet.",
            "Run `node sync-models.mjs` (from this package) or restart opencode with a surplus provider to scrape the catalog.",
          ], "info")
          return
        }
        const active = current().model
        const lines = [
          `Discovered ${ids.length} surplus models.`,
          ...ids.slice(0, 25).map((id) => `${id === active ? "* " : "  "}${id} (${models[id]?.name ?? id})`),
          ids.length > 25 ? `\n… and ${ids.length - 25} more (see node sync-models.mjs --query <str>).` : "",
        ]
        show("Surplus models", lines)
      },
    },
    {
      title: "Surplus TUI toggle",
      value: "surplus.tui",
      description: "Disable the surplus TUI integration (meter, sidebar, commands) for this session",
      category: "Surplus",
      slash: { name: "surplus-tui" },
      onSelect: () => {
        api.ui.dialog.replace(() => (
          <api.ui.DialogConfirm
            title="Disable Surplus TUI?"
            message="Hides the meter, sidebar blocks, and /surplus-* commands for the rest of this session. Re-enable via /plugins or the tui.json config."
            onConfirm={async () => {
              try { await api.plugins.deactivate("surplus-sidebar-v2") } catch {}
              api.ui.dialog.clear()
            }}
            onCancel={() => api.ui.dialog.clear()}
          />
        ))
      },
    },
  ])
}

const tui: TuiPlugin = async (api, options) => {
  const config = resolveConfig(options)

  // Master toggle: with `"enabled": false` in the tui.json plugin tuple, the
  // meter, sidebar blocks, commands, and event wiring are skipped entirely.
  if (!config.enabled) return

  const muted = api.theme.current.textMuted

  const listeners = new Set<Listener>()
  const bump = () => { for (const l of listeners) l() }
  const subscribe = (listener: Listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }

  const disposeCommands = registerSurplusCommands(api, config, bump)

  // -------------------------------------------------------------------------
  // Main plugin body: wires up the TPS tracker, the spend/offer refresh loops,
  // and registers the sidebar / prompt slots. The spend figures refresh on a
  // timer and on every message.updated; offers refresh every 60s.
  // -------------------------------------------------------------------------
  const tracker: TrackerState = {
    useV2Events: false,
    samplesBySession: {},
    messageCreatedAt: {},
    firstDeltaByMessage: {},
    lastDeltaByMessage: {},
    estimatedTokensByMessage: {},
    liveTtftBySession: {},
    activeMessageBySession: {},
    statsBySession: {},
    thinkingBySession: {},
  }
  const spend: SpendState = { loading: false }

  const refreshSpend = async () => {
    if (spend.loading) return
    spend.loading = true
    try {
      const rows = await fetchSettledRows()
      const usage = rows.length ? await actualTodayUsage(rows) : undefined
      spend.today = usage?.cost
      spend.todayTokens = usage?.tokens
      spend.todayAvgUsd = usage?.avgPer1M
      spend.todayDiscountPct = usage?.discountPct
      spend.todayIn = usage?.in
      spend.todayOut = usage?.out
      const route = api.route.current
      const sessionID = route.name === "session" ? (route.params as { sessionID?: string })?.sessionID : undefined
      if (sessionID && rows.length) await calibrateRates(api, sessionID, rows)
    } catch {}
    spend.loading = false
    bump()
  }
  void refreshSpend()
  const spendTimer = setInterval(() => { void refreshSpend() }, 30000)

  const refreshOffers = async () => {
    const route = api.route.current
    const sessionID = route.name === "session" ? route.params?.sessionID : undefined
    if (!sessionID || spend.loadingModel) return
    const messages = api.state.session.messages(sessionID)
    const latest = [...messages].reverse().find((m) => m.role === "assistant" || m.role === "user")
    const stored = api.state.session.get(sessionID)?.model
    const fallback = latest
      ? latest.role === "assistant"
        ? { id: latest.modelID, providerID: latest.providerID }
        : { id: latest.model.modelID, providerID: latest.model.providerID }
      : undefined
    const model = stored ?? fallback
    const modelID = model?.providerID?.startsWith("surplus") ? model.id : undefined
    if (!modelID || spend.model !== modelID) return
    try {
      const bw = blendWeights(spend, api, sessionID)
      const result = await currentOffers(modelID, bw.wIn, bw.cacheFrac, config.filterByPin, activePinFor(modelID))
      spend.offers = result.offers
    } catch {}
    bump()
  }
  const offerTimer = setInterval(() => { void refreshOffers() }, 60000)

  const N = config.spinner.cells
  const randomDot = () => DOT_GLYPHS[Math.floor(Math.random() * DOT_GLYPHS.length)]
  const spawnGlyph = () => (Math.random() < 0.18 ? " " : randomDot())
  let stream: string[] = []
  let hueFrame = 0
  let spinnerTimer: ReturnType<typeof setInterval> | undefined

  const initStream = () => {
    stream = Array.from({ length: N }, () => spawnGlyph())
    hueFrame = 0
  }
  const tickStream = () => {
    stream.unshift(spawnGlyph())
    if (stream.length > N) stream.pop()
    hueFrame++
  }
  initStream()

  const spinnerCells = () => {
    const bright = gradientColor(config.spinner.colors, (hueFrame % 60) / 60)
    const out: { glyph: string; color: RGBA }[] = []
    for (let i = 0; i < N; i++) {
      const g = stream[i] ?? " "
      out.push({ glyph: g, color: g === " " ? muted : lerpColor(bright, muted, i / (N - 1)) })
    }
    return out
  }

  const anyThinking = () => {
    for (const v of Object.values(tracker.thinkingBySession)) if (v) return true
    return false
  }
  const syncSpinnerTimer = () => {
    if (config.spinner.enabled && anyThinking() && !spinnerTimer) {
      spinnerTimer = setInterval(() => {
        tickStream()
        bump()
      }, config.spinner.intervalMs)
    } else if ((!anyThinking() || !config.spinner.enabled) && spinnerTimer) {
      clearInterval(spinnerTimer)
      spinnerTimer = undefined
    }
  }
  const setThinking = (sessionID: string, value: boolean) => {
    if (tracker.thinkingBySession[sessionID] === value) return
    tracker.thinkingBySession[sessionID] = value
    if (value) initStream()
    syncSpinnerTimer()
  }

  const onTextDelta = api.event.on("session.next.text.delta", (evt) => {
    tracker.useV2Events = true
    const { sessionID, assistantMessageID, timestamp, delta } = evt.properties
    recordDelta(tracker, sessionID, assistantMessageID, timestamp, delta)
    setThinking(sessionID, false)
    bump()
  })

  const onReasoningDelta = api.event.on("session.next.reasoning.delta", (evt) => {
    tracker.useV2Events = true
    const { sessionID, assistantMessageID, timestamp, delta } = evt.properties
    recordDelta(tracker, sessionID, assistantMessageID, timestamp, delta)
    setThinking(sessionID, true)
    bump()
  })

  const onPartDelta = api.event.on("message.part.delta", (evt) => {
    if (tracker.useV2Events) return
    if (evt.properties.field !== "text") return
    const parts = api.state.part(evt.properties.messageID)
    const part = parts.find((p) => p.id === evt.properties.partID)
    if (!part || (part.type !== "text" && part.type !== "reasoning")) return
    const { sessionID, messageID } = evt.properties
    recordDelta(tracker, sessionID, messageID, Date.now(), evt.properties.delta)
    setThinking(sessionID, part.type === "reasoning")
    bump()
  })

  const onMessageUpdated = api.event.on("message.updated", (evt) => {
    const info = evt.properties.info
    if (info.role !== "assistant") return

    if (!info.time.completed) {
      tracker.messageCreatedAt[info.id] = info.time.created
      return
    }

    const sessionID = info.sessionID ?? evt.properties.sessionID
    if (!tracker.statsBySession[sessionID]) {
      tracker.statsBySession[sessionID] = { totalOutputTokens: 0, totalDurationMs: 0, calibrationRatios: [] }
    }
    const stats = tracker.statsBySession[sessionID]!

    const actualTokens = info.tokens.output + info.tokens.reasoning
    const firstDelta = tracker.firstDeltaByMessage[info.id]
    const lastDelta = tracker.lastDeltaByMessage[info.id]
    const generationMs = firstDelta !== undefined && lastDelta !== undefined
      ? Math.max(lastDelta - firstDelta, MIN_DURATION_MS) : 0

    if (actualTokens > 0 && generationMs > 0) {
      stats.totalOutputTokens += actualTokens
      stats.totalDurationMs += generationMs

      const estimated = tracker.estimatedTokensByMessage[info.id] ?? 0
      if (estimated > 0) {
        const ratio = Math.min(Math.max(actualTokens / estimated, 0.3), 3.0)
        stats.calibrationRatios = [...stats.calibrationRatios, ratio].slice(-MAX_CALIBRATION_RATIOS)
      }
    }

    delete tracker.estimatedTokensByMessage[info.id]
    delete tracker.firstDeltaByMessage[info.id]
    delete tracker.lastDeltaByMessage[info.id]
    delete tracker.messageCreatedAt[info.id]
    delete tracker.activeMessageBySession[sessionID]
    delete tracker.samplesBySession[sessionID]
    setThinking(sessionID, false)
    bump()
  })
  const onSpendMessageUpdated = api.event.on("message.updated", () => { void refreshSpend() })

  const clearSessionLive = (sessionID: string) => {
    delete tracker.samplesBySession[sessionID]
    setThinking(sessionID, false)
  }

  const onToolInputStarted = api.event.on("session.next.tool.input.started", (evt) => {
    clearSessionLive(evt.properties.sessionID)
    bump()
  })

  const onPartUpdated = api.event.on("message.part.updated", (evt) => {
    if (evt.properties.part.type !== "tool") return
    if (["running", "completed", "error"].includes(evt.properties.part.state.status)) {
      clearSessionLive(evt.properties.part.sessionID ?? evt.properties.sessionID)
      bump()
    }
  })

  // -------------------------------------------------------------------------
  // Floor-failure prompt dialog (backoff-prompt mode ON). The server detects a
  // floor failure and immediately writes `_backoffPrompt` for the active model
  // with a recommended tier (the strictest passing tier below the current
  // floor). We poll the store and show the dialog; picking a tier applies it
  // and re-submits your last message through the new floor.
  // -------------------------------------------------------------------------
  const alert = (title: string, lines: string[]) => {
    api.ui.dialog.replace(() => (
      <api.ui.DialogAlert title={title} message={lines.join("\n")} onConfirm={() => api.ui.dialog.clear()} />
    ))
  }
  const shownBackoff = new Set<string>()
  const maybeShowBackoffPrompt = () => {
    const route = api.route.current
    const sessionID = route.name === "session" ? route.params?.sessionID : undefined
    if (!sessionID) return
    const sid = sessionID as unknown as string
    const overrides = readSurplusOverrides()
    if (!(overrides._flags?.backoffPrompt ?? false)) return
    const m = activeModel(api)
    if (!m?.model) return
    const entry = (overrides._backoffPrompt ?? {})[m.model] as
      | { at?: number; sessionID?: string; currentTier?: number | null; targetTier?: number | null } | undefined
    if (!entry) return
    if (Date.now() - (entry.at ?? 0) > 120000) return
    const key = `${m.model}:${entry.at}`
    if (shownBackoff.has(key)) return
    shownBackoff.add(key)
    const targetTier = entry.targetTier ?? undefined
    const resolveBackoff = async (tier: number) => {
      const st = readSurplusOverrides()
      st[m.model] = { ...st[m.model], floor: tier }
      delete (st._backoffPrompt ?? {})[m.model]
      writeSurplusOverrides(st)
      // Acknowledge immediately; the retry then streams in the session.
      alert("Surplus backoff", [
        `Floor for ${m.model}: ${tier === 0 ? "off" : `≥${tier}%`}.`,
        "Retrying your last message through the new floor…",
      ])
      await retryLastUserMessage(api, sid)
    }
    const options: any[] = []
    if (targetTier) {
      options.push({
        title: `Set floor to ≥${targetTier}% and retry`,
        value: targetTier,
        description: "next request routes via /min{target}",
        onSelect: () => { void resolveBackoff(targetTier) },
      })
    }
    options.push({
      title: "Set floor to off and retry",
      value: 0,
      description: "no minimum discount",
      onSelect: () => { void resolveBackoff(0) },
    })
    options.push({ title: "Cancel", value: null, description: "leave the floor as-is", onSelect: () => { api.ui.dialog.clear() } })
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title={`Discount floor ≥${entry.currentTier ?? "?"}% not met`}
        placeholder="Adjust the tier…"
        options={options}
      />
    ))
  }
  const backoffTimer = setInterval(maybeShowBackoffPrompt, 5000)
  const onSessionError = api.event.on("session.error", (evt) => {
    const err = (evt.properties as any)?.error as { data?: { message?: string }; message?: string } | undefined
    const msg = typeof err?.data?.message === "string" ? err.data.message : (typeof err?.message === "string" ? err.message : "")
    if (/minimum_discount_not_met|no marketplace sellers currently meet|meet the minimum.*(discount|off)|estimated discount|x402|402/i.test(msg)) {
      setTimeout(maybeShowBackoffPrompt, 1500)
    }
  })

  const timer = setInterval(() => {
    const now = Date.now()
    const cutoff = now - WINDOW_MS
    for (const [sid, samples] of Object.entries(tracker.samplesBySession)) {
      const pruned = samples.filter((s) => s.at >= cutoff)
      if (pruned.length > 0) tracker.samplesBySession[sid] = pruned
      else delete tracker.samplesBySession[sid]
    }
    bump()
  }, 1000)

  api.lifecycle.onDispose(() => {
    disposeCommands?.()
    onTextDelta(); onReasoningDelta(); onPartDelta()
    onMessageUpdated(); onToolInputStarted(); onPartUpdated()
    onSpendMessageUpdated()
    onSessionError()
    clearInterval(timer)
    clearInterval(spendTimer)
    clearInterval(offerTimer)
    clearInterval(backoffTimer)
    if (spinnerTimer) clearInterval(spinnerTimer)
  })

  api.slots.register({
    slots: {
      session_prompt_right(_ctx, value) {
        return (
          <MeterDisplay
            api={api}
            sessionID={value.session_id}
            tracker={tracker}
            config={config}
            muted={muted}
            spinnerCells={spinnerCells}
            subscribe={subscribe}
          />
        )
      },
      sidebar_content(_ctx, value) {
        return <TodayBlock api={api} spend={spend} subscribe={subscribe} />
      },
      sidebar_footer(_ctx, value) {
        return <SpendDisplay api={api} sessionID={value.session_id} spend={spend} config={config} subscribe={subscribe} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "surplus-sidebar-v2", tui }
export default plugin
