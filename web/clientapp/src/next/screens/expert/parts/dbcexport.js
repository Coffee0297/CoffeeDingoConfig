// Builds one combined .dbc text from frames: [{ node, id, ide, msg, sig: { name, startBit, length, byteOrder, isSigned, isFloat, factor, offset, unit, min?, max? } }]
const clean = (s) => String(s ?? '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'X'
const num = (v) => (Number.isFinite(+v) ? String(+(+v).toPrecision(12)) : '0')

export function buildDbc(frames) {
  const nodes = [...new Set(frames.map((f) => clean(f.node)))]
  // One message per (id, ide, name); signal names must be unique within a message.
  const msgs = new Map()
  for (const f of frames) {
    const k = `${f.ide ? 'x' : 's'}:${f.id}:${clean(f.msg)}`
    if (!msgs.has(k)) msgs.set(k, { id: f.id, ide: f.ide, name: clean(f.msg), node: clean(f.node), sigs: [] })
    const m = msgs.get(k)
    let n = clean(f.sig.name), i = 2
    while (m.sigs.some((s) => s.n === n)) n = clean(f.sig.name) + '_' + i++
    m.sigs.push({ n, s: f.sig })
  }
  const seenNames = new Set()
  let out = 'VERSION ""\n\nNS_ :\n\nBS_:\n\nBU_: ' + nodes.join(' ') + '\n\n'
  const floats = []
  for (const m of [...msgs.values()].sort((a, b) => a.id - b.id)) {
    let name = m.name, i = 2
    while (seenNames.has(name)) name = m.name + '_' + i++
    seenNames.add(name)
    const dbcId = m.ide ? (m.id | 0x80000000) >>> 0 : m.id
    out += `BO_ ${dbcId} ${name}: 8 ${m.node}\n`
    for (const { n, s } of m.sigs) {
      out += ` SG_ ${n} : ${s.startBit}|${s.length}@${s.byteOrder == 1 ? 0 : 1}${s.isSigned ? '-' : '+'} (${num(s.factor ?? 1)},${num(s.offset ?? 0)}) [${num(s.min ?? 0)}|${num(s.max ?? 0)}] "${String(s.unit ?? '').replace(/"/g, "'")}" Vector__XXX\n`
      if (s.isFloat) floats.push(`SIG_VALTYPE_ ${dbcId} ${n} : 1;\n`)
    }
    out += '\n'
  }
  return out + floats.join('')
}
