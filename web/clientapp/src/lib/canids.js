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

// Footprint per module type, matching firmware NUM_TX_MSGS: a CANboard owns base..base+10
// (9 cyclic msgs), a dingoPDM/-Max owns base..base+28 (27). +1 guard ID below base (settings).
export const ID_BEFORE = 1
export const spanAfter = (type) => (/canboard/i.test(type || '') ? 10 : 28)
export const isModule = (type) => /pdm|canboard/i.test(type || '')

export function nextPow2(n) {
  return 1 << Math.max(0, Math.ceil(Math.log2(Math.max(1, n))))
}

// IDs occupied by a device of `type` at `base`, including the guard, clamped to [0, STD_MAX].
function addFootprint(used, type, base) {
  const lo = Math.max(0, base - ID_BEFORE)
  const hi = Math.min(STD_MAX, base + spanAfter(type))
  for (let id = lo; id <= hi; id++) used.add(id)
}

// Set of used standard IDs across the fleet (plus reserved OBD unless reserve=false).
// `exclude` skips one device guid (e.g. the one being re-based).
export function usedIds(devices, { reserve = true, exclude = null } = {}) {
  const used = new Set()
  for (const d of devices || []) {
    if (!isModule(d.type) || d.guid === exclude) continue
    addFootprint(used, d.type, d.baseId)
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
      if (a.baseId - ID_BEFORE <= b.baseId + spanAfter(b.type) &&
          b.baseId - ID_BEFORE <= a.baseId + spanAfter(a.type)) {
        out.push([a, b])
      }
    }
  }
  return out
}
