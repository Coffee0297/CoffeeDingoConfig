// Cross-module links: which CAN input on one module decodes which signal another module broadcasts.
// Resolved from GET /devices/{id}/broadcast-signals (offset from the module base id + bit layout) and
// GET /api/can-id-map (frames sent by Lua or by an ECU). No guessing by name.
import { api } from '../../../lib/live.svelte.js'
import { spanAfter, isModule } from '../../../../lib/canids.js'
import { buildModel } from './model.js'

const bcCache = new Map()
export function broadcastOf(guid) {
  if (!bcCache.has(guid)) bcCache.set(guid, api.broadcastSignals(guid).then((s) => (Array.isArray(s) ? s : [])).catch(() => { bcCache.delete(guid); return [] }))
  return bcCache.get(guid)
}

const PREFIX = { AnalogInput: 'analoginput', RotarySwitch: 'analoginput', DigitalInput: 'input', Input: 'input', DigitalOutput: 'digitaloutput', Output: 'output', CanInput: 'caninput', VirtualInput: 'virtualinput', Condition: 'condition', Counter: 'counter', Flasher: 'flasher', Timer: 'timer', Table: 'table' }
/** Broadcast signal name → the node on the source module ("RotarySwitch1.Pos" → analoginput:1). */
export function bcNode(name) {
  const m = /^([A-Za-z]+?)(\d+)(?:\.(\w+))?$/.exec(name ?? '')
  if (m && PREFIX[m[1]]) return `${PREFIX[m[1]]}:${Number(m[2])}`
  if (/^Wiper/.test(name ?? '')) return 'wiper:1'
  return 'sys'
}

/**
 * Where a CAN input's frame comes from. Returns { kind: 'module' | 'other', dev?, sig?, node?, label } or null
 * (frame from an ECU / unknown sender).
 */
export function remoteSource(ci, self, devices, bcBy, idMap) {
  if (!ci?.id) return null
  if (!ci.ide) {
    for (const d of devices) {
      if (d.guid === self?.guid || !isModule(d.type)) continue
      const off = ci.id - (d.baseId ?? 0)
      if (off < 0 || off > spanAfter(d.type, d)) continue
      const sig = (bcBy[d.guid] ?? []).find((s) => s.offset === off && s.startBit === ci.startBit && s.bitLength === ci.bitLength)
      return { kind: 'module', dev: d, sig, node: sig ? bcNode(sig.name) : null, label: `${d.name} · ${sig ? (sig.label ?? sig.name).replace(/ · /g, ' ') : 'frame +' + off}` }
    }
  }
  const owners = (idMap?.claimed?.[(ci.ide ? 'x' : '') + Number(ci.id).toString(16).toUpperCase()] ?? []).filter((o) => !o.startsWith((self?.name ?? '') + ':'))
  if (owners.length) return { kind: 'other', label: owners.join(', ').replace(/: Lua txCan/g, ' (Lua)').replace(/: broadcast/g, '') }
  return null
}

/** Load every module's blocks + the frames they broadcast. */
export async function loadCar(devices) {
  const mods = devices.filter((d) => isModule(d.type))
  const [idMap, ...per] = await Promise.all([
    api.canIdMap().catch(() => null),
    ...mods.map(async (d) => {
      const [funcs, vmap, bc] = await Promise.all([api.functions(d.guid), api.inputs(d.guid).catch(() => []), broadcastOf(d.guid)])
      return { d, funcs, vmap, bc }
    }),
  ])
  const bcBy = Object.fromEntries(per.map((p) => [p.d.guid, p.bc]))
  return { mods: per, bcBy, idMap }
}

/** Every cross-module link of the car: [{ from: {guid, node}, to: {guid, node}, label, sig }]. */
export function carLinks(car, devices) {
  const links = []
  for (const p of car.mods) {
    for (const ci of (p.funcs?.canInputs ?? []).filter((x) => x.enabled)) {
      const src = remoteSource(ci, p.d, devices, car.bcBy, car.idMap)
      if (src?.kind === 'module') links.push({ from: { guid: src.dev.guid, node: src.node }, to: { guid: p.d.guid, node: 'caninput:' + ci.number }, label: src.label, sig: src.sig })
    }
  }
  return links
}

/** Models for every module (for the whole-car canvas). */
export function carModels(car, devices) {
  return car.mods.map((p) => ({ dev: devices.find((d) => d.guid === p.d.guid) ?? p.d, funcs: p.funcs, vmap: p.vmap, model: buildModel(devices.find((d) => d.guid === p.d.guid) ?? p.d, p.funcs, p.vmap) }))
}
