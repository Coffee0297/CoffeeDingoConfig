import { has } from '../next/screens/hardware/parts/util.js'
// CAN-ID allocation helpers - the in-UI counterpart of tools/canfree.py, operating on the
// live project fleet. Single source for the per-type ID footprint, used by BOTH the System
// view overlap check and the "suggest a free base" action so they can never disagree.

export const STD_MAX = 0x7FF

// OBD-II / UDS diagnostic IDs - kept clear by default so a new module never lands on them.
export const OBD_RESERVED = (() => {
  const s = new Set([0x7DF, 0x7F1])
  for (let i = 0x7E0; i <= 0x7EF; i++) s.add(i)
  return s
})()

// Footprint per module type. Cyclic frames: a CANboard sends 10 (base+2..+11), a dingoPDM/-Max 28
// (base+2..+29); both also own +0/+1 (config) and the CANBoard +12/+13 (bootloader). +1 guard ID below
// base (the settings-request id). See spanAfter() for the exact spans.
export const ID_BEFORE = 1
// CANBoard owns base..base+14: +0/+1 config, +2..+11 cyclic, +12/+13 OpenBLT XCP bootloader
// (command/response), +14 the ignition state frame (firmware 5.6). dingoPDM owns base..base+30
// (firmware ≥ 5.5.107 adds Msg 27 = table outputs at +29; +30 is the 5.6 ignition state frame; its
// +12/+13 already fall inside that span). At the usual 0x10 / 0x20 spacing both still fit.
// An upstream-dingoFW PDM with lookup tables (param block 0x1B00) also sends Msg 30 at +32 (tables 1-2) and, with
// 3-4 tables (feat/more-tables), Msg 31 at +33: pass the device.
export const spanAfter = (type, dev = null) => (/canboard/i.test(type || '') ? 14 : Math.max(dev?.family === 'upstream' && dev.paramRuns && has(dev, 0x1000, 33) ? 32 : 30, [30, 32, 32, 33, 33][upstreamTables(dev)]))
// number of 0x1B00 table blocks in the upstream module's param list (0 for the fork / unread)
const upstreamTables = (dev) => dev?.family !== 'upstream' ? 0
  : Math.min(4, new Set((dev.paramRuns ?? []).flatMap((r) => Array.from({ length: r[1] }, (_, k) => r[0] + k)).filter((i) => i >= 0x1b00 && i < 0x1c00)).size)
export const isModule = (type) => /pdm|canboard/i.test(type || '')

export function nextPow2(n) {
  return 1 << Math.max(0, Math.ceil(Math.log2(Math.max(1, n))))
}

// IDs occupied by a device of `type` at `base`, including the guard, clamped to [0, STD_MAX].
function addFootprint(used, type, base, dev = null) {
  const lo = Math.max(0, base - ID_BEFORE)
  const hi = Math.min(STD_MAX, base + spanAfter(type, dev))
  for (let id = lo; id <= hi; id++) used.add(id)
}

// Set of used standard IDs across the fleet (plus reserved OBD unless reserve=false).
// `exclude` skips one device guid (e.g. the one being re-based).
export function usedIds(devices, { reserve = true, exclude = null } = {}) {
  const used = new Set()
  for (const d of devices || []) {
    if (!isModule(d.type) || d.guid === exclude) continue
    addFootprint(used, d.type, d.baseId, d)
  }
  if (reserve) for (const id of OBD_RESERVED) used.add(id)
  return used
}

// Lowest base in [lo, hi] where a NEW device of `type` fits entirely in free space (guard
// included, so the result never trips the overlap check). Null if nothing fits.
export function suggestBase(type, used, lo = 0, hi = STD_MAX) {
  const after = spanAfter(type)
  for (let base = Math.max(lo, ID_BEFORE); base + after <= hi; base++) {
    let ok = true
    for (let id = base - ID_BEFORE; id <= base + after; id++) {
      if (used.has(id)) { ok = false; break }
    }
    if (ok) return base
  }
  return null
}

// Contiguous free runs in [0, STD_MAX] at least minLen wide - for display.
export function freeRanges(used, minLen = 8) {
  const out = []
  let cur = 0
  for (let id = 0; id <= STD_MAX; id++) {
    if (used.has(id)) {
      if (id - cur >= minLen) out.push([cur, id - 1])
      cur = id + 1
    }
  }
  if (STD_MAX + 1 - cur >= minLen) out.push([cur, STD_MAX])
  return out
}

// Overlapping base-ID-span pairs among the fleet - the System view conflict check.
export function conflictPairs(devices) {
  const m = (devices || []).filter((d) => isModule(d.type))
  const out = []
  for (let i = 0; i < m.length; i++) {
    for (let j = i + 1; j < m.length; j++) {
      const a = m[i], b = m[j]
      if (a.baseId - ID_BEFORE <= b.baseId + spanAfter(b.type, b) &&
          b.baseId - ID_BEFORE <= a.baseId + spanAfter(a.type, a)) {
        out.push([a, b])
      }
    }
  }
  return out
}
