// Engine values (RPM, gear, coolant) from a CAN input or an imported ECU (DBC) device, when the project
// has one. Which signal means "RPM" is guessed from its name (API gap G4: the choice cannot be stored
// with the project yet). One read of every module's signals finds the sources; only those are polled.
import { live, api } from '../../../lib/live.svelte.js'
import { feed, watchSignals } from './feed.svelte.js'

const RPM = /rpm|engine.?speed/i
const NOT_A_VALUE = /[<>=]|above|below|over|under|running|ok$/i   // threshold flags such as "RPM > 400"
const GEAR = /gear/i
const COOLANT = /coolant|ect$|water.?temp/i
const isSource = (s) => (s.kind === 'DBC' || s.kind === 'CAN input') && s.enabled !== false

/** Call during component setup. Returns a reactive { rpm, gear, coolant, source, guid } (null = not available). */
export function useEcu() {
  const out = $state({ rpm: null, gear: null, coolant: null, source: '', guid: '' })
  let found = $state({ rpm: null, gear: null, coolant: null }) // { guid, name } each

  const devKey = $derived(live.devices.map((d) => d.guid).join(','))
  $effect(() => {
    if (!devKey) return
    let alive = true
    ;(async () => {
      const next = { rpm: null, gear: null, coolant: null }
      for (const d of live.devices) {
        let list
        try { list = (await api.signals(d.guid)) ?? [] } catch { continue }
        for (const s of list.filter(isSource)) {
          if (!next.rpm && RPM.test(s.name) && !NOT_A_VALUE.test(s.name)) next.rpm = { guid: d.guid, name: s.name, dev: d.name }
          if (!next.gear && GEAR.test(s.name)) next.gear = { guid: d.guid, name: s.name, dev: d.name }
          if (!next.coolant && COOLANT.test(s.name)) next.coolant = { guid: d.guid, name: s.name, dev: d.name }
        }
      }
      if (alive) found = next
    })()
    return () => { alive = false }
  })

  const watchKey = $derived([...new Set(Object.values(found).filter(Boolean).map((f) => f.guid))].join(','))
  $effect(() => {
    if (!watchKey) return
    return watchSignals(watchKey.split(','))
  })
  $effect(() => {
    feed.tick
    const val = (f) => {
      if (!f) return null
      const s = (feed.byGuid[f.guid] ?? []).find((x) => x.name === f.name)
      return s ? s.value : null
    }
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
    out.rpm = num(val(found.rpm))
    out.coolant = num(val(found.coolant))
    out.gear = val(found.gear)
    out.source = found.rpm?.dev ?? ''
    out.guid = found.rpm?.guid ?? ''
  })
  return out
}
