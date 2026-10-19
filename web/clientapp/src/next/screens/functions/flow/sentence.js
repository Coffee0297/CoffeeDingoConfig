// Plain-language rendering of the same blocks the canvas shows. Each sentence is a list of segments:
// { t: 'text' } or a token { tok: 'src' | 'val' | 'self' | 'missing', label, node?, field? }.
// Tokens are buttons in the view; a click opens that block in the inspector.
import { msgChecksumWords } from './canmsgcheck.js'
import { OP_WORDS, isRelational, secs, hexId, TIMER_MODES } from './model.js'
import { COUT_KINDS } from './canoutkind.js'

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
      if (r.delayOn > 0) segs.push(T('for at least'), val(secs(r.delayOn), 'delayOn'))
      segs.push(T('.'))
      if (r.delayOff > 0) segs.push(T('It stays on'), val(secs(r.delayOff), 'delayOff'), T('after that stops being true.'))
      return segs
    }
    case 'timer': {
      const s = srcTok(model, r.input, 'input')
      const on = r.edge === 1 ? 'turns off' : 'turns on', off = r.edge === 1 ? 'turns on' : 'turns off'
      if (r.mode === 1) return [self(n), T(`follows`), s, T(`and stays on for`), val(secs(r.preset), 'preset'), T(`after it ${off}.`)]
      const reset = r.resetInput ? [T(', and stops when'), srcTok(model, r.resetInput, 'resetInput'), T('turns on.')] : [T('.')]
      if (r.mode === 3) return [self(n), T('gives one'), val(secs(r.preset), 'preset'), T('pulse when'), s, T(on + ', ignoring it until the pulse ends'), ...reset]
      if (r.mode === 2) return [self(n), T('gives one'), val(secs(r.preset), 'preset'), T('pulse each time'), s, T(on), ...reset]
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
    case 'curve': {
      const k = Math.min(12, Math.max(2, r.points | 0)), pts = Array.from({ length: k }, (_, i) => `${+r.x?.[i] || 0} → ${+r.y?.[i] || 0}`).join(', ')
      return [self(n), T('follows'), srcTok(model, r.input, 'input'), T('along the curve'), val(pts, 'points'), T(', in a straight line between points and held beyond the ends.')]
    }
    case 'latchgate': {
      if (r.type === 1) return [self(n), T('follows'), srcTok(model, r.input, 'input'), T('while'), srcTok(model, r.controlInput, 'controlInput'), T('is on, and holds its last value while it is off.')]
      const segs = [self(n), T('turns on when'), srcTok(model, r.input, 'input'), T('turns on')]
      if (r.controlInput) segs.push(T(', off when'), srcTok(model, r.controlInput, 'controlInput'), T('turns on (reset wins)'))
      if (r.timeMs > 0) segs.push(T(r.controlInput ? ', or' : ', and off'), val(secs(r.timeMs), 'timeMs'), T('after it was set'))
      segs.push(T('.'))
      return segs
    }
    case 'canoutput':
      if (r.kind === 1) return [T('Send a rolling counter on CAN ID'), val(hexId(r.id) + (r.ide ? ' ext' : ''), 'id'), T('at bit'), val(`${r.startBit ?? 0}+${r.bitLength ?? 0}`, 'startBit'), T(', one up each frame, every'), val((r.interval ?? 0) + ' ms', 'interval'), T('.')]
      if (r.kind >= 2) return [T('Send a'), val(COUT_KINDS[r.kind] ?? '?', 'kind'), T('of the frame on CAN ID'), val(hexId(r.id) + (r.ide ? ' ext' : ''), 'id'), T('in byte'), val(Math.floor((r.startBit ?? 0) / 8), 'startBit'), T(', every'), val((r.interval ?? 0) + ' ms', 'interval'), T('.')]
      return [T('Send'), srcTok(model, r.input, 'input'), T('on CAN ID'), val(hexId(r.id) + (r.ide ? ' ext' : ''), 'id'), T('at bit'), val(r.startBit ?? 0, 'startBit'), T(', ×'), val(r.factor ?? 1, 'factor'), ...(r.triggerInput ? [T(', once each time'), srcTok(model, r.triggerInput, 'triggerInput'), T('turns on.')] : [T(', every'), val((r.interval ?? 0) + ' ms', 'interval'), T('.')])]
    case 'caninput':
      return [self(n), T('reads CAN ID'), val(hexId(r.id) + (r.ide ? ' ext' : ''), 'id'), T(', bits'), val(`${r.startBit}+${r.bitLength}`, 'startBit'), T(', and is on when the value'), T(OP_WORDS[r.operator ?? 0] ?? '?'), val(r.operand ?? 0, 'operand'), T(r.timeoutEnabled ? `(no frame for ${r.timeout} ms → reads ${model.upstream && !r.timeoutUseValue ? '0, off' : r.timeoutValue ?? 0}).` : '.')]
    case 'comfortblink':
      return [T('A tap of'), srcTok(model, r.leftInput, 'leftInput'), T('or'), srcTok(model, r.rightInput, 'rightInput'), T('shorter than'), val(secs(r.tapMs ?? 1000), 'tapMs'),
        T('blinks'), val(r.blinks ?? 3, 'blinks'), T('times on'), srcTok(model, r.clockInput, 'clockInput'), T('; held longer it blinks until released, and a tap the other way cancels it.')]
    case 'math': {
      const a = srcTok(model, r.inputA, 'inputA'), b = r.inputB ? srcTok(model, r.inputB, 'inputB') : val(r.constB ?? 0, 'constB')
      const op = r.op ?? 0
      const segs = [self(n), T('is')]
      if (op <= 3) segs.push(a, T(['+', '−', '×', '÷'][op]), b)
      else segs.push(T(['the smaller of', 'the larger of', 'the average of'][op - 4]), a, T('and'), b)
      if ((r.factor ?? 1) !== 1) segs.push(T(', ×'), val(r.factor, 'factor'))
      if ((r.offset ?? 0) !== 0) segs.push(T(', +'), val(r.offset, 'offset'))
      segs.push(T('.'))
      return segs
    }
    case 'canmsg': {
      const bytes = (r.data ?? []).slice(0, r.dlc ?? 8).map((x) => Number(x).toString(16).toUpperCase().padStart(2, '0')).join(' ')
      const id = val(hexId(r.id) + (r.ide ? ' ext' : ''), 'id')
      const cs = msgChecksumWords(r), tail = cs ? [T(','), val(cs, 'checksum')] : []
      return r.mode === 1
        ? [T('Each time'), srcTok(model, r.input, 'input'), T('turns on, send'), val(bytes || '(no data)', 'data'), T('on CAN ID'), id, T('once'), ...tail, T('.')]
        : [T('While'), srcTok(model, r.input, 'input'), T('is on, send'), val(bytes || '(no data)', 'data'), T('on CAN ID'), id, T('every'), val((r.intervalMs ?? 0) + ' ms', 'intervalMs'), ...tail, T('.')]
    }
    case 'output': case 'digitaloutput': {
      const src = n.kind === 'output' ? r.inputVal : r.input
      const segs = [T('When'), srcTok(model, src, 'input'), T('is on → turn on'), self(n)]
      if (r.variableDutyCycle) segs.push(T('at a duty from'), srcTok(model, r.dutyCycleInput, 'dutyCycleInput'))
      else if (r.pwmEnabled) segs.push(T('at'), val((r.fixedDuty ?? r.fixedDutyCycle ?? 100) + ' %', 'pwm'))
      // Hz = signal ÷ denominator (the firmware clamps it to its PWM range)
      if (r.pwmEnabled && r.variableFreq) segs.push(T('with a frequency of'), srcTok(model, r.freqInput, 'freqInput'), T('÷'), val(r.freqInputDenom ?? 1, 'freqInputDenom'), T('Hz'))
      segs.push(T('.'))
      // report only: the state reads Warning / Open load, protection is unchanged
      if (r.warnLimit > 0) segs.push(T('It reports a warning above'), val(r.warnLimit + ' A', 'warnLimit'), T('.'))
      if (r.openLoadLimit > 0) segs.push(T('It reports a missing load below'), val(r.openLoadLimit + ' A', 'openLoadLimit'), T('for'), val((r.openLoadTime ?? 1000) + ' ms', 'openLoadTime'), T('.'))
      if (r.underLimit > 0) segs.push(T(r.underTrip ? 'It switches off and latches a fault below' : 'It reports too little current below'), val(r.underLimit + ' A', 'underLimit'), T('for'), val((r.underTime ?? 1000) + ' ms', 'underTime'), T('.'))
      // the firmware ramps only with soft start + a duty from a signal, at 100 % per soft-start ramp time
      if (r.pwmEnabled && r.variableDutyCycle && r.rampDutyChanges && (r.softStart ?? r.softStartEnabled))
        segs.push(T('Duty changes ramp at up to 100 % per'), val((r.softStartRamp ?? r.softStartRampTime ?? 0) + ' ms', 'softStartRamp'), T('.'))
      if (r.clearOnReassert) segs.push(T('A trip that stays off clears when the input switches off, so switching it on again retries.'))
      // upstream hard short limit (output sub 32)
      if (r.hardShortLimit > 0) segs.push(T('Above'), val(r.hardShortLimit + ' A', 'hardShortLimit'), T('(a dead short) it latches off at once, without retrying.'))
      // upstream current-limited soft start (output sub 30): the inrush limit holds the ramp, the timeout trips
      if (r.pwmEnabled && r.softStart && r.softStartTimeout > 0) segs.push(T('Its soft start waits while the current is above'), val((r.inrushLimit ?? 0) + ' A', 'inrushLimit'), T('and it trips if not at full duty after'), val(r.softStartTimeout + ' ms', 'softStartTimeout'), T('.'))
      // upstream soft stop (output sub 31)
      if (r.pwmEnabled && r.softStopTime > 0) segs.push(T('When it turns off, its duty ramps down over'), val(r.softStopTime + ' ms', 'softStopTime'), T('first.'))
      if (r.shed) segs.push(T('It switches off while the module sheds loads.'))
      return segs
    }
    case 'sys': {
      // upstream fault clear / load shedding: only the retry-all and shed inputs make a sentence (sleep / mute have their own screen)
      const segs = []
      if (r.retryAllInput) segs.push(...[T('Each time'), srcTok(model, r.retryAllInput, 'retryAllInput'), T('turns on, every tripped output on'), self(n), T('tries again (at most once every 2 s).')])
      if (r.shedInput) segs.push(...[T('While'), srcTok(model, r.shedInput, 'shedInput'), T('is on,'), self(n), T('holds every output set to shed off (load shedding).')])
      return segs.length ? segs : null
    }
    default: return null
  }
}

/** Card heading for the sentence view: family · kind. */
export function cardKind(n) {
  const k = { virtualinput: 'COMBINE', condition: 'COMPARE', timer: 'TIMER · ' + (TIMER_MODES[n.row?.mode ?? 0] ?? '').toUpperCase(), flasher: 'FLASHER', counter: 'COUNTER', table: 'TABLE', canoutput: 'CAN OUTPUT', caninput: 'CAN INPUT', math: 'MATH', curve: 'CURVE', canmsg: 'CAN MESSAGE', comfortblink: 'COMFORT BLINK', latchgate: n.row?.type === 1 ? 'GATE' : 'LATCH', output: 'OUTPUT', digitaloutput: 'OUTPUT' }[n.kind] ?? n.kindLabel.toUpperCase()
  return k
}
