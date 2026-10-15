// Plain-language rendering of the same blocks the canvas shows. Each sentence is a list of segments:
// { t: 'text' } or a token { tok: 'src' | 'val' | 'self' | 'missing', label, node?, field? }.
// Tokens are buttons in the view; a click opens that block in the inspector.
import { OP_WORDS, isRelational, secs, hexId, TIMER_MODES } from './model.js'

const T = (t) => ({ t })
const val = (label, field) => ({ tok: 'val', label: String(label), field })

function srcTok(model, idx, field) {
  if (!idx) return { tok: 'missing', label: 'pick an input', field }
  const v = model.byIdx.get(idx)
  if (!v) return { tok: 'missing', label: '#' + idx, field }
  const id = v.kind === 'sys' ? 'sys' : v.kind === 'lua' ? 'lua' : `${v.kind}:${v.number}`
  const n = model.nodes.get(id)
  const p = n?.outs.find((x) => x.idx === idx)
  const label = !n ? v.name : n.kind === 'sys' || n.kind === 'lua' ? p?.label ?? v.name : (n.outs.length > 1 && p ? `${n.title} ${p.label.toLowerCase()}` : n.title)
  return { tok: 'src', label, node: id, field, idx }
}
const self = (n) => ({ tok: 'self', label: n.title, node: n.id })

/** Sentence for one block, or null for blocks that only provide signals. */
export function sentenceFor(model, n) {
  const r = n.row ?? {}
  if (!n.enabled && n.kind !== 'sys') return null
  switch (n.kind) {
    case 'virtualinput': {
      const part = (i) => { const s = srcTok(model, r['var' + i], 'var' + i); return r['not' + i] ? [T('NOT'), s] : [s] }
      const j = (c) => T(['AND', 'OR', 'NOR'][c ?? 0])
      const segs = [self(n), T('is on when'), ...part(0), j(r.cond0), ...part(1)]
      if (r.var2) segs.push(j(r.cond1), ...part(2))
      segs.push(T(r.mode === 1 ? '(each time this becomes true, it flips on or off).' : 'is true.'))
      return segs
    }
    case 'condition': {
      const segs = [self(n), T('is on when'), srcTok(model, r.input, 'input'), T(OP_WORDS[r.operator ?? 0] ?? '?'), val(r.arg ?? 0, 'arg')]
      if (isRelational(r.operator) && r.argOff != null && r.argOff !== r.arg) segs.push(T('(off again at'), val(r.argOff, 'argOff'), T(')'))
      segs.push(T('.'))
      return segs
    }
    case 'timer': {
      const s = srcTok(model, r.input, 'input')
      const on = r.edge === 1 ? 'turns off' : 'turns on', off = r.edge === 1 ? 'turns on' : 'turns off'
      if (r.mode === 1) return [self(n), T(`follows`), s, T(`and stays on for`), val(secs(r.preset), 'preset'), T(`after it ${off}.`)]
      if (r.mode === 2) return [self(n), T('gives one'), val(secs(r.preset), 'preset'), T('pulse each time'), s, T(on + '.')]
      return [self(n), T('turns on'), val(secs(r.preset), 'preset'), T(`after`), s, T(on + ', and off with it.')]
    }
    case 'flasher':
      return [T('While'), srcTok(model, r.input, 'input'), T('is on,'), self(n), T('blinks'), val((r.onTime ?? 0) + ' ms', 'onTime'), T('on,'), val((r.offTime ?? 0) + ' ms', 'offTime'), T(r.single ? 'off, once.' : 'off.')]
    case 'counter': {
      const segs = [self(n), T('counts up on'), srcTok(model, r.incInput, 'incInput')]
      if (r.decInput) segs.push(T(', down on'), srcTok(model, r.decInput, 'decInput'))
      if (r.resetInput) segs.push(T(', back to 0 on'), srcTok(model, r.resetInput, 'resetInput'))
      segs.push(T(', from'), val(r.minCount ?? 0, 'minCount'), T('to'), val(r.maxCount ?? 0, 'maxCount'), T(r.wrapAround ? 'and wraps round.' : '.'))
      return segs
    }
    case 'table': {
      const segs = [self(n), T('looks up'), srcTok(model, r.xInput, 'xInput')]
      if ((r.ySize ?? 1) > 1) segs.push(T('and'), srcTok(model, r.yInput, 'yInput'))
      segs.push(T('in a'), val(`${r.xSize}${(r.ySize ?? 1) > 1 ? ' × ' + r.ySize : ''} point`, 'xSize'), T('table, in between it interpolates.'))
      return segs
    }
    case 'canoutput':
      return [T('Send'), srcTok(model, r.input, 'input'), T('on CAN ID'), val(hexId(r.id) + (r.ide ? ' ext' : ''), 'id'), T('at bit'), val(r.startBit ?? 0, 'startBit'), T(', ×'), val(r.factor ?? 1, 'factor'), T(', every'), val((r.interval ?? 0) + ' ms', 'interval'), T('.')]
    case 'caninput':
      return [self(n), T('reads CAN ID'), val(hexId(r.id) + (r.ide ? ' ext' : ''), 'id'), T(', bits'), val(`${r.startBit}+${r.bitLength}`, 'startBit'), T(', and is on when the value'), T(OP_WORDS[r.operator ?? 0] ?? '?'), val(r.operand ?? 0, 'operand'), T(r.timeoutEnabled ? `(no frame for ${r.timeout} ms → off).` : '.')]
    case 'output': case 'digitaloutput': {
      const src = n.kind === 'output' ? r.inputVal : r.input
      const segs = [T('When'), srcTok(model, src, 'input'), T('is on → turn on'), self(n)]
      if (r.variableDutyCycle) segs.push(T('at a duty from'), srcTok(model, r.dutyCycleInput, 'dutyCycleInput'))
      else if (r.pwmEnabled) segs.push(T('at'), val((r.fixedDuty ?? r.fixedDutyCycle ?? 100) + ' %', 'pwm'))
      segs.push(T('.'))
      return segs
    }
    default: return null
  }
}

/** Card heading for the sentence view: family · kind. */
export function cardKind(n) {
  const k = { virtualinput: 'COMBINE', condition: 'COMPARE', timer: 'TIMER · ' + (TIMER_MODES[n.row?.mode ?? 0] ?? '').toUpperCase(), flasher: 'FLASHER', counter: 'COUNTER', table: 'TABLE', canoutput: 'CAN OUTPUT', caninput: 'CAN INPUT', output: 'OUTPUT', digitaloutput: 'OUTPUT' }[n.kind] ?? n.kindLabel.toUpperCase()
  return k
}
