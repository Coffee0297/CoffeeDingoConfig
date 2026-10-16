// Trip log helpers shared by Car home and the Trips screen. The module records each trip with a
// -10 s ... +3 s current waveform (40 ms points). Firmware 5.6 also keeps when each trip happened (`at`,
// UTC) and logs notices (an output going into Warning or OpenLoad, no waveform); older firmware has no
// times, so those trips are ordered by position in the log only.
import { api } from '../../../lib/live.svelte.js'
import { tripReason } from '../../../../lib/trip.js'

/** Modules that have outputs (and so can have a trip log). */
export const tripDevices = (devices) => devices.filter((d) => (d.outputs ?? []).length > 0)

/** Read one module's trip log into display rows. Throws when the module does not answer. */
export async function readTrips(dev) {
  const r = await api.overloads(dev.guid)
  return (r?.events ?? []).map((e, index) => {
    if (e.kind && e.kind !== 'trip') {
      const out = dev.outputs?.find((o) => o.number === e.output)
      return { notice: true, guid: dev.guid, dev: dev.name, index, output: e.output, outName: (out?.name ?? '').trim(), kind: e.kind, at: e.at ?? null }
    }
    const out = dev.outputs?.find((o) => o.number === e.output)
    const why = tripReason(e, out)
    return {
      guid: dev.guid, dev: dev.name, index, output: e.output, outName: (out?.name ?? '').trim(), state: e.state,
      peakA: e.peakA ?? 0, limitA: why.limitA, steadyA: out?.currentLimit ?? e.limitA ?? 0, kind: why.kind,
      onS: why.onS, text: why.text, clears: why.clears, samples: e.samples ?? [], out, at: e.at ?? null,
    }
  })
}

/** Read every listed module in parallel; modules that fail are reported, not hidden. onPart(partial) fires as each one answers. */
export async function readAllTrips(devices, onPart) {
  const items = [], notices = [], errors = []
  const newest = (a, b) => (b.at && a.at ? b.at.localeCompare(a.at) : 0)
  const snap = () => ({ items: [...items].sort((a, b) => a.dev.localeCompare(b.dev) || newest(a, b) || b.index - a.index),
    notices: [...notices].sort((a, b) => newest(a, b) || a.dev.localeCompare(b.dev)), errors: [...errors] })
  await Promise.all(tripDevices(devices).map(async (d) => {
    try { for (const t of await readTrips(d)) (t.notice ? notices : items).push(t) } catch (e) { errors.push({ dev: d.name, guid: d.guid, message: e?.message ?? String(e) }) }
    onPart?.(snap())
  }))
  return snap()
}

/** "16 Oct 14:03:22" in the viewer's time zone (fixed format, not the OS locale), or '' without a time. */
export function whenText(at) {
  if (!at) return ''
  const d = new Date(at), p = (n) => String(n).padStart(2, '0')
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]
  return `${d.getDate()} ${mon} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export const noticeText = (n) => `${n.outName || 'Output ' + n.output} ${n.kind === 'openload' ? 'had nothing connected (open load)' : 'went over its warning level'}`

export const tripTitle = (t) => `${t.outName || 'Output ' + t.output} ${t.state === 'Fault' ? 'faulted' : 'tripped'}`
