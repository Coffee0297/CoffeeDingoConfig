// Checks the project before Apply to car. Pure: no API calls, no Svelte.
// An error stops Apply for that module (it would do something wrong on the car); a warning asks first.
// Each issue: { level: 'error' | 'warn', guid, module, node, title, why } — `node` is a flow-builder id
// ('timer:2', 'output:3', 'sys') so the panel can link to the page that fixes it.

import { buildModel, consumersOfNode, hexId } from '../../screens/functions/flow/model.js'

// incompleteReasons that mean a wrong value, not just a block that stays inactive
const BAD_VALUE = /must/
// blocks whose only job is to feed other blocks: switched on with nothing reading them is a leftover
const FEEDS = new Set(['virtualinput', 'condition', 'counter', 'flasher', 'timer', 'table', 'math', 'caninput', 'comfortblink'])

/** Last data byte a CAN signal touches (same rule as the CAN input editor). */
export function lastByte(startBit, bitLength, byteOrder) {
  const first = Math.floor(startBit / 8)
  return byteOrder === 1 ? first + Math.ceil(Math.max(0, bitLength - ((startBit % 8) + 1)) / 8) : Math.floor((startBit + bitLength - 1) / 8)
}

/**
 * One module.
 * dev  = telemetry device record, funcs = GET /devices/{id}/functions, vmap = GET /devices/{id}/inputs,
 * def  = its /api/definitions entry (outputCurrentRatings), claimed = /api/can-id-map `claimed` (or null).
 */
export function checkModule({ dev, funcs, vmap, def, claimed }) {
  const out = []
  const add = (level, node, title, why) => out.push({ level, guid: dev.guid, module: dev.name, node, title, why })
  const model = buildModel(dev, funcs, vmap)

  for (const n of model.nodes.values()) {
    if (!n.enabled) continue
    for (const why of n.disabledSource ? [] : n.incomplete ?? []) {
      const bad = BAD_VALUE.test(why) || ((n.kind === 'canoutput' || n.kind === 'canmsg') && /CAN ID/.test(why))
      add(bad ? 'error' : 'warn', n.id, n.title, bad && /CAN ID/.test(why) ? why + ' (it would send on 0x000)' : why)
    }
    // a wire whose source is gone (block removed, or a signal this firmware does not have)
    for (const p of n.ins) if (p.src > 0 && !model.byIdx.has(p.src)) add('error', n.id, n.title, `${p.label} reads a signal this module does not have (#${p.src})`)
    if (FEEDS.has(n.kind) && !consumersOfNode(model, n.id).length) add('warn', n.id, n.title, 'is switched on, but nothing on this module uses it')
  }
  for (const n of model.nodes.values()) if (n.disabledSource) add('warn', n.id, n.title, 'is switched off, so the blocks that use it read 0')

  for (const ci of funcs?.canInputs ?? []) {
    if (!ci.enabled || !ci.id) continue
    const id = `caninput:${ci.number}`, t = model.nodes.get(id)?.title ?? `CAN input ${ci.number}`
    if (lastByte(ci.startBit ?? 0, ci.bitLength ?? 8, ci.byteOrder ?? 0) > 7) add('error', id, t, `bit ${ci.startBit}+${ci.bitLength} runs past the 8 data bytes of the frame`)
    if (claimed && !claimed[(ci.ide ? 'x' : '') + Number(ci.id).toString(16).toUpperCase()])
      add('warn', id, t, `listens to ${hexId(ci.id)}, which no module or ECU in the project sends (a removed module, or an ECU without a DBC)`)
  }

  const ratings = def?.outputCurrentRatings ?? []
  for (const o of /can.?board/i.test(dev.type ?? '') ? [] : dev.outputs ?? []) {
    if (!o.enabled) continue
    const id = `output:${o.number}`, t = String(o.name ?? '').trim() || `Output ${o.number}`
    const r = ratings[o.number - 1]
    if (r != null && Number(o.currentLimit) > r) add('error', id, t, `trips above ${o.currentLimit} A, more than the ${r} A this pin is rated for`)
    if (Number(o.inrushTime) > 0 && Number(o.inrushLimit) < Number(o.currentLimit)) add('warn', id, t, `inrush allowed (${o.inrushLimit} A) is below the trip current (${o.currentLimit} A), so it trips at less during the first ${o.inrushTime} ms`)
  }
  return out
}

/** Bus-wide: two senders on one id, or two modules' address blocks overlapping (from /api/can-id-map). */
export function checkCanMap(map, devices) {
  const out = []
  const byName = (s) => devices.find((d) => s === d.name || s.startsWith(d.name + ': '))
  for (const c of map?.collisions ?? []) {
    for (const d of new Set(c.owners.map(byName).filter(Boolean)))
      out.push({ level: 'error', guid: d.guid, module: d.name, node: 'sys', title: `CAN id ${c.hex}`, why: `is sent by more than one device: ${c.owners.join(', ')}` })
  }
  for (const o of map?.overlaps ?? []) {
    for (const d of [byName(o.a), byName(o.b)].filter(Boolean))
      out.push({ level: 'error', guid: d.guid, module: d.name, node: 'sys', title: 'Base ID', why: `the address blocks of ${o.a} (${o.aRange}) and ${o.b} (${o.bRange}) overlap` })
  }
  return out
}
