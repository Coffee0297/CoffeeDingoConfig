// CAN base-ID helpers for the module screens. Footprints come from src/lib/canids.js so every screen
// agrees on how many IDs a module takes (PDM 30 + guard, CANBoard 14 + guard).
import { usedIds, spanAfter, ID_BEFORE, isModule } from '../../../../lib/canids.js'

/** Parse "0x6C0" or "6C0" (always hex) → number, or null when it is not an 11-bit ID (0x001 to 0x7FF). */
export function parseId(text) {
  const t = String(text ?? '').trim().replace(/^0x/i, '')
  if (!/^[0-9a-f]{1,3}$/i.test(t)) return null
  const n = parseInt(t, 16)
  return n >= 1 && n <= 0x7ff ? n : null
}

export const hexId = (n) => '0x' + Number(n).toString(16).toUpperCase().padStart(3, '0')

/** The first other module whose frame span overlaps `type` at `base` (null when free). */
export function clashOf(devices, selfGuid, type, base) {
  const after = spanAfter(type, (devices ?? []).find((x) => x.guid === selfGuid))
  // a clash shares an id; the guard below base only steers the suggested bases (a 5.7 PDM fills its whole 0x20 slot)
  return (devices ?? []).find((x) => x.guid !== selfGuid && isModule(x.type) && x.baseId <= base + after && base <= x.baseId + spanAfter(x.type, x)) ?? null
}

/** The span a module takes: "0x680 to 0x69D". `dev`: the module, for what it really sends (a 5.7 PDM up to +36). */
export const spanText = (type, base, dev = null) => `${hexId(base)} to ${hexId(base + spanAfter(type, dev))}`

/** Up to `count` free base IDs for a module of `type`, on 0x10 boundaries. `reserve` keeps 0x7DF-0x7EF free (OBD-II). */
export function freeBases(devices, selfGuid, type, { reserve = true, count = 3, busy = null } = {}) {
  const used = usedIds(devices, { reserve, exclude: selfGuid })
  for (const id of busy ?? []) used.add(id)
  const bases = (devices ?? []).filter((d) => isModule(d.type)).map((d) => d.baseId)
  const after = spanAfter(type)
  const out = []
  for (let b = bases.length ? Math.max(0x10, Math.min(...bases) & ~0xf) : 0x600; out.length < count && b + after <= 0x7ff; b += 0x10) {
    let ok = true
    for (let id = b - ID_BEFORE; id <= b + after && ok; id++) if (used.has(id)) ok = false
    if (ok) out.push(b)
  }
  return out
}

/** IDs something on the bus is sending right now (from the CAN log), so a suggested base is really unused. */
export async function busIds() {
  try {
    const rows = await (await fetch('/api/canlog')).json()
    const list = Array.isArray(rows) ? rows : []
    // an Rx id we also send is our own request echoed back by the bus, not other traffic
    const sent = new Set(list.filter((f) => f.dir !== 'Rx').map((f) => f.id))
    return new Set(list.filter((f) => f.dir === 'Rx' && !sent.has(f.id)).map((f) => f.id))
  } catch { return new Set() }
}

/** The first bus ID with traffic inside the span of `type` at `base`, or null. */
export function busyIn(type, base, busy) {
  for (let id = base; id <= base + spanAfter(type); id++) if (busy?.has(id)) return id
  return null
}

/** True when `base` lies in the OBD-II range that is kept free. */
export const hitsObd = (type, base) => base <= 0x7ef && base + spanAfter(type) >= 0x7df

/** Board word for a module: "dingoPDM", "dingoPDM-Max", "CANBoard". */
export const typeName = (d) => d?.type ?? 'Module'

/** Firmware text: the Sim and unconnected modules report v0.0.0, which is not a real version. */
export function fwText(d) {
  // not answering: what it reported last time, saved in the project (the live version is whoever answered on its ID
  // earlier in this session, which may be another module that was re-addressed since)
  if (!d?.connected) return d?.lastFirmware ? `${d.lastFirmware.replace(/^v/, '')} (last seen)` : 'unknown'
  const v = d.version
  return !v || /^v?0\.0\.0$/.test(v) ? 'not reported' : v.replace(/^v/, '')
}

/** Next free default name: "PDM-06", "CB-3". */
export function nextName(devices, kind) {
  const re = kind === 'canboard' ? /^CB-(\d+)/i : /^PDM-(\d+)/i
  let n = 0
  for (const d of devices ?? []) { const m = re.exec(d.name ?? ''); if (m) n = Math.max(n, Number(m[1])) }
  return kind === 'canboard' ? `CB-${n + 1}` : `PDM-${String(n + 1).padStart(2, '0')}`
}
