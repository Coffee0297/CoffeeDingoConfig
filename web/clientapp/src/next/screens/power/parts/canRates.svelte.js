// Live CAN frame rates per id, derived from GET /api/canlog counts (a count per id, no timestamps).
// Two samples give frames per second. Used for "why will it not sleep" and the keypad heartbeat check.
import { api } from '../../../lib/live.svelte.js'

/** Start polling; returns { state, stop }. state.rates: { [id]: framesPerSecond }, state.counts, state.ok. */
export function pollCanRates(intervalMs = 2000) {
  const state = $state({ rates: {}, counts: {}, lastSeen: {}, ok: false, at: 0, error: '' })
  let prev = null, prevAt = 0, stopped = false, timer
  async function tick() {
    try {
      const rows = (await api.canlog()) ?? []
      const now = Date.now()
      const counts = {}
      for (const r of rows) if (r.dir === 'Rx') counts[r.id] = r.count
      if (prev) {
        const dt = Math.max(0.2, (now - prevAt) / 1000)
        const rates = {}
        const seen = { ...state.lastSeen }
        for (const id in counts) { const d = counts[id] - (prev[id] ?? counts[id]); if (d > 0) { rates[id] = d / dt; seen[id] = now } }
        state.rates = rates; state.lastSeen = seen
      }
      state.counts = counts; state.ok = true; state.error = ''; state.at = now
      prev = counts; prevAt = now
    } catch (e) { state.ok = false; state.error = e?.message ?? String(e) }
    if (!stopped) timer = setTimeout(tick, intervalMs)
  }
  tick()
  return { state, stop() { stopped = true; clearTimeout(timer) } }
}
