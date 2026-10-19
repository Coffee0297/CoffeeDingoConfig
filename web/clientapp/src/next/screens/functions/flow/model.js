// Block model of one module for the flow builder. Pure: no API calls, no Svelte.
//
// One node = one firmware function slot (or one physical channel). Every input field of a block holds a
// var-map index (GET /devices/{id}/inputs). A source port is one var-map entry, so its port id is
// `v<index>` and a wire is simply "target field = that index". The var map's own type (bool | int | float)
// decides the port: round = on/off, square = number.

import { olderThan, isUpstream } from '../../hardware/parts/util.js'

export const isCb = (dev) => /can.?board/i.test(dev?.type ?? '')

// Block families (colours come from tokens.css --color-block-*).
export const FAM_COLOR = {
  dev: 'var(--color-text-muted)', in: 'var(--color-block-input)', logic: 'var(--color-block-logic)',
  time: 'var(--color-block-time)', out: 'var(--color-block-output)', code: 'var(--color-block-code)', fn: 'var(--color-accent)', link: 'var(--color-text-muted)',
}
export const FAM_NAME = { dev: 'MODULE', in: 'INPUT', logic: 'LOGIC', time: 'TIME & STATE', out: 'OUTPUT', code: 'CUSTOM CODE', fn: 'FUNCTION', link: 'LINK' }

// Target fields per kind: [field, label, accepts]. accepts: bool = on/off only, num = number (on/off reads 0/1).
const OUT_INS = [['input', 'Input', 'bool'], ['dutyCycleInput', 'Duty from', 'num'], ['freqInput', 'Frequency from', 'num']]
export const KINDS = {
  sys: { label: 'Module', fam: 'dev', ins: [['forceSleepInput', 'Force sleep', 'bool'], ['muteTxInput', 'Mute CAN', 'bool']] },
  input: { label: 'Digital input', fam: 'in', physical: true },
  analoginput: { label: 'Analog input', fam: 'in', arr: 'analogIn', physical: true },
  caninput: { label: 'CAN input', fam: 'in', arr: 'canInputs', def: 'numCanInputs', addable: true },
  keypad: { label: 'Keypad', fam: 'in' },
  virtualinput: { label: 'Combine', fam: 'logic', arr: 'virtualInputs', def: 'numVirtualInputs', addable: true, ins: [['var0', 'In 1', 'bool'], ['var1', 'In 2', 'bool'], ['var2', 'In 3', 'bool']] },
  condition: { label: 'Compare', fam: 'logic', arr: 'conditions', def: 'numConditions', addable: true, ins: [['input', 'Input', 'num']] },
  counter: { label: 'Counter', fam: 'time', arr: 'counters', def: 'numCounters', addable: true, ins: [['incInput', 'Count up', 'bool'], ['decInput', 'Count down', 'bool'], ['resetInput', 'Reset', 'bool']] },
  flasher: { label: 'Flasher', fam: 'time', arr: 'flashers', def: 'numFlashers', addable: true, ins: [['input', 'While', 'bool']] },
  timer: { label: 'Timer', fam: 'time', arr: 'timers', def: 'numTimers', addable: true, ins: [['input', 'Input', 'bool']] },
  table: { label: 'Table', fam: 'time', arr: 'tables', def: 'numTables', addable: true, ins: [['xInput', 'X', 'num'], ['yInput', 'Y', 'num']] },
  wiper: { label: 'Wiper', fam: 'time' },
  lua: { label: 'Custom code', fam: 'code' },
  output: { label: 'Output', fam: 'out', ins: OUT_INS },
  digitaloutput: { label: 'Output', fam: 'out', arr: 'digitalOut', ins: OUT_INS },
  canoutput: { label: 'CAN output', fam: 'out', arr: 'canOutputs', def: 'numCanOutputs', addable: true, ins: [['input', 'Value', 'num']] },
  // firmware 5.6
  math: { label: 'Math', fam: 'logic', arr: 'maths', def: 'numMath', addable: true, fw: [5, 6, 0], ins: [['inputA', 'A', 'num'], ['inputB', 'B', 'num']] },
  canmsg: { label: 'CAN message', fam: 'out', arr: 'canMessages', def: 'numCanMessages', addable: true, fw: [5, 6, 0], ins: [['input', 'While', 'bool']] },
  comfortblink: { label: 'Comfort blink', fam: 'time', arr: 'comfortBlinks', addable: true, fw: [5, 6, 1], ins: [['leftInput', 'Lever left', 'bool'], ['rightInput', 'Lever right', 'bool'], ['clockInput', 'Indicator clock', 'bool']] },
  ignition: { label: 'Ignition', fam: 'fn', ins: [['ignitionInput', 'Ignition switch', 'bool'], ['startInput', 'Start button', 'bool'], ['crankAllowInput', 'Crank allowed', 'bool'], ['runningInput', 'Engine running', 'bool']] },
}
export const arrOf = (kind, dev) => (kind === 'input' ? (isCb(dev) ? 'digitalIn' : 'inputs') : KINDS[kind]?.arr)

export const OPS = ['=', '≠', '>', '<', '≥', '≤', '&', '!&']
export const OP_WORDS = ['equals', 'is not', 'is above', 'is below', 'is at least', 'is at most', 'has bits', 'has not bits']
export const JOIN = ['AND', 'OR', 'NOR']
// mode 3 (one pulse, edges ignored while it runs) and the reset input exist on upstream dingoFW only
export const TIMER_MODES = ['On-delay', 'Off-delay', 'Pulse', 'One pulse']
export const EDGES = ['Rising', 'Falling', 'Both']
export const isRelational = (op) => [2, 3, 4, 5].includes(Number(op))
// Math block operations (firmware MathOp order); `fn` shows it with A and B
export const MATH_OPS = [
  { label: 'A + B', fn: (a, b) => `${a} + ${b}` }, { label: 'A − B', fn: (a, b) => `${a} − ${b}` },
  { label: 'A × B', fn: (a, b) => `${a} × ${b}` }, { label: 'A ÷ B', fn: (a, b) => `${a} ÷ ${b}` },
  { label: 'Smaller of A, B', fn: (a, b) => `the smaller of ${a} and ${b}` }, { label: 'Larger of A, B', fn: (a, b) => `the larger of ${a} and ${b}` },
  { label: 'Average of A, B', fn: (a, b) => `the average of ${a} and ${b}` },
]
export const CANMSG_MODES = ['Repeat while on', 'Once each time it turns on']

// Port labels from the var map's property names.
const PROP_LABEL = { 'Rotary Position': 'Position', Millivolts: 'Voltage (mV)', 'Switch Value': 'Switch', 'Scaled Value': 'Scaled', 'PWM Duty': 'PWM duty %', 'PWM Frequency': 'PWM Hz', Current: 'Current (A)', 'Raw ADC': 'Raw ADC' }
function portLabel(v) {
  if (v.kind === 'sys') return v.name
  if (v.kind === 'lua') return v.name
  if (v.kind === 'keypad') return v.name.replace(/^.*? - /, '')
  if (v.kind === 'wiper') return v.prop.replace(/ Output$/, '')
  if (v.kind === 'condition' && v.prop === 'Value') return 'Result'
  if (v.kind === 'counter' && v.prop === 'Value') return 'Count'
  return PROP_LABEL[v.prop] ?? v.prop
}
export const portType = (v) => (v?.type === 'bool' ? 'bool' : 'num')
/** Can a source of type `src` drive a target that accepts `acc`? A number into on/off needs a Compare. */
export const canWire = (src, acc) => acc !== 'bool' || src === 'bool'

const ownerOf = (v) => (v.kind === 'sys' ? 'sys' : v.kind === 'lua' ? 'lua' : `${v.kind}:${v.number}`)
export const parseId = (id) => { const i = id.indexOf(':'); return i < 0 ? { kind: id, n: 0 } : { kind: id.slice(0, i), n: Number(id.slice(i + 1)) } }

const hexId = (n) => '0x' + Number(n ?? 0).toString(16).toUpperCase().padStart(3, '0')
const secs = (ms) => { const s = (+ms || 0) / 1000; return s >= 60 && s % 60 === 0 ? s / 60 + ' min' : (Math.round(s * 10) / 10) + ' s' }
export { hexId, secs }

/** The config row behind a node id (PDM outputs come from the live device record). */
export function rowOf(id, dev, funcs) {
  const { kind, n } = parseId(id)
  if (kind === 'sys') return funcs?.device ?? {}
  if (kind === 'output') return (dev?.outputs ?? []).find((o) => o.number === n) ?? null
  if (kind === 'wiper') return funcs?.wiper ?? null
  if (kind === 'keypad') return (funcs?.keypads ?? []).find((k) => k.number === n) ?? null
  if (kind === 'lua') return {}
  const arr = arrOf(kind, dev)
  return (funcs?.[arr] ?? []).find((x) => x.number === n) ?? null
}
/** Field value on a row; PDM output's trigger is `inputVal` in telemetry. */
export function fieldOf(kind, row, field) {
  if (!row) return 0
  if (kind === 'output' && field === 'input') return row.inputVal ?? 0
  return row[field] ?? 0
}

function subline(kind, n, row, dev) {
  switch (kind) {
    case 'sys': return (dev?.type ?? 'module') + ' · this module'
    case 'input': return `Digital in ${n}` + (row?.invert ? ' · inverted' : '') + (row?.mode === 1 ? ' · latching' : '')
    case 'analoginput': return `Analog in ${n}` + (row?.rotary?.enabled ? ` · ${row.rotary.numPos} positions` : row?.switch?.enabled ? ' · switch' : row?.scale?.enabled ? ' · sensor' : '')
    case 'caninput': return `CAN ${hexId(row?.id)}${row?.ide ? ' ext' : ''} · bit ${row?.startBit ?? 0}+${row?.bitLength ?? 0}`
    case 'virtualinput': {
      const a = JOIN[row?.cond0 ?? 0], b = JOIN[row?.cond1 ?? 0]
      if (!row?.var2 || a === b) return a === 'AND' ? 'Combine · All of (AND)' : a === 'OR' ? 'Combine · Any of (OR)' : 'Combine · NOR'
      return `Combine · ${a} then ${b}`
    }
    case 'condition': return `Compare ${OPS[row?.operator ?? 0]} ${row?.arg ?? 0}` + (isRelational(row?.operator) && row?.argOff !== row?.arg ? ` · off at ${row.argOff}` : '')
    case 'timer': return `${TIMER_MODES[row?.mode ?? 0]} · ${secs(row?.preset)}`
    case 'flasher': return `Flasher · ${row?.onTime ?? 0} / ${row?.offTime ?? 0} ms` + (row?.single ? ' · once' : '')
    case 'counter': return `Counter · ${row?.minCount ?? 0} to ${row?.maxCount ?? 0}` + (row?.wrapAround ? ' · wraps' : '')
    case 'table': return `Table · ${row?.xSize ?? 1}${(row?.ySize ?? 1) > 1 ? ' × ' + row.ySize : ''} points`
    case 'canoutput': return `CAN ${hexId(row?.id)}${row?.ide ? ' ext' : ''} · every ${row?.interval ?? 0} ms`
    case 'math': return `Math · ${MATH_OPS[row?.op ?? 0]?.fn('A', row?.inputB ? 'B' : (row?.constB ?? 0))}` + ((row?.factor ?? 1) !== 1 || (row?.offset ?? 0) !== 0 ? ` · ×${row?.factor ?? 1} ${(row?.offset ?? 0) < 0 ? '−' : '+'} ${Math.abs(row?.offset ?? 0)}` : '')
    case 'canmsg': return `CAN ${hexId(row?.id)}${row?.ide ? ' ext' : ''} · ` + (row?.mode === 1 ? 'once' : `every ${row?.intervalMs ?? 0} ms`)
    case 'comfortblink': return `Comfort blink · tap < ${secs(row?.tapMs ?? 1000)}: ${row?.blinks ?? 3} blinks`
    case 'ignition': return `Ignition · ${row?.role === 1 ? 'follows the main module' : ['switch + button', 'button only', 'key'][row?.mode ?? 0]}`
    case 'output': return `Output ${n} · ${row?.currentLimit ?? '?'} A` + (row?.enabled === false ? ' · switched off' : row?.pwmEnabled ? ' · PWM' : '')
    case 'digitaloutput': return `Digital out ${n}` + (row?.pwmEnabled ? ' · PWM' : '')
    case 'lua': return 'Lua outputs on this module'
    case 'keypad': return 'Keypad buttons'
    case 'wiper': return 'Firmware wiper block'
    default: return ''
  }
}

function titleOf(kind, n, row, dev) {
  if (kind === 'sys') return dev?.name ?? 'Module'
  if (kind === 'lua') return 'Custom code (Lua)'
  const nm = String(row?.name ?? '').trim()
  if (kind === 'output') return nm || `Output ${n}`
  return nm || `${KINDS[kind]?.label ?? kind} ${n}`
}

/** Which out ports a node shows (var-map entries it owns, filtered to what makes sense). */
function outPortsFor(kind, row, vars, consumed) {
  const keep = (v) => {
    switch (kind) {
      case 'input': return v.prop === 'State' || (row?.pwm && /PWM/.test(v.prop))
      case 'analoginput': return v.prop === 'Millivolts' || (v.prop === 'Rotary Position' && row?.rotary?.enabled) || (v.prop === 'Switch Value' && row?.switch?.enabled) || (v.prop === 'Scaled Value' && row?.scale?.enabled) || consumed.has(v.index)
      case 'output': return v.prop === 'On' || v.prop === 'Current' || consumed.has(v.index)
      case 'lua': case 'keypad': return consumed.has(v.index)
      default: return true
    }
  }
  return vars.filter(keep).map((v) => ({ id: 'v' + v.index, idx: v.index, label: portLabel(v), type: portType(v), prop: v.prop }))
}

/** Plain reasons a block can't run yet (empty = complete). */
export function incompleteReasons(kind, row, enabled) {
  if (!row || !enabled) return []
  const r = []
  switch (kind) {
    case 'virtualinput': if (!row.var0 || !row.var1) r.push('needs at least two inputs (In 1 and In 2)'); break
    case 'condition': if (!row.input) r.push('needs an input'); break
    case 'flasher': if (!row.input) r.push('needs an input'); if (!row.onTime || !row.offTime) r.push('on and off times must be above 0'); break
    case 'timer': if (!row.input) r.push('needs an input'); break
    case 'counter': if (!row.incInput && !row.decInput) r.push('needs a count up or count down input'); if ((row.maxCount ?? 0) <= (row.minCount ?? 0)) r.push('max must be above min'); break
    case 'table': {
      if (!row.xInput) r.push('needs an X input')
      const nx = Math.max(1, row.xSize | 0)
      for (let i = 1; i < nx; i++) if (!(+row.xAxis?.[i] > +row.xAxis?.[i - 1])) { r.push('X points must increase'); break }
      if ((row.ySize ?? 1) > 1 && !row.yInput) r.push('needs a Y input (2-D table)')
      break
    }
    case 'canoutput': if (!row.input) r.push('needs a value to send'); if (!row.id) r.push('needs a CAN ID'); break
    case 'caninput': if (!row.id) r.push('needs a CAN ID'); if (!row.bitLength) r.push('needs a bit length'); break
    case 'math': if (!row.inputA) r.push('needs an A input'); break
    case 'comfortblink': if (!row.leftInput || !row.rightInput) r.push('needs both lever inputs'); if (!row.clockInput) r.push('needs the indicator clock'); break
    case 'canmsg': if (!row.input) r.push('needs a signal to send on'); if (!row.id) r.push('needs a CAN ID'); break
    case 'output': if (!row.inputVal) r.push('has no input, so it never switches'); break
    case 'digitaloutput': if (!row.input) r.push('has no input, so it never switches'); break
  }
  return r
}

/**
 * Build the block graph of one module.
 * dev   = telemetry device record (outputs[], name, type, …)
 * funcs = GET /devices/{id}/functions
 * vmap  = GET /devices/{id}/inputs (every var-map entry)
 * Returns { nodes: Map<id, node>, edges: [], byIdx: Map<idx, var>, consumers: Map<idx, [{node, field}]> }.
 */
export function buildModel(dev, funcs, vmap) {
  const byIdx = new Map((vmap ?? []).map((v) => [v.index, v]))
  const varsOf = new Map()
  for (const v of vmap ?? []) { if (v.index <= 0) continue; const k = ownerOf(v); if (!varsOf.has(k)) varsOf.set(k, []); varsOf.get(k).push(v) }

  // candidate nodes: [id, kind, n, row, enabled]
  const cand = new Map()
  const add = (kind, n, row, enabled) => { const id = kind === 'sys' || kind === 'lua' ? kind : `${kind}:${n}`; cand.set(id, { id, kind, n, row, enabled }) }
  add('sys', 0, funcs?.device ?? {}, true)
  const physIn = isCb(dev) ? funcs?.digitalIn : funcs?.inputs
  for (const r of physIn ?? []) add('input', r.number, r, !!r.enabled)
  for (const r of funcs?.analogIn ?? []) add('analoginput', r.number, r, !!r.enabled)
  for (const k of ['caninput', 'virtualinput', 'condition', 'counter', 'flasher', 'timer', 'table', 'canoutput', 'digitaloutput', 'math', 'canmsg', 'comfortblink']) {
    for (const r of funcs?.[KINDS[k].arr] ?? []) add(k, r.number, r, !!r.enabled)
  }
  if (funcs?.ignition) add('ignition', 1, funcs.ignition, !!funcs.ignition.enabled)
  for (const o of isCb(dev) ? [] : dev?.outputs ?? []) add('output', o.number, o, !!o.enabled)
  for (const kp of funcs?.keypads ?? []) add('keypad', kp.number, kp, !!kp.enabled)
  if (funcs?.wiper) add('wiper', 1, funcs.wiper, !!funcs.wiper.enabled)
  add('lua', 0, {}, false)

  // target fields of every candidate (enabled blocks only — a disabled block's fields don't run)
  const targetsOf = (c) => {
    if (c.kind === 'sys') return KINDS.sys.ins
    if (!c.enabled && c.kind !== 'output') return []   // a switched-off PDM output still shows (and keeps) its input
    let ins = KINDS[c.kind]?.ins ?? []
    if (c.kind === 'table' && (c.row?.ySize ?? 1) <= 1) ins = ins.filter(([f]) => f !== 'yInput')
    if (c.kind === 'timer' && isUpstream(dev)) ins = [...ins, ['resetInput', 'Reset', 'bool']]
    if (c.kind === 'ignition' && c.row?.role === 1) ins = []   // a follower copies the main module's state
    if (c.kind === 'output' || c.kind === 'digitaloutput') ins = ins.filter(([f]) => f === 'input' || (f === 'dutyCycleInput' && c.row?.variableDutyCycle) || (f === 'freqInput' && c.row?.variableFreq))
    return ins
  }
  const edges = []
  const consumed = new Set()
  const consumers = new Map()
  for (const c of cand.values()) {
    for (const [field] of targetsOf(c)) {
      const idx = Number(fieldOf(c.kind, c.row, field)) || 0
      if (idx <= 0) continue
      const v = byIdx.get(idx)
      if (!v) continue
      consumed.add(idx)
      const src = ownerOf(v)
      edges.push({ id: `${c.id}|${field}`, source: src, sourceHandle: 'v' + idx, target: c.id, targetHandle: field, idx, type: portType(v) })
      if (!consumers.has(idx)) consumers.set(idx, [])
      consumers.get(idx).push({ node: c.id, field })
    }
  }
  const usedSrc = new Set(edges.map((e) => e.source))

  const nodes = new Map()
  for (const c of cand.values()) {
    const shown = c.kind === 'sys' || c.kind === 'output' || c.enabled || usedSrc.has(c.id) || edges.some((e) => e.target === c.id)
    if (!shown) continue
    if (c.kind === 'lua' && !usedSrc.has('lua')) continue
    const meta = KINDS[c.kind] ?? { label: c.kind, fam: 'dev' }
    const ins = targetsOf(c).map(([field, label, accepts], i) => ({
      id: field, label, accepts, src: Number(fieldOf(c.kind, c.row, field)) || 0,
      not: c.kind === 'virtualinput' ? !!c.row?.['not' + i] : false,
      optional: (c.kind === 'virtualinput' && field === 'var2') || (c.kind === 'timer' && field === 'resetInput') || (c.kind === 'counter' && field !== 'incInput') || c.kind === 'sys' || (c.kind === 'math' && field === 'inputB') || c.kind === 'ignition',
    }))
    const outs = outPortsFor(c.kind, c.row, varsOf.get(c.id) ?? [], consumed)
    const physical = c.kind === 'input' || c.kind === 'analoginput' || c.kind === 'output' || c.kind === 'digitaloutput' || c.kind === 'sys' || c.kind === 'lua' || c.kind === 'keypad'
    nodes.set(c.id, {
      id: c.id, kind: c.kind, n: c.n, fam: meta.fam, kindLabel: meta.label,
      title: titleOf(c.kind, c.n, c.row, dev), sub: subline(c.kind, c.n, c.row, dev),
      ins, outs, row: c.row, enabled: c.enabled || c.kind === 'sys',
      disabledSource: !c.enabled && c.kind !== 'sys' && c.kind !== 'lua' && usedSrc.has(c.id),
      incomplete: incompleteReasons(c.kind, c.row, c.enabled),
      deletable: !!meta.addable, physical,
    })
  }
  for (const n of nodes.values()) if (n.disabledSource) n.incomplete = ['is switched off, so the blocks that use it read 0']
  return { nodes, edges: edges.filter((e) => nodes.has(e.source) && nodes.has(e.target)), byIdx, consumers }
}

/** Source options for a target that accepts `accepts`, from the var map (configured functions only). */
export function sourceOptions(model, accepts, selfId) {
  const out = [{ value: '0', label: '— not connected' }]
  for (const n of model.nodes.values()) {
    if (n.id === selfId) continue
    for (const p of n.outs) {
      if (!canWire(p.type, accepts)) continue
      const lbl = n.kind === 'sys' || n.kind === 'lua' ? p.label : `${n.title} · ${p.label}`
      out.push({ value: String(p.idx), label: lbl, node: n.id, type: p.type })
    }
  }
  // Lua outs: the canvas shows only the ones something reads, but every out of the program must be pickable
  for (const v of model.byIdx.values())
    if (v.kind === 'lua' && selfId !== 'lua' && canWire('bool', accepts) && !out.some((o) => o.value === String(v.index))) out.push({ value: String(v.index), label: v.name, node: 'lua', type: 'bool' })
  return out
}

/** Every [targetNodeId, field] that reads one of this node's outputs. */
export function consumersOfNode(model, id) {
  const n = model.nodes.get(id)
  if (!n) return []
  const hits = []
  for (const p of n.outs) for (const c of model.consumers.get(p.idx) ?? []) hits.push([c.node, c.field])
  return hits
}

// ---- layout ("Tidy"): columns by depth from the sources, outputs last ----
export const NODE_W = 232
export const nodeHeight = (n) => 54 + (n.outs.length + n.ins.length) * 30 + 8 + (n.incomplete?.length ? 24 : 0)

export function autoLayout(nodes, edges) {
  const list = [...nodes]
  const inE = new Map(list.map((n) => [n.id, []]))
  for (const e of edges) inE.get(e.target)?.push(e.source)
  const depth = new Map()
  const visiting = new Set()
  const d = (id) => {
    if (depth.has(id)) return depth.get(id)
    if (visiting.has(id)) return 0
    visiting.add(id)
    const srcs = inE.get(id) ?? []
    const v = srcs.length ? 1 + Math.max(...srcs.map(d)) : 0
    visiting.delete(id)
    depth.set(id, v)
    return v
  }
  list.forEach((n) => d(n.id))
  const isOut = (n) => n.fam === 'out'
  const isLink = (n) => n.fam === 'link'
  const maxD = Math.max(1, ...list.filter((n) => !isOut(n) && !isLink(n)).map((n) => depth.get(n.id) + 1))
  for (const n of list) { if (isOut(n)) depth.set(n.id, maxD); if (isLink(n)) depth.set(n.id, maxD + 1) }
  const cols = new Map()
  for (const n of list) { const c = depth.get(n.id); if (!cols.has(c)) cols.set(c, []); cols.get(c).push(n) }
  const pos = {}
  const order = new Map()
  const MAXH = 1100   // a column taller than this wraps into a second one, so the canvas stays readable
  let x = 20
  for (const c of [...cols.keys()].sort((a, b) => a - b)) {
    const col = cols.get(c)
    // barycentre of the sources' rows keeps wires short
    const bary = (n) => { const s = (inE.get(n.id) ?? []).map((x) => order.get(x)).filter((x) => x != null); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : order.size }
    col.sort((a, b) => bary(a) - bary(b) || a.id.localeCompare(b.id))
    let y = 20
    col.forEach((n, i) => {
      const h = n.h ?? nodeHeight(n)
      if (y > 20 && y + h > MAXH) { x += NODE_W + 40; y = 20 }
      order.set(n.id, i); pos[n.id] = { x, y }; y += h + 24
    })
    x += NODE_W + 80
  }
  return pos
}

/** Block counts used vs the module's limits (/api/definitions). */
export function slotUsage(dev, funcs, defs) {
  const cb = isCb(dev)
  const def = cb ? defs?.canboards?.[0] : (defs?.pdms ?? []).find((p) => p.typeName === dev?.type) ?? defs?.pdms?.[0]
  const rows = [
    ['Compare', 'conditions', 'numConditions'], ['Combine', 'virtualInputs', 'numVirtualInputs'], ['Timers', 'timers', 'numTimers'],
    ['Flashers', 'flashers', 'numFlashers'], ['Counters', 'counters', 'numCounters'], ['Tables', 'tables', 'numTables'],
    ['CAN inputs', 'canInputs', 'numCanInputs'], ['CAN outputs', 'canOutputs', 'numCanOutputs'],
    ...(olderThan(dev?.version, [5, 6, 0]) ? [] : [['Math', 'maths', 'numMath'], ['CAN messages', 'canMessages', 'numCanMessages']]),
  ]
  return rows.filter(([, arr]) => Array.isArray(funcs?.[arr])).map(([label, arr, key]) => {
    const list = funcs[arr]
    return { label, arr, used: list.filter((x) => x.enabled).length, max: def?.[key] ?? list.length }
  })
}
