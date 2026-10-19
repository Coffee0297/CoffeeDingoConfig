// Client-side simulator of one module's blocks. Nothing is sent to the car.
// Mirrors the firmware (functions/*.cpp): Condition hysteresis, VirtualInput AND/OR/NOR (a real NOR from
// firmware 5.6.6; before it was NAND) with NOT per input and momentary/latching, Timer on-delay/off-delay/pulse, Flasher,
// Condition on / off delay (upstream feat/condition-delay), Counter edges, Table interpolation, Curve (upstream feat/curve-block), Latch / Gate (upstream feat/latch-gate-block), CAN input operator + timeout, outputs with injected faults (a trip that runs out
// of retries latches; upstream fault clear: cleared by the input going off, or by the module's retry-all edge).
import { interpolate } from '../../../../lib/table.js'
import { latchClears } from '../../../../lib/trip.js'
import { curveAt } from './curve.js'
import { fmt } from './livevals.js'
import { upstreamArgOff } from './model.js'
import { latchGateStep } from './latchgate.js'

const truthy = (v) => v === true || (typeof v === 'number' && v !== 0)
const asNum = (v) => (v === true ? 1 : v === false || v == null ? 0 : +v || 0)

function cmp(op, a, b) {
  switch (Number(op)) {
    case 0: return a === b
    case 1: return a !== b
    case 2: return a > b
    case 3: return a < b
    case 4: return a >= b
    case 5: return a <= b
    case 6: return ((a | 0) & (b | 0)) > 0
    case 7: return !(((a | 0) & (b | 0)) > 0)
    default: return false
  }
}
// firmware Input::Check (momentary / latching on the rising edge)
function check(m, mode, v) {
  if (v !== m.last) { if (Number(mode) === 0) m.out = v; else if (v) m.out = !m.out }
  m.last = v
  return !!m.out
}
const edgeOf = (e, prev, cur) => (Number(e) === 0 ? !prev && cur : Number(e) === 1 ? prev && !cur : prev !== cur)

export const SOURCE_KINDS = new Set(['input', 'analoginput', 'caninput', 'sys', 'lua', 'keypad'])

export function createSim(model, snapshot) {
  const vals = { ...snapshot }
  const inputs = {}            // source port idx -> forced value (what the user set)
  const canValue = {}          // caninput node id -> raw value
  const faults = {}            // node id -> 'oc' | 'open' | 'timeout'
  const status = {}            // node id -> { text, tone, why }
  const mem = {}
  let t = 0
  const m = (id) => (mem[id] ??= { last: false, out: false })
  const port = (n, prop) => n.outs.find((p) => p.prop === prop)?.idx
  const val = (idx) => (idx ? vals[idx] : undefined)
  // seed the raw values of CAN inputs from the live Value (state is re-derived from it)
  for (const n of model.nodes.values()) if (n.kind === 'caninput') { const vi = port(n, 'Value'); canValue[n.id] = vi && typeof vals[vi] === 'number' ? vals[vi] : truthy(vals[port(n, 'State')]) ? 1 : 0 }

  function evalSources() {
    for (const n of model.nodes.values()) {
      if (n.kind === 'caninput') {
        const sIdx = port(n, 'State'), vIdx = port(n, 'Value')
        if (faults[n.id] === 'timeout') {
          // upstream dingoFW with timeoutUseValue: the timeout value, and its result by the input's own test
          const tv = model.upstream && n.row?.timeoutUseValue ? +n.row.timeoutValue || 0 : null
          if (n.row?.timeoutEnabled && tv != null) { const on = cmp(n.row.operator, tv, +n.row.operand || 0); if (vIdx) vals[vIdx] = tv; if (sIdx) vals[sIdx] = on; status[n.id] = { text: 'TIMEOUT', tone: 'warn', why: `No frame for ${n.row.timeout} ms: value ${tv}, state ${on ? 'on' : 'off'}.` } }
          else if (n.row?.timeoutEnabled) { if (vIdx) vals[vIdx] = 0; if (sIdx) vals[sIdx] = false; status[n.id] = { text: 'TIMEOUT', tone: 'warn', why: `No frame for ${n.row.timeout} ms: value 0, state off.` } }
          else status[n.id] = { text: 'NO DATA', tone: 'warn', why: 'Timeout is off on this input, so it keeps its last value.' }
          continue
        }
        const raw = asNum(canValue[n.id])
        if (vIdx) vals[vIdx] = raw
        if (sIdx) vals[sIdx] = check(m(n.id), n.row?.mode ?? 0, cmp(n.row?.operator ?? 2, raw, +n.row?.operand || 0))
        delete status[n.id]
        continue
      }
      if (SOURCE_KINDS.has(n.kind) || !n.enabled) for (const p of n.outs) if (p.idx in inputs) vals[p.idx] = inputs[p.idx]
    }
  }

  function evalComb() {
    for (const n of model.nodes.values()) {
      if (!n.enabled) continue
      const r = n.row ?? {}
      if (n.kind === 'virtualinput') {
        const out = port(n, 'State'); if (!out) continue
        if (!r.var0 || !r.var1) continue          // firmware: keeps its value until both are set
        const b = (i) => { const x = truthy(val(r['var' + i])); return r['not' + i] ? !x : x }
        const j = (c, a, bb) => (Number(c) === 0 ? a && bb : Number(c) === 1 ? a || bb : !(a || bb))
        let res = j(r.cond0, b(0), b(1))
        if (r.var2) res = j(r.cond1, res, b(2))
        vals[out] = check(m(n.id), r.mode ?? 0, res)
      } else if (n.kind === 'condition') {
        const out = port(n, 'Value'); if (!out) continue
        // upstream dingoFW keeps a band, not the release point (model.js hystBand): a wrong-side release point is none
        const x = asNum(val(r.input)), set = +r.arg || 0, rel = model.upstream ? upstreamArgOff(r.operator, set, r.argOff) : r.argOff == null ? set : +r.argOff
        const hyst = rel !== set, was = truthy(vals[out]), lo = Math.min(set, rel), hi = Math.max(set, rel)
        let v
        switch (Number(r.operator)) {
          case 2: v = hyst ? (was ? x > lo : x > hi) : x > set; break
          case 3: v = hyst ? (was ? x < hi : x < lo) : x < set; break
          case 4: v = hyst ? (was ? x >= lo : x >= hi) : x >= set; break
          case 5: v = hyst ? (was ? x <= hi : x <= lo) : x <= set; break
          default: v = cmp(r.operator, x, set)
        }
        // upstream feat/condition-delay (firmware Condition::Update): the result follows the compare only once it
        // has differed for Delay on (turning on) / Delay off (turning off); a flip back in between restarts it
        const dOn = +r.delayOn || 0, dOff = +r.delayOff || 0
        if (dOn || dOff) {
          const s = m(n.id), c = !!v
          s.same ??= t
          if (c === s.out || t - s.same >= (c ? dOn : dOff)) { s.out = c; s.same = t }
          v = s.out
        }
        vals[out] = v
      } else if (n.kind === 'table') {
        const out = port(n, 'Value'); if (!out) continue
        vals[out] = interpolate(r.xSize, r.ySize, r.xAxis ?? [], r.yAxis ?? [], r.cells ?? [], asNum(val(r.xInput)), (r.ySize ?? 1) > 1 ? asNum(val(r.yInput)) : 0)
      } else if (n.kind === 'curve') {
        const out = port(n, 'Value'); if (!out) continue
        vals[out] = curveAt(r.points, r.x, r.y, asNum(val(r.input)))
      } else if (n.kind === 'math') {
        // same as the firmware's MathEval: B a signal or the constant, ÷0 gives 0, then × factor + offset
        const out = port(n, 'Value'); if (!out) continue
        const a = asNum(val(r.inputA)), b = r.inputB ? asNum(val(r.inputB)) : +r.constB || 0
        const v = [a + b, a - b, a * b, b === 0 ? 0 : a / b, Math.min(a, b), Math.max(a, b), (a + b) / 2][Number(r.op) || 0] ?? 0
        vals[out] = v * (r.factor ?? 1) + (+r.offset || 0)
      }
    }
  }

  function evalTime() {
    for (const n of model.nodes.values()) {
      if (!n.enabled) continue
      const r = n.row ?? {}, s = m(n.id)
      if (n.kind === 'timer') {
        const out = port(n, 'State'); if (!out) continue
        const active = Number(r.edge) === 1 ? !truthy(val(r.input)) : truthy(val(r.input))
        const rise = active && !s.la, fall = !active && s.la
        s.la = active
        const pre = +r.preset || 0
        // upstream dingoFW: a reset input stops the timer; mode 3 = one pulse, further edges ignored while it runs
        if (truthy(val(r.resetInput))) { s.timing = false; vals[out] = false; s.left = 0; continue }
        if (Number(r.mode) === 3) { if (rise && !s.timing) { s.timing = true; s.t0 = t } if (s.timing && t - s.t0 >= pre) s.timing = false; vals[out] = !!s.timing; s.left = s.timing ? Math.max(0, pre - (t - s.t0)) : 0; continue }
        if (Number(r.mode) === 0) { if (rise) { s.timing = true; s.t0 = t } if (!active) s.timing = false; vals[out] = !!s.timing && t - s.t0 >= pre }
        else if (Number(r.mode) === 1) { if (fall) { s.timing = true; s.t0 = t } if (active) s.timing = false; if (s.timing && t - s.t0 >= pre) s.timing = false; vals[out] = active || !!s.timing }
        else { if (rise) { s.timing = true; s.t0 = t } if (s.timing && t - s.t0 >= pre) s.timing = false; vals[out] = !!s.timing }
        s.left = s.timing ? Math.max(0, pre - (t - s.t0)) : 0
      } else if (n.kind === 'comfortblink') {
        const outL = port(n, 'Left'), outR = port(n, 'Right'); if (!outL || !outR) continue
        const clk = truthy(val(r.clockInput)), rise = clk && !s.lc, fall = !clk && s.lc
        s.lc = clk
        s.L ??= {}; s.R ??= {}
        const on = (x) => (x.last && !x.cancel) || x.comfort
        const stepSide = (x, o, inp) => {
          if (inp && !x.last) { x.since = t; x.held = false; x.cancel = !!o.comfort; o.comfort = false; x.comfort = false; x.blinks = clk ? 1 : 0; x.just = true }
          if (inp && !x.held && t - x.since >= (+r.tapMs || 1000)) { x.held = true; x.cancel = false }
          if (!inp && x.last) { x.comfort = !x.held && !x.cancel && ((x.blinks ?? 0) < (+r.blinks || 3) || clk); x.held = false; x.cancel = false }
          x.last = inp
        }
        stepSide(s.L, s.R, truthy(val(r.leftInput))); stepSide(s.R, s.L, truthy(val(r.rightInput)))
        for (const x of [s.L, s.R]) {
          if (rise && on(x) && !x.just) x.blinks = (x.blinks ?? 0) + 1
          if (fall && x.comfort && x.blinks >= (+r.blinks || 3)) x.comfort = false
          x.just = false
        }
        vals[outL] = on(s.L); vals[outR] = on(s.R)
      } else if (n.kind === 'latchgate') {
        const out = port(n, 'Value'); if (!out) continue
        vals[out] = latchGateStep(s, r, asNum(val(r.input)), asNum(val(r.controlInput)), t)
      } else if (n.kind === 'flasher') {
        const out = port(n, 'State'); if (!out) continue
        if (!truthy(val(r.input))) { vals[out] = false; s.on = false; continue }
        s.tOff ??= -1e9
        if (!s.on && t - s.tOff > (+r.offTime || 0)) { s.on = true; s.tOn = t }
        if (s.on && t - s.tOn > (+r.onTime || 0)) { s.on = false; s.tOff = t }
        vals[out] = s.on
      } else if (n.kind === 'counter') {
        const out = port(n, 'Value'); if (!out) continue
        let c = asNum(vals[out])
        const inc = truthy(val(r.incInput)), dec = truthy(val(r.decInput)), rst = truthy(val(r.resetInput))
        const ie = edgeOf(r.incEdge, !!s.li, inc), de = edgeOf(r.decEdge, !!s.ld, dec), re = edgeOf(r.resetEdge, !!s.lr, rst)
        s.li = inc; s.ld = dec; s.lr = rst
        if (re) c = 0
        else if (r.holdToReset && ((inc && t - (s.ti ?? t) >= r.resetTime) || (dec && t - (s.td ?? t) >= r.resetTime))) c = 0
        else {
          if (ie) { c++; if (c > r.maxCount) c = r.wrapAround ? 0 : r.maxCount; s.ti = t }
          if (de) { c = c === 0 ? (r.wrapAround ? r.maxCount : r.minCount) : c - 1; s.td = t }
        }
        vals[out] = c
      }
    }
  }

  // firmware CyclicUpdate: a rising edge of the retry-all signal, at most every 2 s (its clock starts at 0)
  function retryEdge() {
    const idx = model.nodes.get('sys')?.row?.retryAllInput, s = m('sys|retry')
    const on = !!idx && truthy(val(idx)), edge = on && !s.last && t - (s.at ?? 0) >= 2000
    s.last = on
    if (edge) s.at = t
    return edge
  }

  function evalOutputs() {
    const retry = retryEdge(), retryWired = !!model.nodes.get('sys')?.row?.retryAllInput
    // upstream load shedding: while the module's shed input is on, outputs with Shed are held off (like starter disable)
    const shedIdx = model.nodes.get('sys')?.row?.shedInput, shedding = !!shedIdx && truthy(val(shedIdx))
    for (const n of model.nodes.values()) {
      const r = n.row ?? {}
      if (n.kind === 'output' || n.kind === 'digitaloutput') {
        const onIdx = port(n, n.kind === 'output' ? 'On' : 'State'), curIdx = port(n, 'Current'), ocIdx = port(n, 'Overcurrent'), fIdx = port(n, 'Fault')
        const wIdx = port(n, 'Warning'), olIdx = port(n, 'Open Load'), ucIdx = port(n, 'Undercurrent')   // upstream state signals, 1 only while reported
        const src = n.kind === 'output' ? r.inputVal : r.input
        const shedNow = n.kind === 'output' && shedding && !!r.shed
        const want = !!r.enabled && truthy(val(src)) && !shedNow
        const f = faults[n.id]
        const nominal = mem[n.id]?.amps
        const s = m(n.id), until = latchClears(r, retryWired)
        // Profet::ClearFault: a retry-all edge, or (clear on re-assert) the input going off
        if (retry || (s.latched && r.clearOnReassert && !want)) { s.latched = false; s.trip = undefined }
        if (f === 'oc' && want) {
          if (onIdx) vals[onIdx] = false; if (ocIdx) vals[ocIdx] = true; if (fIdx) vals[fIdx] = true; if (curIdx) vals[curIdx] = 0
          m(n.id).on = false   // a trip cuts a soft stop at once
          const lim = r.currentLimit ?? '?'
          s.trip ??= t
          // reset mode None latches at once, Count once its retries have run out, Endless never
          if (n.kind === 'output' && (!r.resetMode || (r.resetMode === 1 && t - s.trip >= (r.resetCountLimit ?? 0) * (r.resetTime ?? 0)))) s.latched = true
          status[n.id] = { text: s.latched ? 'FAULT' : 'TRIPPED', tone: 'fault', why: n.kind === 'output'
            ? r.hardShortLimit > 0 ? `Over ${lim} A: the output trips. If it is a dead short (above ${r.hardShortLimit} A) it latches off at once instead, without retrying; a smaller overload ${r.resetMode ? 'retries as set' : 'stays off until it is reset'}.`
            : `Over ${lim} A: the output trips. ${s.latched ? `It stays off until ${until}.` : r.resetMode ? `It tries again after ${(r.resetTime ?? 0) / 1000} s${r.resetMode === 1 ? `, up to ${r.resetCountLimit} times, then stays off` : ''}.` : ''}`
            : 'Low-side output tripped (simulated).' }
        } else if (n.kind === 'output' && (m(n.id).uTrip || (f === 'under' && want && r.underLimit > 0))) {
          // too little current (upstream subs 27-29): after the time, report Undercurrent, or switch off and latch Fault
          const s = m(n.id); s.underAt ??= t
          const tripped = s.uTrip || (r.underTrip && t - s.underAt >= (r.underTime ?? 1000))
          if (tripped) {
            s.uTrip = true
            if (onIdx) vals[onIdx] = false; if (ocIdx) vals[ocIdx] = false; if (fIdx) vals[fIdx] = true; if (curIdx) vals[curIdx] = 0
            status[n.id] = { text: 'TRIPPED', tone: 'fault', why: `Below ${r.underLimit} A for ${r.underTime ?? 1000} ms: the output switched off and latched Fault. It stays off until the module is power-cycled.` }
          } else {
            if (onIdx) vals[onIdx] = true; if (ocIdx) vals[ocIdx] = false; if (fIdx) vals[fIdx] = false; if (curIdx) vals[curIdx] = r.underLimit / 2
            status[n.id] = t - s.underAt < (r.underTime ?? 1000)
              ? { text: 'ON', tone: 'on', why: `Less than ${r.underLimit} A: reported after ${r.underTime ?? 1000} ms.` }
              : { text: 'UNDERCURRENT', tone: 'warn', why: `It draws less than its ${r.underLimit} A limit: a bulb out, a pump running dry? It keeps running; the module only reports it.` }
          }
        } else if (s.latched) {
          if (onIdx) vals[onIdx] = false; if (ocIdx) vals[ocIdx] = false; if (fIdx) vals[fIdx] = true; if (curIdx) vals[curIdx] = 0
          status[n.id] = { text: 'FAULT', tone: 'fault', why: `Latched off after a trip. It stays off until ${until}.` }
        } else if (f === 'open' && want) {
          if (onIdx) vals[onIdx] = true; if (ocIdx) vals[ocIdx] = false; if (fIdx) vals[fIdx] = false; if (curIdx) vals[curIdx] = 0
          // a PDM output reports Open load only with a "load missing below" limit, once the load has been missing that long
          const s = m(n.id); s.openAt ??= t
          if (n.kind === 'output' && !(r.openLoadLimit > 0)) status[n.id] = { text: 'ON', tone: 'on', why: 'It reads almost no current, but no "load missing below" limit is set, so the module reports it as on.' }
          else if (n.kind === 'output' && t - s.openAt < (r.openLoadTime ?? 1000)) status[n.id] = { text: 'ON', tone: 'on', why: `Almost no current: reported as Open load after ${r.openLoadTime ?? 1000} ms.` }
          else status[n.id] = { text: 'OPEN LOAD', tone: 'warn', why: 'The module drives the output but reads almost no current. Check the plug and the fuse.' }
        } else {
          s.trip = undefined
          // upstream soft stop (output sub 31): a PWM output that was on ramps down for its soft-stop time after its
          // input turns off, and reports On meanwhile; disabling it (or a trip) cuts at once
          if (want || !r.enabled || !r.pwmEnabled || !(r.softStopTime > 0)) { s.stopAt = undefined; s.on = want }
          else if (s.on) { s.stopAt ??= t; if (t - s.stopAt >= r.softStopTime) { s.on = false; s.stopAt = undefined } }
          if (!want && s.on) {
            if (onIdx) vals[onIdx] = true; if (ocIdx) vals[ocIdx] = false; if (fIdx) vals[fIdx] = false
            if (curIdx) vals[curIdx] = nominal ?? null
            status[n.id] = { text: 'STOPPING', tone: 'on', why: `Its input is off: the duty ramps down over ${r.softStopTime} ms, then it switches off.` }
            if (wIdx) vals[wIdx] = false; if (olIdx) vals[olIdx] = false; if (ucIdx) vals[ucIdx] = false
            continue
          }
          if (onIdx) vals[onIdx] = want; if (ocIdx) vals[ocIdx] = false; if (fIdx) vals[fIdx] = false
          if (curIdx) vals[curIdx] = want ? (nominal ?? null) : 0
          m(n.id).openAt = undefined; m(n.id).underAt = undefined
          status[n.id] = want && r.warnLimit > 0 && nominal > r.warnLimit
            ? { text: 'WARNING', tone: 'warn', why: `It draws ${nominal.toFixed(1)} A, above its ${r.warnLimit} A warning limit. It keeps running; the module only reports it.` }
            : shedNow && r.enabled && truthy(val(src)) ? { text: 'SHED', tone: 'warn', why: 'Its input is on, but the module is shedding loads: it comes back when the shed input goes off.' }
            : { text: want ? 'ON' : 'OFF', tone: want ? 'on' : 'off', why: !r.enabled ? 'The output is disabled.' : !src ? 'It has no input, so it never switches.' : want ? 'Its input is on.' : f ? 'It is off, so the fault has nothing to act on yet.' : 'Its input is off.' }
        }
        if (wIdx) vals[wIdx] = status[n.id]?.text === 'WARNING'
        if (olIdx) vals[olIdx] = status[n.id]?.text === 'OPEN LOAD'
        if (ucIdx) vals[ucIdx] = status[n.id]?.text === 'UNDERCURRENT'
      } else if (n.kind === 'canoutput' && n.enabled) {
        status[n.id] = r.kind > 0 ? { text: r.kind === 1 ? 'COUNTER' : 'CHECKSUM', tone: 'on', why: `Sends ${r.kind === 1 ? 'a rolling counter' : 'a checksum of the frame'} on ${'0x' + Number(r.id ?? 0).toString(16).toUpperCase()} every ${r.interval} ms (simulated, nothing is sent).` }
          : r.input ? { text: 'SENDS ' + fmt(val(r.input)), tone: 'on', why: `Sends ${fmt(val(r.input))} on ${'0x' + Number(r.id ?? 0).toString(16).toUpperCase()} ${r.triggerInput ? 'each time its trigger turns on' : `every ${r.interval} ms`} (simulated, nothing is sent).` }
          : { text: 'NOTHING', tone: 'warn', why: 'No value to send.' }
      }
    }
  }

  function step(dt = 50) {
    t += dt
    evalSources(); evalComb(); evalComb(); evalTime(); evalComb(); evalOutputs()
  }
  // remember real load currents so a simulated "on" shows a believable current
  for (const n of model.nodes.values()) if (n.kind === 'output') { const c = n.outs.find((p) => p.prop === 'Current'); const a = c ? snapshot[c.idx] : null; if (a > 0.05) m(n.id).amps = a }

  return {
    vals, inputs, faults, status, canValue, mem,
    get time() { return t },
    step,
    set(idx, v) { inputs[idx] = v },
    setCan(id, v) { canValue[id] = v },
    fault(id, kind) { if (!kind || kind === 'none') delete faults[id]; else faults[id] = kind },
    timeLeft(id) { return mem[id]?.left ?? 0 },
  }
}
