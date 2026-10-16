// Physical connector pins per board, read off the hardware schematics, so pickers can show "J3-8" next to an
// input and a template drawing can say where each wire lands. The facts live in the backend's
// pdm-definitions.json ("board" per type, also served by /api/definitions, G21); this module reads the same
// file so it stays synchronous. Keys are '<group>:<number>' in firmware numbering: di = digital input,
// ai = analog input, out = output. side = how an output switches its load: 'high' supplies +12 V (load to
// ground), 'low' pulls to ground (load from a supply). An entry [conn, pin, pin2] is an output on two
// connector pins (the Max doubles them).
import defs from '../../../pdm-definitions.json' with { type: 'json' }

const byType = new Map([...(defs.pdms ?? []), ...(defs.canboards ?? [])].filter((d) => d.board).map((d) => [d.typeName.toLowerCase(), d.board]))

/** Board facts for a device: { name, side, luaBytes, drivers[], connectors, pins, supply?, power }, or null. */
export function boardOf(device) {
  const t = (device?.type ?? '').toLowerCase()
  if (device?.pdmType === 1) return byType.get('dingopdm-max') ?? null   // a Max saved under the 'dingoPDM' type
  if (byType.has(t)) return byType.get(t)
  // older project files name the type loosely ('pdm', 'canboard', 'dingoPDMMax')
  if (/can.?board/.test(t)) return byType.get('canboard') ?? null
  if (/max/.test(t)) return byType.get('dingopdm-max') ?? null
  if (/^(dingo)?pdm$/.test(t)) return byType.get('dingopdm') ?? null
  return null
}

// Function kinds as the var map ('input', 'analoginput', 'output', 'digitaloutput') and the broadcast
// signals ('Input', 'DigitalInput', 'AnalogInput', 'RotarySwitch', 'Output', 'DigitalOutput') name them.
const GROUP = {
  input: 'di', digitalinput: 'di', analoginput: 'ai', rotaryswitch: 'ai', analogswitch: 'ai',
  output: 'out', digitaloutput: 'out',
}

// { conn, pin, label: 'J3-8', side, connector } for a physical input/output, null for anything else.
export function pinFor(device, kind, number) {
  const b = boardOf(device)
  const g = GROUP[String(kind).toLowerCase()]
  const p = b && g && b.pins[`${g}:${number}`]
  if (!p) return null
  const [conn, pin, pin2] = p
  return { conn, pin, pin2, label: `${conn}-${pin}${pin2 ? '/' + pin2 : ''}`, side: g === 'out' ? b.side : null, connector: b.connectors[conn] }
}

// The same from a broadcast signal name ('DigitalInput3.State', 'Output2.Current', 'RotarySwitch1').
export function pinFromSignal(device, signalName) {
  const m = /^([A-Za-z]+?)(\d+)/.exec(signalName ?? '')
  return m ? pinFor(device, m[1], +m[2]) : null
}

// Short function tag as printed on the boards: 'DI3', 'AI1', 'OUT2' (PDM) / 'DO2' (CANBoard).
export function ioTag(device, kind, number) {
  const g = GROUP[String(kind).toLowerCase()]
  if (!g) return ''
  if (g === 'out') return (/can.?board/i.test(device?.type ?? '') ? 'DO' : 'OUT') + number
  return g.toUpperCase() + number
}
export function ioTagFromSignal(device, signalName) {
  const m = /^([A-Za-z]+?)(\d+)/.exec(signalName ?? '')
  return m ? ioTag(device, m[1], +m[2]) : ''
}

// Text a search box can match: 'J3-8', 'J3.8', 'pin 8' (and the second pin of a doubled output).
export const pinSearchText = (p) => (p ? [p.pin, p.pin2].filter(Boolean).map((n) => `${p.conn}-${n} ${p.conn}.${n} pin ${n}`).join(' ') : '')
