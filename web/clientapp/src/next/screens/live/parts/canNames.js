// Friendly names for CAN IDs: from the project's modules (their base id + cyclic range) and the
// backend's id map (who broadcasts or sends what). Anything else is shown as "unknown device".
import { spanAfter } from '../../../../lib/canids.js'

/** @param devices live.devices   @param idMap GET /api/can-id-map (or null) */
export function makeNamer(devices, idMap) {
  const claimed = idMap?.claimed ?? {}
  return (id, ide) => {
    const c = claimed[(ide ? 'x' : '') + id.toString(16).toUpperCase()]
    if (c?.length) return c.map((s) => s.replace(': ', ' · ')).join(', ')
    for (const d of devices) {
      const off = id - d.baseId
      if (off >= 0 && off <= spanAfter(d.type)) return off === 0 ? `${d.name} · settings` : off === 1 ? `${d.name} · settings reply` : `${d.name} · +${off}`
    }
    return ''
  }
}

/** Approximate bits on the wire for one standard frame (incl. a typical amount of stuffing). */
export const frameBits = (dlc, ide) => Math.round((ide ? 67 : 47) + 8 * dlc) * 1.2

export function parseBitrate(s) {
  const m = /(\d+(?:\.\d+)?)\s*([KM])/i.exec(s ?? '')
  return m ? Number(m[1]) * (m[2].toUpperCase() === 'M' ? 1_000_000 : 1000) : 500_000
}
