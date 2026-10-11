// One searchable list of every input on the bus for a picker on module `consumer`: its own var-map
// signals (picked by index) plus every other module's configured broadcast signals (picked by a
// 'remote:' key, which the picker turns into a local CAN input on pick). Each option carries the
// physical connector pin when there is one, so "J3-3", "DI3", "cb-1 ign" all find the same switch.
import { pinFor, pinFromSignal, pinSearchText, ioTag, ioTagFromSignal } from './pinmap.js'

// The physical input behind a signal ({kind, number} as setFunction names it), or null for logic.
const PHYS = { input: 'input', analoginput: 'analoginput' }
// A pin still carrying its factory name ('digitalInput3'), i.e. nobody has said what it does.
export const isDefaultName = (n) => /^(digitalInput|analogInput|input)\d+$/i.test(n ?? '')
export function physInput(sigName) {
  const m = /^(?:Digital)?Input(\d+)\.State$|^AnalogInput(\d+)\.Millivolts$/.exec(sigName ?? '')
  return m ? (m[1] ? { kind: 'input', number: +m[1] } : { kind: 'analoginput', number: +m[2] }) : null
}

const label = (module, pin, tag, name, remote) =>
  [module, [pin?.label, tag].filter(Boolean).join(' '), name].filter(Boolean).join(' · ') + (remote ? '  (over CAN)' : '')

// localVars: api.inputs(guid, type) entries {index, name, kind, number, unused?}. remotes: [{device, sigs}] with
// sigs from api.broadcastSignals(guid): configured signals, plus the physical inputs nobody uses yet
// (marked "not enabled yet"; whoever applies the pick enables them). kind: 'bool' (on/off) or 'num' (a value).
export function busInputOptions(consumer, localVars, remotes, kind) {
  const opts = []
  for (const v of localVars ?? []) {
    const pin = pinFor(consumer, v.kind, v.number), tag = ioTag(consumer, v.kind, v.number)
    const phys = PHYS[v.kind] ? { kind: v.kind, number: v.number } : null
    opts.push({ value: v.index, label: label(consumer?.name, pin, tag, v.name + (v.unused ? ' · not enabled yet' : ''), false), search: pinSearchText(pin), pin, local: true, module: consumer?.name, tag, phys, unused: !!v.unused })
  }
  for (const { device, sigs } of remotes ?? []) {
    for (const s of sigs ?? []) {
      if (s.isFloat) continue                                  // a CAN input can't decode float32 frames
      if ((kind === 'bool') !== (s.kind === 'bool')) continue
      const phys = physInput(s.name), unused = s.inUse === false
      if (unused && !phys) continue                             // unconfigured logic broadcasts nothing useful
      const pin = pinFromSignal(device, s.name), tag = ioTagFromSignal(device, s.name)
      const name = (s.label ?? s.name) + (unused ? ' · not enabled yet' : '')
      opts.push({ value: `remote:${device.guid}:${s.name}`, label: label(device.name, pin, tag, name, true), phys, unused,
        search: pinSearchText(pin) + ' ' + s.name, pin, local: false, source: device, sig: s, module: device.name, tag })
    }
  }
  // Own signals first; within each, wired pins before logic so the physical switches lead.
  return opts.sort((a, b) => (b.local - a.local) || (!!b.pin - !!a.pin))
}
