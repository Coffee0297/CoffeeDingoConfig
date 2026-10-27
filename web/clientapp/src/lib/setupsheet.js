// Printable setup / pinout sheet for one module (the browser prints it, or saves it as PDF). Pure: the caller
// passes the live device record, its /functions, /api/definitions, the /can-id-map `claimed` table (who sends
// each id) and the module's var-map names (index -> name, for CANBoard outputs).
import { boardOf, pinFor, ioTag } from './pinmap.js'
import { awgFor, awgForMm2, vDrop } from './wire.js'
import { outputRatingA } from './apply.js'

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const isCb = (d) => /can.?board/i.test(d?.type ?? '')
const hexId = (id, ide) => '0x' + Number(id ?? 0).toString(16).toUpperCase().padStart(ide ? 8 : 3, '0')
const PULL = ['none', 'pull-up', 'pull-down']
const MODE = ['momentary', 'latching']

/** The sheet's rows: { outputs, digital, analog, can, power, harness }. Disabled items are left out. */
export function sheetRows({ device, fx = {}, defs = {}, claimed = {}, names = {} }) {
  const cb = isCb(device)
  const pin = (kind, n) => pinFor(device, kind, n)?.label ?? ''
  const outs = cb
    ? (fx.digitalOut ?? []).filter((o) => o.enabled).map((o) => ({ n: o.number, name: o.name, driven: o.input ? (names[o.input] ?? '#' + o.input) : '', limit: null, inrush: null, rating: null, mm2: 0, len: 0, color: '' }))
    : (device?.outputs ?? []).filter((o) => o.enabled).map((o) => ({ n: o.number, name: o.name, driven: o.input && o.input !== 'None' ? o.input : '', limit: o.currentLimit, inrush: o.inrushLimit,
      rating: outputRatingA(defs, device.type, o.number), mm2: Number(o.wireGaugeMm2) || 0, len: Number(o.wireLength) || 0, color: [o.wireColor, o.wireStripe].filter(Boolean).join(' / ') }))
  const outputs = outs.map((o) => {
    const rec = awgFor(o.limit)
    const mm2 = o.mm2 || rec?.mm2 || 0
    return { ...o, tag: ioTag(device, 'output', o.n), pin: pin('output', o.n), rec, gauge: mm2 ? `${mm2} mm² (${o.mm2 ? awgForMm2(mm2) : rec.awg} AWG)` : '', recommended: !o.mm2 && !!rec,
      under: !!(o.mm2 && rec && o.mm2 < rec.mm2), drop: vDrop(o.len, o.limit, mm2), mm2Used: mm2 }
  })
  const digital = ((cb ? fx.digitalIn : fx.inputs) ?? []).filter((i) => i?.enabled).map((i) => ({ n: i.number, tag: ioTag(device, 'input', i.number), pin: pin('input', i.number), name: i.name,
    how: i.pwm ? 'PWM / frequency' : `${MODE[i.mode] ?? i.mode}${i.invert ? ', inverted' : ''}, ${PULL[i.pull] ?? i.pull}` }))
  const analog = (fx.analogIn ?? []).filter((i) => i.enabled).map((i) => ({ n: i.number, tag: ioTag(device, 'analoginput', i.number), pin: pin('analoginput', i.number), name: i.name }))
  const can = (fx.canInputs ?? []).filter((c) => c.enabled).map((c) => ({ n: c.number, name: c.name, id: hexId(c.id, c.ide), ide: !!c.ide,
    bits: `${c.startBit} +${c.bitLength} ${c.byteOrder ? 'Motorola' : 'Intel'}${c.signed ? ' signed' : ''}`, scale: `×${c.factor ?? 1} ${(c.offset ?? 0) < 0 ? '−' : '+'} ${Math.abs(c.offset ?? 0)}`,
    source: (claimed[(c.ide ? 'x' : '') + Number(c.id).toString(16).toUpperCase()] ?? []).join('; ') }))
  const power = Object.entries(boardOf(device)?.power ?? {}).map(([what, [conn, p]]) => ({ what, pin: `${conn}-${p}` }))

  // Harness: output wires per gauge, connectors in use, known one-way length.
  const perGauge = new Map()
  for (const o of outputs) if (o.mm2Used) perGauge.set(o.mm2Used, (perGauge.get(o.mm2Used) ?? 0) + 1)
  const labels = [...outputs, ...digital, ...analog].map((r) => r.pin).concat(power.map((p) => p.pin)).filter(Boolean)
  const harness = {
    gauges: [...perGauge].sort((a, b) => a[0] - b[0]).map(([mm2, count]) => ({ mm2, awg: awgForMm2(mm2), count })),
    connectors: [...new Set(labels.map((l) => l.split('-')[0]))].sort(),
    lengthM: outputs.reduce((s, o) => s + o.len, 0),
    signalWires: digital.length + analog.length,
  }
  return { outputs, digital, analog, can, power, harness }
}

const table = (head, rows) => rows.length
  ? `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  : '<p class="m">None in use.</p>'
const amps = (a) => (a == null ? '' : `${a} A`)

/** The whole printable page as an HTML string. */
export function setupSheetHtml(args) {
  const d = args.device
  const r = sheetRows(args)
  const b = boardOf(d)
  const outRows = r.outputs.map((o) => [o.tag, o.pin, o.name, o.driven || 'nothing', amps(o.limit), amps(o.inrush), amps(o.rating),
    o.gauge + (o.recommended ? ' (recommended)' : '') + (o.under ? ' (under recommended)' : ''), o.len ? `${o.len} m` : '',
    o.drop ? `${o.drop.volts.toFixed(2)} V (${o.drop.pct.toFixed(1)} %)` : '', o.color])
  const h = r.harness
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(d.name)} setup sheet</title>`
    + '<style>body{font-family:sans-serif;font-size:12px}h1{font-size:20px}h2{font-size:15px;margin-top:18px}table{border-collapse:collapse;width:100%}th,td{border:1px solid;padding:3px 6px;text-align:left}.m{color:#555}</style></head><body>'
    + `<h1>${esc(d.name)} setup sheet</h1><p>${esc(d.type)}${b ? ' · ' + esc(b.name) : ''} · base ${hexId(d.baseId)} · firmware ${esc(d.version ?? '')} · ${esc(new Date().toLocaleDateString())}</p>`
    + `<h2>Power and CAN</h2>${table(['Pin', 'Function'], r.power.map((p) => [p.pin, p.what]))}`
    + `<h2>Outputs</h2>${table(['Out', 'Pin', 'Load', 'Driven by', 'Limit (fuse)', 'Inrush', 'Channel rating', 'Wire', 'Length', 'Drop at limit', 'Colour'], outRows)}`
    + `<h2>Digital inputs</h2>${table(['In', 'Pin', 'Name', 'Type'], r.digital.map((i) => [i.tag, i.pin, i.name, i.how]))}`
    + (r.analog.length || isCb(d) ? `<h2>Analog inputs</h2>${table(['In', 'Pin', 'Name'], r.analog.map((i) => [i.tag, i.pin, i.name]))}` : '')
    + `<h2>CAN inputs</h2>${table(['#', 'Name', 'Frame', 'Bits', 'Scale', 'Sent by'], r.can.map((c) => [c.n, c.name, c.id + (c.ide ? ' ext' : ''), c.bits, c.scale, c.source || 'not in the project']))}`
    + `<h2>Harness summary</h2><p>Connectors: ${esc(h.connectors.join(', ') || 'none')}. Output wires: ${h.gauges.map((g) => `${g.count} × ${g.mm2} mm² (${g.awg} AWG)`).join(', ') || 'none'}. `
    + `Signal wires (inputs): ${h.signalWires}. Output runs entered: ${h.lengthM.toFixed(1)} m one way.</p>`
    + '<p class="m">Wire gauge sized to the current limit; drop is copper at 13.8 V, feed and return, no connector resistance. Estimate only.</p>'
    + '\x3cscript>window.onload=function(){window.print()}\x3c/script></body></html>'
}

/** Open `html` in a new tab that prints itself. false when the browser blocked the pop-up. */
export function printHtml(html) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const w = window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60000)
  return !!w
}
