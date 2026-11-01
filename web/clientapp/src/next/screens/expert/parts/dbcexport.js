// Builds one combined .dbc text from frames: [{ node, id, ide, msg, dlc?, sig: { name, startBit, length, byteOrder, isSigned, isFloat, factor, offset, unit, min?, max? } | null }]
// A frame with sig null only declares its message (a CAN message block of fixed bytes); dlc defaults to 8.
const clean = (s) => String(s ?? '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'X'
// DBC names are at most 32 characters (Vector tools and some dashboards refuse longer): squeeze the underscores a label
// turns into, then keep the start and the end ("..._Millivolts" vs "..._Pos" stay apart). The full text goes in a comment.
const MAX_NAME = 32
const fit = (n) => {
  if (n.length <= MAX_NAME) return n
  const s = n.replace(/_+/g, '_').replace(/^_(?!\d)|_$/g, '')
  return s.length <= MAX_NAME ? s : s.slice(0, 20).replace(/_$/, '') + '_' + s.slice(-(MAX_NAME - 21)).replace(/^_/, '')
}
// a unique name within `taken`, suffix inside the 32
const unique = (base, taken) => {
  let n = fit(base), i = 2
  while (taken.has(n)) { const suf = '_' + i++; n = fit(base).slice(0, MAX_NAME - suf.length) + suf }
  taken.add(n)
  return n
}
// plain ASCII inside quotes: many tools read a .dbc as Latin-1 ("·" in a label becomes "-", "°" becomes "deg")
const quote = (s) => String(s ?? '').replace(/°/g, 'deg').replace(/\\/g, '/').replace(/"/g, "'").replace(/[^\x20-\x7E]/g, '-')
const num = (v) => (Number.isFinite(+v) ? String(+(+v).toPrecision(12)) : '0')

// The firmware's CanOutputs::CalcDlc: the byte holding the signal's last bit, plus one.
const dlcOf = (startBit, length) => Math.min(8, Math.floor((startBit + length - 1) / 8) + 1)

/** A module's own TX frames from its functions (api.functions): enabled CAN outputs (one signal each, packed by
 *  id) and CAN message blocks (fixed bytes: the message, plus its counter and checksum when set). */
export function moduleTxFrames(node, funcs) {
  const out = []
  const msgName = (id) => `${node}_${id.toString(16).toUpperCase()}`
  for (const o of funcs?.canOutputs ?? []) {
    if (!o.enabled) continue
    const counterOrSum = (o.kind ?? 0) !== 0   // 1 rolling counter, 2-5 checksums: raw, unscaled
    out.push({ node, id: o.id, ide: !!o.ide, msg: msgName(o.id), dlc: dlcOf(o.startBit, o.bitLength),
      sig: { name: o.name, startBit: o.startBit, length: o.bitLength, byteOrder: o.byteOrder, isSigned: counterOrSum ? false : !!o.signed,
             isFloat: false, factor: counterOrSum ? 1 : o.factor, offset: counterOrSum ? 0 : o.offset, unit: '' } })
  }
  for (const m of funcs?.canMessages ?? []) {
    if (!m.enabled) continue
    const base = { node, id: m.id, ide: !!m.ide, msg: clean(m.name) === 'X' ? msgName(m.id) : m.name, dlc: m.dlc }
    out.push({ ...base, sig: null })
    if ((m.counterByte ?? 0xff) < m.dlc) out.push({ ...base, sig: { name: `${m.name} counter`, startBit: m.counterByte * 8, length: 4, byteOrder: 0, isSigned: false, factor: 1, offset: 0, unit: '' } })
    if ((m.checksum ?? 0) >= 2 && (m.checksumByte ?? 7) < m.dlc) out.push({ ...base, sig: { name: `${m.name} checksum`, startBit: m.checksumByte * 8, length: 8, byteOrder: 0, isSigned: false, factor: 1, offset: 0, unit: '' } })
  }
  return out
}

export function buildDbc(frames) {
  const nodes = [...new Set(frames.map((f) => clean(f.node)))]
  // One message per (id, ide, name); signal names must be unique within a message.
  const msgs = new Map()
  for (const f of frames) {
    const k = `${f.ide ? 'x' : 's'}:${f.id}:${clean(f.msg)}`
    if (!msgs.has(k)) msgs.set(k, { id: f.id, ide: f.ide, name: clean(f.msg), full: f.msg, node: clean(f.node), dlc: 0, sigs: [], taken: new Set() })
    const m = msgs.get(k)
    m.dlc = Math.max(m.dlc, f.dlc ?? 8)
    if (!f.sig) continue
    m.sigs.push({ n: unique(clean(f.sig.name), m.taken), s: f.sig })
  }
  const seenNames = new Set()
  let out = 'VERSION ""\n\nNS_ :\n\nBS_:\n\nBU_: ' + nodes.join(' ') + '\n\n'
  const floats = [], notes = []
  for (const m of [...msgs.values()].sort((a, b) => a.id - b.id)) {
    const name = unique(m.name, seenNames)
    const dbcId = m.ide ? (m.id | 0x80000000) >>> 0 : m.id
    out += `BO_ ${dbcId} ${name}: ${m.dlc} ${m.node}\n`
    if (name !== m.name) notes.push(`CM_ BO_ ${dbcId} "${quote(m.full)}";\n`)
    for (const { n, s } of m.sigs) {
      out += ` SG_ ${n} : ${s.startBit}|${s.length}@${s.byteOrder == 1 ? 0 : 1}${s.isSigned ? '-' : '+'} (${num(s.factor ?? 1)},${num(s.offset ?? 0)}) [${num(s.min ?? 0)}|${num(s.max ?? 0)}] "${quote(s.unit)}" Vector__XXX\n`
      if (s.isFloat) floats.push(`SIG_VALTYPE_ ${dbcId} ${n} : 1;\n`)
      if (n !== clean(s.name)) notes.push(`CM_ SG_ ${dbcId} ${n} "${quote(s.name)}";\n`)
    }
    out += '\n'
  }
  // comments (the full names) come before SIG_VALTYPE_ in the DBC section order
  return out + (notes.length ? notes.join('') + '\n' : '') + floats.join('')
}
