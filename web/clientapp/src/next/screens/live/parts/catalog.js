// Every signal the Plot can draw. Telemetry-backed ones (battery, current, temperature, output currents)
// have history from the live feed; the others come from GET /devices/{guid}/signals while watched.
import { keys } from './feed.svelte.js'
import { isPdm } from '../../../lib/live.svelte.js'

const PLAIN_ON_OFF = new Set(['Output', 'Digital input', 'Virtual input', 'Flasher', 'Timer', 'Analog switch', 'Digital output'])

/** @param devices live.devices   @param signalsByGuid { guid: SignalDto[] } */
export function buildCatalog(devices, signalsByGuid) {
  const list = [
    { key: keys.total, name: 'Total current', mod: 'all PDMs', unit: 'A', kind: 'Car' },
    { key: keys.battMax, name: 'Battery voltage', mod: 'highest PDM', unit: 'V', kind: 'Car' },
    { key: keys.hottest, name: 'Hottest module', mod: 'all modules', unit: '°C', kind: 'Car' },
  ]
  for (const d of devices) {
    if (isPdm(d)) {
      list.push({ key: keys.batt(d.guid), name: 'Battery voltage', mod: d.name, unit: 'V', kind: 'Module' })
      list.push({ key: keys.cur(d.guid), name: 'Module current', mod: d.name, unit: 'A', kind: 'Module' })
    }
    list.push({ key: keys.temp(d.guid), name: 'Temperature', mod: d.name, unit: '°C', kind: 'Module' })
    for (const o of d.outputs ?? []) {
      if (o.enabled === false) continue
      list.push({ key: keys.out(d.guid, o.number), name: `${o.name?.trim() || 'Output ' + o.number} current`, mod: d.name, unit: 'A', kind: 'Output current' })
    }
    for (const s of signalsByGuid[d.guid] ?? []) {
      if (s.enabled === false) continue
      const onOff = PLAIN_ON_OFF.has(s.kind)
      list.push({ key: keys.sig(d.guid, s.name), name: s.kind === 'Output' ? `${s.name} state` : s.name, mod: d.name, unit: s.kind === 'Analog input' ? 'mV' : onOff ? 'on/off' : '', kind: s.kind })
    }
  }
  return list
}

const PREFIXES = ['sig:', 'out:', 'cur:', 'bat:', 'tmp:']
/** Turn a `?signal=` token into a feed key. Accepts a feed key, `guid|signal name` or `Module name|signal name`. */
export function resolveSignalToken(token, devices) {
  if (!token) return null
  if (PREFIXES.some((p) => token.startsWith(p)) || [keys.total, keys.battMax, keys.hottest].includes(token)) return token
  const i = token.indexOf('|')
  if (i > 0) {
    const who = token.slice(0, i), name = token.slice(i + 1)
    if (/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(who)) return keys.sig(who, name)
    const d = devices.find((x) => x.name === who)
    if (d) return keys.sig(d.guid, name)
  }
  return null
}

/** Readable fallback for a key that is not in the catalog (yet). */
export function describeKey(key, devices) {
  const dev = (g) => devices.find((d) => d.guid === g)?.name ?? g
  const [kind, a, ...rest] = key.split(':')
  const b = rest.join(':')
  if (kind === 'sig') return { name: b, mod: dev(a), unit: '' }
  if (kind === 'out') return { name: `Output ${b} current`, mod: dev(a), unit: 'A' }
  if (kind === 'cur') return { name: 'Module current', mod: dev(a), unit: 'A' }
  if (kind === 'bat') return { name: 'Battery voltage', mod: dev(a), unit: 'V' }
  if (kind === 'tmp') return { name: 'Temperature', mod: dev(a), unit: '°C' }
  return { name: key, mod: '', unit: '' }
}
