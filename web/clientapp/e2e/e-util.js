// Helpers for the Car + Live screen tests (implementer E).
import { expect } from '@playwright/test'
import { apiJson } from './api.js'

/**
 * Stop the live feed and replace the telemetry the app sees (dev-only test seam in store.js), so states the
 * Sim cannot produce on demand (module not answering, tripped output, flooded bus, not connected) can be shown.
 * spec: { top?: {...telemetry fields}, devices?: { 'PDM-01': {...patch} }, outputs?: { 'PDM-01:6': {...patch} }, empty?: true }
 */
export async function inject(page, spec) {
  await page.evaluate((s) => {
    window.__conn.stop()
    let cur
    window.__telemetry.subscribe((v) => (cur = v))()
    const t = JSON.parse(JSON.stringify(cur))
    if (s.empty) t.devices = []
    for (const d of t.devices) {
      Object.assign(d, s.devices?.[d.name] ?? {})
      for (const o of d.outputs ?? []) Object.assign(o, s.outputs?.[`${d.name}:${o.number}`] ?? {})
    }
    Object.assign(t, s.top ?? {})
    window.__telemetry.set(t)
  }, spec)
}

/** A realistic trip waveform: -10 s ... +3 s, 40 ms points, 0.5 A steps, switched on 0.4 s before the trip. */
export function waveform(peak = 23, steady = 17) {
  const out = []
  for (let k = 0; k < 326; k++) {
    const t = -10 + k * 0.04
    const i = t < -0.4 ? 0 : t < -0.28 ? peak + 3 : t < 0 ? steady + Math.sin(t * 60) * 1.4 : t < 0.04 ? peak : 0
    out.push({ dt: +t.toFixed(2), i: Math.round(i * 2) / 2 })
  }
  return out
}

/** Answer GET /api/devices/<guid>/overloads with fixed events (the Sim has no trips to show). */
export async function mockTrips(page, guid, eventsRef) {
  await page.route(`**/api/devices/${guid}/overloads`, (r) => r.fulfill({ json: { events: typeof eventsRef === 'function' ? eventsRef() : eventsRef } }))
}

export async function devs() { return apiJson('GET', '/api/devices') }
export const pdms = (list) => list.filter((d) => d.type === 'dingoPDM')

export { expect }
