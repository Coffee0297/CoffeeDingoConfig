// Browser-side history for the Live screens (dashboard sparklines, Plot). Nothing is stored on the
// server (API gap: no history endpoint). Two sources:
//  - telemetry (10 Hz push): module battery / current / temperature and every output's current,
//    sampled every 200 ms into ring buffers;
//  - GET /devices/{guid}/signals, polled every 500 ms for the modules a screen is watching.
// Buffers live for the whole browser session, so a graph opened later still has what was seen before.
import { telemetry } from '../../../../lib/store.js'
import { api } from '../../../lib/live.svelte.js'

const KEEP_MS = 5 * 60_000 + 15_000
const STEP_MS = 200

/** Bumps twice a second so $derived values that read it refresh. */
export const feed = $state({ tick: 0, sigAt: {}, sigErr: {}, byGuid: {} })

const bufs = new Map() // key -> { t: number[], v: number[] }

export function push(key, v, now = Date.now()) {
  if (!Number.isFinite(v)) return
  let b = bufs.get(key)
  if (!b) bufs.set(key, (b = { t: [], v: [] }))
  b.t.push(now); b.v.push(v)
  const cut = now - KEEP_MS
  let i = 0
  while (i < b.t.length - 2 && b.t[i] < cut) i++
  if (i > 0) { b.t.splice(0, i); b.v.splice(0, i) }
}

/** Raw samples for a key: { t: ms[], v: number[] } (empty arrays when unseen). */
export function samples(key) { return bufs.get(key) ?? { t: [], v: [] } }

/** Last `seconds` of a key resampled to `n` evenly spaced values (hold-last), plus the span covered. */
export function resample(key, seconds, n = 120, until = Date.now()) {
  const b = bufs.get(key)
  if (!b || !b.t.length) return { values: [], span: 0, last: null, lastAt: 0 }
  const from = Math.max(until - seconds * 1000, b.t[0])
  const span = Math.max(0.2, (until - from) / 1000)
  const values = []
  let j = 0
  for (let k = 0; k < n; k++) {
    const t = from + ((until - from) * k) / (n - 1)
    while (j + 1 < b.t.length && b.t[j + 1] <= t) j++
    values.push(b.v[j])
  }
  return { values, span, last: b.v[b.v.length - 1], lastAt: b.t[b.t.length - 1] }
}

export const keys = {
  batt: (g) => `bat:${g}`, cur: (g) => `cur:${g}`, temp: (g) => `tmp:${g}`,
  out: (g, n) => `out:${g}:${n}`, sig: (g, name) => `sig:${g}:${name}`,
  total: 'total', hottest: 'hottest', battMax: 'battmax',
}

let lastStep = 0
telemetry.subscribe((t) => {
  const now = Date.now()
  if (now - lastStep < STEP_MS) return
  lastStep = now
  let total = 0, hot = null, bat = null
  for (const d of t.devices ?? []) {
    if (!d.connected) continue
    if (/pdm/i.test(d.type ?? '')) {
      push(keys.cur(d.guid), d.current, now); total += d.current ?? 0
      push(keys.batt(d.guid), d.battery, now)
      if (Number.isFinite(d.battery)) bat = Math.max(bat ?? 0, d.battery)
    }
    if (Number.isFinite(d.temp)) { push(keys.temp(d.guid), d.temp, now); hot = Math.max(hot ?? -273, d.temp) }
    for (const o of d.outputs ?? []) push(keys.out(d.guid, o.number), o.current, now)
  }
  if (t.connected) {
    push(keys.total, total, now)
    if (hot != null) push(keys.hottest, hot, now)
    if (bat != null) push(keys.battMax, bat, now)
  }
})
setInterval(() => { feed.tick++ }, 500)

// ---- signal polling (ref-counted per module) ----
const refs = new Map()
const busy = new Set()
let timer = null

const toNumber = (s) => { const n = parseFloat(s.value); return Number.isFinite(n) ? n : s.on ? 1 : 0 }

async function pollOne(g) {
  if (busy.has(g)) return
  busy.add(g)
  try {
    const list = await api.signals(g)
    const now = Date.now()
    feed.byGuid[g] = list ?? []
    feed.sigAt[g] = now
    feed.sigErr[g] = false
    for (const s of list ?? []) push(keys.sig(g, s.name), toNumber(s), now)
  } catch { feed.sigErr[g] = true } finally { busy.delete(g) }
}
function pollAll() { for (const g of refs.keys()) pollOne(g) }

/** Poll these modules' signals until the returned function is called. Use inside $effect. */
export function watchSignals(guids) {
  const mine = [...new Set(guids)]
  for (const g of mine) refs.set(g, (refs.get(g) ?? 0) + 1)
  if (!timer) timer = setInterval(pollAll, 500)
  for (const g of mine) pollOne(g)
  return () => {
    for (const g of mine) { const c = (refs.get(g) ?? 1) - 1; if (c <= 0) refs.delete(g); else refs.set(g, c) }
    if (!refs.size && timer) { clearInterval(timer); timer = null }
  }
}

/** Numeric value of a live signal (for tiles). */
export const signalNumber = toNumber

/** Time of the oldest sample for a key (ms), or null. */
export function firstAt(key) { const b = bufs.get(key); return b?.t.length ? b.t[0] : null }

/** `n` evenly spaced values between two times (hold-last; leading gap before the first sample holds the first value). */
export function resampleRange(key, from, until, n = 120) {
  const b = bufs.get(key)
  if (!b || !b.t.length) return []
  const values = []
  let j = 0
  for (let k = 0; k < n; k++) {
    const t = from + ((until - from) * k) / (n - 1)
    while (j + 1 < b.t.length && b.t[j + 1] <= t) j++
    values.push(b.v[j])
  }
  return values
}
