// Pure logic for the CAN map: turns /api/can-id-map + /api/canlog + the module list into table rows.
// Rule of thumb from the backend: a PDM sends on base+2..base+29 and a CANBoard on base+2..base+11
// (bootloader at +12/+13), so a module "owns" base..base+29 (PDM) or base..base+13 (CANBoard).
export const OBD = [
  { lo: 0x7df, hi: 0x7df, frame: 'OBD-II functional request' },
  { lo: 0x7e0, hi: 0x7e7, frame: 'OBD-II requests' },
  { lo: 0x7e8, hi: 0x7ef, frame: 'OBD-II responses' },
]
export const hx = (n, ide) => (ide ? '0x' + n.toString(16).toUpperCase().padStart(8, '0') : '0x' + n.toString(16).toUpperCase().padStart(3, '0'))
const inObd = (id, ide) => !ide && id >= 0x7df && id <= 0x7ef
export const RESERVED_WHY = 'The OBD-II standard keeps this range for diagnostic tools. Do not put a module or an ECU frame here.'

export function blocksOf(devices) {
  return devices
    .filter((d) => d.type && !/dbc|keypad/i.test(d.type) && d.baseId)
    // as the backend's overlap check: a 5.7 module's block reaches its last frame sent (txSpan, e.g. a PDM's status slot at +36)
    .map((d) => ({ name: d.name, guid: d.guid, lo: d.baseId, hi: d.baseId + Math.max(d.txSpan ?? 0, /canboard/i.test(d.type) ? 13 : 29) }))
}

/** rates: { [key]: { hz, last } } with key = (ide ? 'x' : '') + id. */
export function buildRows({ map, log = [], devices = [], rates = {} }) {
  const ent = new Map()
  const get = (id, ide) => {
    const k = (ide ? 'x' : '') + id
    if (!ent.has(k)) ent.set(k, { key: k, id, ide, owners: [], seen: false })
    return ent.get(k)
  }
  for (const [k, owners] of Object.entries(map?.claimed ?? {})) {
    const ide = k.startsWith('x')
    const e = get(parseInt(ide ? k.slice(1) : k, 16), ide)
    e.owners = [...owners]
  }
  for (const m of log) get(m.id, !!m.ide).seen = true

  const blocks = blocksOf(devices)
  const clashKeys = new Set((map?.collisions ?? []).map((c) => (c.ide ? 'x' : '') + c.id))
  const sharedKeys = new Set((map?.shared ?? []).map((c) => (c.ide ? 'x' : '') + c.id))
  // Overlapping module blocks: the ids inside both ranges are in clash.
  const overlapNames = new Map() // id -> names
  for (const o of map?.overlaps ?? []) {
    const a = blocks.find((b) => b.name === o.a), b = blocks.find((x) => x.name === o.b)
    if (!a || !b) continue
    for (let id = Math.max(a.lo, b.lo); id <= Math.min(a.hi, b.hi); id++) overlapNames.set(id, [o.a, o.b])
  }
  for (const [id, names] of overlapNames) { const e = get(id, false); for (const n of names) { const w = n + ': module block'; if (!e.owners.includes(w)) e.owners.push(w) } }

  const rows = []
  for (const e of ent.values()) {
    if (!e.owners.length && !e.ide) {
      const b = blocks.find((x) => e.id >= x.lo && e.id <= x.hi)
      if (b) e.owners = [b.name + ': module block']
    }
    const joined = e.owners.join(' ')
    const kind = /ECU /.test(joined) ? 'ecu' : e.owners.length ? 'mod' : 'unknown'
    let status = 'ok', why = ''
    if (!e.owners.length) { status = 'unknown'; why = 'This frame is on the bus but nothing in the project sends or owns it.' }
    if (sharedKeys.has(e.key)) { status = 'shared'; why = 'Several modules send this id from Lua on purpose (for example a main module and its backup).' }
    if (overlapNames.has(e.id) && !e.ide) { status = 'clash'; why = `The address blocks of ${overlapNames.get(e.id).join(' and ')} overlap here. Their commands and replies would mix. Change the base ID of one of them.` }
    if (clashKeys.has(e.key)) { status = 'clash'; why = `More than one device sends this id: ${e.owners.join(' and ')}. Change one of them.` }
    // the car's own ECU (a DBC) answering diagnostics in the OBD-II range is not a clash; anything else there is
    if (inObd(e.id, e.ide) && kind !== 'ecu' && (e.owners.length || e.seen)) { status = 'clash'; why = 'This id is in the range OBD-II keeps for diagnostic tools. ' + RESERVED_WHY }
    rows.push({ id: e.id, ide: e.ide, key: e.key, owners: e.owners, kind, status, why, seen: e.seen })
  }
  for (const r of OBD) {
    if (rows.some((x) => !x.ide && x.id >= r.lo && x.id <= r.hi)) continue
    for (let id = r.lo; id <= r.hi; id++) rows.push({ id, ide: false, key: String(id), owners: [r.frame], kind: 'res', status: 'res', why: RESERVED_WHY, seen: false })
  }
  rows.sort((a, b) => (a.ide === b.ide ? a.id - b.id : a.ide ? 1 : -1))

  // Merge neighbours with the same owners/kind/status into one row (28 broadcast frames become one line).
  const out = []
  for (const r of rows) {
    const p = out[out.length - 1]
    if (p && p.ide === r.ide && r.id === p.hi + 1 && p.kind === r.kind && p.status === r.status && p.owners.join('|') === r.owners.join('|')) {
      p.hi = r.id; p.members.push(r); continue
    }
    out.push({ ...r, lo: r.id, hi: r.id, members: [r] })
  }
  for (const r of out) {
    const hz = r.members.map((m) => rates[m.key]?.hz).filter((v) => v != null)
    r.hz = hz.length ? hz.reduce((a, b) => a + b, 0) / hz.length : null
    const lasts = r.members.map((m) => rates[m.key]?.last).filter((v) => v != null)
    r.last = lasts.length ? Math.max(...lasts) : null
    r.count = r.hi - r.lo + 1
    r.rid = r.key + '-' + r.hi
  }
  return out
}

export const STATUS = {
  clash: { mark: '■', word: 'Clash', tone: 'fault' },
  res: { mark: '◌', word: 'Reserved', tone: 'warn' },
  unknown: { mark: '△', word: 'Not in the project', tone: 'warn' },
  shared: { mark: '◆', word: 'Shared on purpose', tone: 'accent' },
  ok: { mark: '●', word: 'In use', tone: 'muted' },
}
