// Physical connector pins per board, read off the hardware schematics (dingoPDM v7.5, CANBoard v2), so
// pickers can show "J3-8" next to an input and a template drawing can say where each wire lands.
// Keys are '<group>:<number>' in firmware numbering: di = digital input, ai = analog input, out = output.
// side = how an output switches its load: 'high' supplies +12 V (load to ground), 'low' pulls to ground
// (load from a supply). The dingoPDM-Max has no schematic here yet, so it maps to null (numbers only).

const PDM_V7 = {
  name: 'dingoPDM v7',
  connectors: { J1: '+12 V battery lug', J2: 'GND lug', J3: 'Deutsch DT 12-pin' },
  side: 'high',
  pins: {
    'di:1': ['J3', 8], 'di:2': ['J3', 11],
    'out:1': ['J3', 7], 'out:2': ['J3', 12], 'out:3': ['J3', 10], 'out:4': ['J3', 9],
    'out:5': ['J3', 6], 'out:6': ['J3', 5], 'out:7': ['J3', 4], 'out:8': ['J3', 3],
  },
  power: { '+12V': ['J1', 1], GND: ['J2', 1], 'CAN-H': ['J3', 2], 'CAN-L': ['J3', 1] },
}

const CANBOARD_V2 = {
  name: 'CANBoard v2',
  connectors: { J1: 'Power / CAN, 8-pin', J2: 'Analog inputs, 8-pin', J3: 'Digital inputs, 8-pin', J4: 'Outputs, 8-pin' },
  side: 'low',   // DMN2004WK N-MOSFET per output, source to ground
  pins: {
    'di:1': ['J3', 1], 'di:2': ['J3', 2], 'di:3': ['J3', 3], 'di:4': ['J3', 4],
    'di:5': ['J3', 5], 'di:6': ['J3', 6], 'di:7': ['J3', 7], 'di:8': ['J3', 8],
    'ai:1': ['J2', 2], 'ai:2': ['J2', 3], 'ai:3': ['J2', 4], 'ai:4': ['J2', 6], 'ai:5': ['J2', 8],
    'out:1': ['J4', 2], 'out:2': ['J4', 4], 'out:3': ['J4', 6], 'out:4': ['J4', 8],
  },
  // +5 V next to each output (J4-1/3/5/7), and the sensor supply on J2-1/5/7.
  supply: { 'out:1': ['J4', 1], 'out:2': ['J4', 3], 'out:3': ['J4', 5], 'out:4': ['J4', 7] },
  power: { '+12V': ['J1', 5], GND: ['J1', 3], 'CAN-H': ['J1', 1], 'CAN-L': ['J1', 2], '+5V': ['J2', 1] },
}

export function boardOf(device) {
  const t = device?.type ?? ''
  if (/can.?board/i.test(t)) return CANBOARD_V2
  if (/max/i.test(t) || device?.pdmType === 1) return null
  if (/pdm/i.test(t)) return PDM_V7
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
  const [conn, pin] = p
  return { conn, pin, label: `${conn}-${pin}`, side: g === 'out' ? b.side : null, connector: b.connectors[conn] }
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

// Text a search box can match: 'J3-8', 'J3.8', 'pin 8'.
export const pinSearchText = (p) => (p ? `${p.label} ${p.conn}.${p.pin} pin ${p.pin}` : '')
