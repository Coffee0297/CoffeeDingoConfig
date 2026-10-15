// Trip log helpers shared by Car home and the Trips screen. The module records each trip with a
// -10 s ... +3 s current waveform (40 ms points). It records no time (API gap G6), so trips are
// ordered by position in the log only.
import { api } from '../../../lib/live.svelte.js'
import { tripReason } from '../../../../lib/trip.js'

/** Modules that have outputs (and so can have a trip log). */
export const tripDevices = (devices) => devices.filter((d) => (d.outputs ?? []).length > 0)

/** Read one module's trip log into display rows. Throws when the module does not answer. */
export async function readTrips(dev) {
  const r = await api.overloads(dev.guid)
  return (r?.events ?? []).map((e, index) => {
    const out = dev.outputs?.find((o) => o.number === e.output)
    const why = tripReason(e, out)
    return {
      guid: dev.guid, dev: dev.name, index, output: e.output, outName: (out?.name ?? '').trim(), state: e.state,
      peakA: e.peakA ?? 0, limitA: why.limitA, steadyA: out?.currentLimit ?? e.limitA ?? 0, kind: why.kind,
      onS: why.onS, text: why.text, clears: why.clears, samples: e.samples ?? [], out,
    }
  })
}

/** Read every listed module in parallel; modules that fail are reported, not hidden. onPart(partial) fires as each one answers. */
export async function readAllTrips(devices, onPart) {
  const items = [], errors = []
  const snap = () => ({ items: [...items].sort((a, b) => a.dev.localeCompare(b.dev) || b.index - a.index), errors: [...errors] })
  await Promise.all(tripDevices(devices).map(async (d) => {
    try { items.push(...(await readTrips(d))) } catch (e) { errors.push({ dev: d.name, guid: d.guid, message: e?.message ?? String(e) }) }
    onPart?.(snap())
  }))
  return snap()
}

export const tripTitle = (t) => `${t.outName || 'Output ' + t.output} ${t.state === 'Fault' ? 'faulted' : 'tripped'}`
