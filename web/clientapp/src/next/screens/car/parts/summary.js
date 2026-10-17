// Pure helpers that turn the live module list into the numbers and "needs a look" items on Car home.
import { outputsOf } from '../../../lib/live.svelte.js'
export const num = (v) => (Number.isFinite(v) ? v : 0)
export const fmt1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '-')

/** An output counts as "tripped" while the module reports Overcurrent or Fault for it. */
export const isTripped = (o) => /overcurrent|fault/i.test(o?.state ?? '')
export const isOn = (o) => o?.enabled !== false && (/^on$/i.test(o?.state ?? '') || /pwm/i.test(o?.state ?? '') || num(o?.current) > 0.05)

/** Sum of the current limits of all enabled outputs: the load if every output hit its limit at once. */
export function worstCaseA(devices) {
  let a = 0
  for (const d of devices) for (const o of d.outputs ?? []) if (o.enabled !== false) a += num(o.currentLimit)
  return a
}

export function outputCounts(devices) {
  let on = 0, total = 0
  for (const d of devices) for (const o of outputsOf(d)) if (o.enabled !== false) { total++; if (isOn(o) && d.connected) on++ }
  return { on, total }
}

/** "v5.5.112" -> [5,5,112]; unknown or v0.0.0 -> null. */
export function versionParts(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? '')
  if (!m) return null
  const p = [Number(m[1]), Number(m[2]), Number(m[3])]
  return p.every((x) => x === 0) ? null : p
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Modules running older firmware than the newest one in the car (same board type). */
export function olderFirmware(devices) {
  const newest = {}
  for (const d of devices) {
    const p = versionParts(d.version)
    if (p && (!newest[d.type] || cmp(p, newest[d.type]) > 0)) newest[d.type] = p
  }
  const out = []
  for (const d of devices) {
    const p = versionParts(d.version)
    if (p && newest[d.type] && cmp(p, newest[d.type]) < 0) out.push({ dev: d, newest: newest[d.type].join('.') })
  }
  return out
}
