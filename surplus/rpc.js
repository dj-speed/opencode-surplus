// rpc.js — the RPC contract between the server part (index.js) and the TUI
// part (tui.tsx). In OpenCode V2 the TUI cannot read credentials, so every
// Surplus API call and every persisted setting lives on the server; the TUI
// reads and writes them through these methods and listens to these events.

import { Rpc } from "@opencode/plugin/rpc"

const anyObject = { type: "object", additionalProperties: true }

export const SurplusRpc = Rpc.define({
  id: "surplus",
  methods: {
    // { overrides: { [modelID]: { pin?, floor? } }, flags: { backoffPrompt }, basePins, providerID }
    state: { input: anyObject, output: anyObject },
    // { model, pin?: string|null, floor?: number, clear?: true }
    setOverride: { input: anyObject, output: anyObject },
    // { backoffPrompt: boolean }
    setFlags: { input: anyObject, output: anyObject },
    // { model } -> { offers: raw healthy marketplace offers }
    offers: { input: anyObject, output: anyObject },
    // {} -> { rows: today's settled usage records }
    settled: { input: anyObject, output: anyObject },
    // {} -> { models: [{ id, name }] }
    models: { input: anyObject, output: anyObject },
    // {} -> calibration store { rates, pairs }
    calibration: { input: anyObject, output: anyObject },
    // calibration store -> {} ; server re-prices models from the fitted rates
    setCalibration: { input: anyObject, output: anyObject },
  },
  events: {
    // overrides / flags changed
    changed: { schema: anyObject },
    // a request failed the discount floor (backoff-prompt mode ON)
    // { sessionID, model, currentTier, targetTier }
    floor: { schema: anyObject },
  },
})
