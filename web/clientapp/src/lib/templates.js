// Templates: ready-made circuits (headlights, washer + wipers, blinkers…) whose inputs can be any signal on
// the bus and whose outputs any module's output, optionally through a relay. The logic runs on the module
// that owns the outputs; an input from another module arrives there as a CAN input decoding its broadcast.
// A template's build(ctx, sel) runs twice: against previewCtx (records the blocks it would create, for the
// preview and the links drawing) and against liveCtx (creates them). The Circuit Builder in the Wiring tab
// uses the same list.
//
// Field types: bool / num = an input signal, out = an output (load: lamp | motor | pump | horn | fan | load),
// number = a value, op = a comparison, check = a yes/no option. opt = may be left empty.

const And = 0, Or = 1   // BoolOperator
// Firmware ranges (core/param_defs.h): flasher on/off 0..5000 ms, timer preset 0..3600000 ms. The device
// NAKs anything out of range, so round + clamp here and "built" means the device really got it.
const ms = (v, max) => Math.min(max, Math.max(0, Math.round(+v || 0)))

export const TEMPLATES = [
  { key: 'headlights', name: 'Headlights', icon: '💡',
    desc: 'Low beam from the headlight switch, high beam from the high-beam switch while the low beam is on, and flash-to-pass at any time. Optionally only with ignition on, and low beam off while high beam is on (H4 bulbs).',
    fields: [
      { k: 'low', t: 'bool', label: 'Headlight switch (low beam)' },
      { k: 'high', t: 'bool', label: 'High-beam switch', opt: true },
      { k: 'pass', t: 'bool', label: 'Flash-to-pass', opt: true },
      { k: 'ign', t: 'bool', label: 'Ignition (lights only with it on)', opt: true },
      { k: 'lowL', t: 'out', load: 'lamp', label: 'Low beam (left, or both)' },
      { k: 'lowR', t: 'out', load: 'lamp', label: 'Low beam right', opt: true },
      { k: 'highL', t: 'out', load: 'lamp', label: 'High beam (left, or both)', opt: true },
      { k: 'highR', t: 'out', load: 'lamp', label: 'High beam right', opt: true },
      { k: 'h4', t: 'check', label: 'Low beam off while high beam is on (H4 bulbs)' }],
    build: async (ctx, s) => {
      const ign = +s.ign || 0
      const lowOn = ign ? await ctx.virtual({ v0: +s.low, op0: And, v1: ign }, 'Head Low On') : +s.low
      const highSw = s.high ? await ctx.virtual({ v0: lowOn, op0: And, v1: +s.high }, 'Head High Sw') : 0
      const high = await ctx.anyOf([highSw, +s.pass || 0], 'Head High')
      if ((s.highL || s.highR) && !high) throw new Error('High-beam outputs need a high-beam switch or flash-to-pass')
      const low = s.h4 && high ? await ctx.virtual({ v0: lowOn, op0: And, v1: high, not1: true }, 'Head Low') : lowOn
      await ctx.wireOutput(s.lowL, low)
      if (s.lowR) await ctx.wireOutput(s.lowR, low)
      if (s.highL) await ctx.wireOutput(s.highL, high)
      if (s.highR) await ctx.wireOutput(s.highR, high)
    } },
  { key: 'washwipe', name: 'Washer + wipers', icon: '🌧',
    desc: 'The module’s own wiper block runs the motor: slow / fast / intermittent from the stalk, stops on the park switch, and wipes a few times after washing. The washer pump runs while the wash button is held. Needs a dingoPDM (CANBoards have no wiper block).',
    fields: [
      { k: 'slow', t: 'bool', label: 'Wiper switch: slow / on' },
      { k: 'fast', t: 'bool', label: 'Wiper switch: fast', opt: true },
      { k: 'int', t: 'bool', label: 'Wiper switch: intermittent', opt: true },
      { k: 'wash', t: 'bool', label: 'Wash button' },
      { k: 'park', t: 'bool', label: 'Park switch (on the wiper motor)' },
      { k: 'parkHigh', t: 'check', label: 'Park switch reads ON when parked' },
      { k: 'cycles', t: 'number', label: 'Wipes after washing (0–10)', def: 3, min: 0, max: 10 },
      { k: 'slowOut', t: 'out', load: 'motor', label: 'Wiper motor, slow' },
      { k: 'fastOut', t: 'out', load: 'motor', label: 'Wiper motor, fast', opt: true },
      { k: 'pumpOut', t: 'out', load: 'pump', label: 'Washer pump' }],
    build: async (ctx, s) => {
      const w = await ctx.wiper({ mode: 0, slowInput: +s.slow, fastInput: +s.fast || 0, interInput: +s.int || 0,
        parkInput: +s.park, parkStopLevel: !!s.parkHigh, washInput: +s.wash, washWipeCycles: Math.round(+s.cycles), name: 'Wipers' })
      await ctx.wireOutput(s.slowOut, w.slow)
      if (s.fastOut) await ctx.wireOutput(s.fastOut, w.fast)
      await ctx.wireOutput(s.pumpOut, +s.wash)
    } },
  { key: 'simple', name: 'Simple switched circuit', icon: '🔌', desc: 'One input drives one output directly.',
    fields: [{ k: 'input', t: 'bool', label: 'Driven by' }, { k: 'output', t: 'out', load: 'load', label: 'Output' }],
    build: async (ctx, s) => { await ctx.wireOutput(s.output, +s.input) } },
  { key: 'analog', name: 'Analog triggered switch', icon: '📈', desc: 'Output turns on when an analog signal crosses a threshold (creates a Condition).',
    fields: [{ k: 'analog', t: 'num', label: 'Analog signal' }, { k: 'op', t: 'op', label: 'Turn on when it is', def: 2 }, { k: 'thr', t: 'number', label: 'Threshold', def: 0 }, { k: 'output', t: 'out', load: 'load', label: 'Output' }],
    build: async (ctx, s) => { const c = await ctx.condition(+s.analog, +s.op, +s.thr, 'TP ' + ctx.outName(s.output)); await ctx.wireOutput(s.output, c) } },
  { key: 'blinker', name: 'Blinker / hazard', icon: '↔', desc: 'Left/right (+ optional hazard) blink two outputs. Optional US mode where the rear light is also the brake light (turn signal overrides brake on that side); the high-mount 3rd brake stays independent.',
    fields: [{ k: 'left', t: 'bool', label: 'Left trigger' }, { k: 'right', t: 'bool', label: 'Right trigger' },
      { k: 'hazard', t: 'bool', label: 'Hazard trigger', opt: true }, { k: 'leftOut', t: 'out', load: 'lamp', label: 'Left output' },
      { k: 'rightOut', t: 'out', load: 'lamp', label: 'Right output' }, { k: 'rate', t: 'number', label: 'Blink rate (ms, max 5000)', def: 400, min: 0, max: 5000 },
      { k: 'us', t: 'check', label: 'US: rear lamp is also the brake light' },
      { k: 'brake', t: 'bool', label: 'Brake input (US mode)', opt: true }, { k: 'brake3', t: 'out', load: 'lamp', label: '3rd (high-mount) brake output', opt: true }],
    build: async (ctx, s) => {
      const fl = await ctx.flasher(ctx.alwaysOn(), +s.rate, +s.rate, 'TP Blink')
      const haz = +s.hazard || 0
      const us = !!s.us && s.brake, brake = +s.brake || 0
      const side = async (trig, nm) => {
        const turn = await ctx.anyOf([+trig, haz], 'TP ' + nm + ' Turn')        // trig OR hazard (passthrough if no hazard)
        if (us) {
          const t1 = await ctx.anyOf([brake, turn], 'TP ' + nm + ' On')         // brake OR turning
          const t2 = await ctx.virtual({ v0: fl, op0: Or, v1: turn, not1: true }, 'TP ' + nm + ' Phase') // blink OR not-turning
          return ctx.virtual({ v0: t1, op0: And, v1: t2 }, 'TP ' + nm)          // → turning blinks, else solid on brake
        }
        return ctx.virtual({ v0: turn, op0: And, v1: fl }, 'TP ' + nm)          // turning AND blink
      }
      await ctx.wireOutput(s.leftOut, await side(s.left, 'Left'))
      await ctx.wireOutput(s.rightOut, await side(s.right, 'Right'))
      if (us && s.brake3) await ctx.wireOutput(s.brake3, brake)                 // independent high-mount brake
    } },
  { key: 'fuelpump', name: 'Fuel pump', icon: '⛽', desc: 'Primes on power-up for a moment, then runs while the engine is turning (a run signal — e.g. RPM — above a threshold).',
    fields: [{ k: 'run', t: 'num', label: 'Run signal (e.g. RPM)' }, { k: 'thr', t: 'number', label: 'Running above', def: 300 },
      { k: 'prime', t: 'number', label: 'Prime time (ms, max 1 h)', def: 3000, min: 0, max: 3600000 }, { k: 'output', t: 'out', load: 'pump', label: 'Pump output' }],
    build: async (ctx, s) => {
      const run = await ctx.condition(+s.run, 2, +s.thr, 'TP FuelRun')                  // run signal > threshold
      const prime = await ctx.timer(ctx.alwaysOn(), 2, +s.prime, 'TP Prime')             // one pulse at power-up (Timer, pulse mode)
      await ctx.wireOutput(s.output, await ctx.virtual({ v0: run, op0: Or, v1: prime }, 'TP FuelPump'))
    } },
  { key: 'wipers', name: 'Wipers, simple (no park switch)', icon: '🌂', desc: 'Low/High run the wiper output; Intermittent pulses it on a gap. Combines whatever you provide. For a motor with a park switch use Washer + wipers.',
    fields: [{ k: 'low', t: 'bool', label: 'Low / On' }, { k: 'high', t: 'bool', label: 'High', opt: true },
      { k: 'int', t: 'bool', label: 'Intermittent', opt: true }, { k: 'intRate', t: 'number', label: 'Intermittent gap (ms, max 5000)', def: 3000, min: 0, max: 5000 },
      { k: 'output', t: 'out', load: 'motor', label: 'Wiper output' }],
    build: async (ctx, s) => {
      const flInt = s.int ? await ctx.flasher(+s.int, 700, +s.intRate, 'TP WipeInt') : 0
      await ctx.wireOutput(s.output, await ctx.anyOf([+s.low, +s.high || 0, flInt], 'TP Wipers'))
    } },
  { key: 'afterrun', name: 'After-run (stay on after switch-off)', icon: '⏲', desc: 'Output follows a trigger and keeps running for a hold time after it drops — radiator fan or turbo cooling after ignition off, courtesy light after the door closes (creates an off-delay Timer).',
    fields: [{ k: 'trig', t: 'bool', label: 'Trigger' }, { k: 'hold', t: 'number', label: 'Hold after off (ms, max 1 h)', def: 60000, min: 0, max: 3600000 }, { k: 'output', t: 'out', load: 'fan', label: 'Output' }],
    build: async (ctx, s) => { await ctx.wireOutput(s.output, await ctx.timer(+s.trig, 1, +s.hold, 'TP ' + ctx.outName(s.output) + ' Hold')) } },
  { key: 'pwmfan', name: 'PWM fan (duty from analog)', icon: '🌀', desc: 'Fan output runs PWM with its duty following an analog signal (e.g. a temp sensor), with soft start. CANBoard outputs only — set a PDM output’s variable duty in its output editor.',
    fields: [{ k: 'analog', t: 'num', label: 'Duty source (e.g. temperature)' }, { k: 'full', t: 'number', label: 'Signal value at 100% duty', def: 5000 },
      { k: 'min', t: 'number', label: 'Min duty (%)', def: 0 }, { k: 'freq', t: 'number', label: 'PWM frequency (Hz)', def: 200 }, { k: 'output', t: 'out', load: 'fan', label: 'Fan output' }],
    build: async (ctx, s) => { await ctx.setOutputPwm(s.output, { source: +s.analog, full: +s.full, min: +s.min, freq: +s.freq }) } },
]

export const OPS = [{ v: 2, t: 'greater than' }, { v: 3, t: 'less than' }, { v: 4, t: '≥' }, { v: 5, t: '≤' }, { v: 0, t: 'equals' }]
export const isInput = (f) => f.t === 'bool' || f.t === 'num'
export const blank = (v) => v === '' || v == null

// Default selection for a template (each field's def, '' otherwise).
export function defaults(tpl) { const s = {}; for (const f of tpl.fields) s[f.k] = f.def ?? (f.t === 'check' ? false : ''); return s }

// Missing required fields / out-of-range numbers, as one message, or '' when ready.
export function validate(tpl, sel) {
  const missing = tpl.fields.filter((f) => !f.opt && f.t !== 'check' && blank(sel[f.k]))
  if (missing.length) return 'Fill in: ' + missing.map((f) => f.label).join(', ')
  const bad = tpl.fields.find((f) => f.t === 'number' && f.max != null && (+sel[f.k] < (f.min ?? 0) || +sel[f.k] > f.max))
  if (bad) return `${bad.label}: must be ${bad.min ?? 0}–${bad.max} (the module rejects anything outside).`
  const outs = tpl.fields.filter((f) => f.t === 'out' && !blank(sel[f.k])).map((f) => String(sel[f.k]))
  if (new Set(outs).size !== outs.length) return 'The same output is picked twice.'
  return ''
}

// OR-combine source vars (1 → passthrough, 2/3 → one VirtualInput). Shared by both ctx kinds.
const withAnyOf = (ctx) => Object.assign(ctx, {
  anyOf: async (vars, name) => {
    const v = vars.filter((x) => x > 0)
    if (v.length > 3) throw new Error('anyOf takes at most 3 signals')
    return v.length <= 1 ? (v[0] ?? 0) : ctx.virtual({ v0: v[0], op0: Or, v1: v[1], op1: Or, v2: v[2] ?? 0 }, name)
  },
})

// ---- Preview: run build without touching a module. Every signal is a token (a fake index > 0); every
// block it would create becomes an op {id, op, name, ins: [node ids], detail}; every output wire a {out, src}.
// Node ids: 'in:<field>' for a template input, 'on' for Always On, 'op<n>' for a created block.
const TOK_OP = 100000, TOK_IN = 200000
export async function previewTemplate(tpl, sel, outName = (n) => 'output' + n) {
  const ops = [], wires = [], node = new Map([[1, 'on']])
  const s = { ...sel }
  tpl.fields.forEach((f, i) => { if (isInput(f) && !blank(sel[f.k])) { s[f.k] = TOK_IN + i; node.set(TOK_IN + i, 'in:' + f.k) } })
  const ids = (...xs) => xs.filter((x) => x > 0).map((x) => node.get(x) ?? '?')
  const op = (kind, name, ins, detail) => {
    const id = 'op' + (ops.length + 1), t = TOK_OP + ops.length + 1
    ops.push({ id, op: kind, name, ins, detail }); node.set(t, id); return t
  }
  const ctx = withAnyOf({
    alwaysOn: () => 1, outName,
    condition: async (input, o, arg, name) => op('condition', name, ids(input), `${OPS.find((x) => x.v === o)?.t ?? 'op ' + o} ${arg}`),
    flasher: async (input, on, off, name) => op('flasher', name, ids(input), `${ms(on, 5000)} / ${ms(off, 5000)} ms`),
    timer: async (input, mode, preset, name) => op('timer', name, ids(input), `${['on-delay', 'off-delay', 'pulse'][mode]} ${ms(preset, 3600000)} ms`),
    virtual: async (c, name) => op('virtual', name, ids(c.v0, c.v1, c.v2), virtualText(c)),
    wireOutput: async (n, src) => { wires.push({ out: +n, src: ids(src)[0] ?? null }) },
    setOutputPwm: async (n, { source }) => { wires.push({ out: +n, src: ids(source)[0] ?? null, pwm: true }) },
    wiper: async (cfg) => {
      const id = op('wiper', 'Wiper block', ids(cfg.slowInput, cfg.fastInput, cfg.interInput, cfg.parkInput, cfg.washInput), `${cfg.washWipeCycles} wipes after wash`)
      return { slow: id, fast: id, park: id, inter: id, wash: id, swipe: id }
    },
  })
  await tpl.build(ctx, s)
  return { ops, wires, need: countNeeds(ops) }
}
const virtualText = (c) => {
  const t = (v, not) => (v > 0 ? (not ? 'NOT ' : '') + 'x' : null)
  const parts = [t(c.v0, c.not0), t(c.v1, c.not1), t(c.v2, c.not2)].filter(Boolean)
  return parts.length > 1 ? (c.op0 === Or ? 'any of ' : 'all of ') + parts.length : 'pass'
}
const ARR = { condition: 'conditions', flasher: 'flashers', timer: 'timers', virtual: 'virtualInputs' }
const countNeeds = (ops) => ops.reduce((m, o) => { const a = ARR[o.op]; if (a) m[a] = (m[a] ?? 0) + 1; return m }, {})

// Free-slot shortfalls on the logic module for a preview, e.g. ['2 timers (1 free)'].
export function shortfalls(need, funcs) {
  const out = []
  for (const [arr, n] of Object.entries(need)) {
    const free = (funcs?.[arr] ?? []).filter((x) => !x.enabled).length
    if (free < n) out.push(`${n} ${arr} (${free} free)`)
  }
  return out
}

// ---- Live: create the blocks on module `guid`. env = {api, guid, wireOutput(n, idx), isCanboard,
// outName(n)}; created / wired collect what was made, so the instance can be removed later.
export async function liveCtx(env) {
  const { api, guid } = env
  const created = [], wired = []
  let funcs, vmap
  const refresh = async () => { [funcs, vmap] = await Promise.all([api.functions(guid), api.inputs(guid)]) }
  await refresh()
  const idxOf = (kind, n, prop) => vmap.find((v) => v.kind === kind && v.number === n && v.prop === prop)?.index
  const make = async (kind, arr, prop, body) => {
    const slot = (funcs?.[arr] ?? []).find((x) => !x.enabled)
    if (!slot) throw new Error(`No free ${arr} slots on this module`)
    await api.setFunction(guid, kind, slot.number, { enabled: true, ...body })
    created.push({ kind, number: slot.number })
    await refresh()
    const i = idxOf(kind, slot.number, prop)
    if (i == null) throw new Error(`couldn't resolve ${kind} ${slot.number}'s signal index`)
    return i
  }
  const ctx = withAnyOf({
    created, wired, outName: env.outName ?? ((n) => 'output' + n),
    alwaysOn: () => vmap.find((v) => v.name === 'Always On')?.index ?? 1,
    condition: (input, operator, arg, name) => make('condition', 'conditions', 'Value', { input, operator, arg: +arg || 0, name }),
    flasher: (input, on, off, name, single = false) => make('flasher', 'flashers', 'State', { input, onTime: ms(on, 5000), offTime: ms(off, 5000), single, name }),
    // mode: 0 on-delay, 1 off-delay, 2 pulse (firmware TimerMode)
    timer: (input, mode, preset, name) => make('timer', 'timers', 'State', { input, mode, edge: 0, preset: ms(preset, 3600000), name }),
    virtual: (c, name) => make('virtualinput', 'virtualInputs', 'State', { not0: !!c.not0, var0: c.v0 ?? 0, cond0: c.op0 ?? And, not1: !!c.not1, var1: c.v1 ?? 0, cond1: c.op1 ?? And, not2: !!c.not2, var2: c.v2 ?? 0, mode: 0, name }),
    wireOutput: async (n, src) => { await env.wireOutput(+n, src); wired.push(+n) },
    // Configure a CANBoard digital output for variable-duty PWM from an analog source + soft start.
    setOutputPwm: async (n, { source, full, min, freq, on }) => {
      if (!env.isCanboard) throw new Error('PWM-from-analog is wired on CANBoard outputs; for a PDM output set it in the output editor')
      await api.setFunction(guid, 'digitaloutput', +n, { enabled: true, input: on ?? ctx.alwaysOn(), pwmEnabled: true, variableDutyCycle: true, dutyCycleInput: source, dutyCycleDenominator: Math.max(1, Math.round(full / 100)), minDutyCycle: min, frequency: freq, softStartEnabled: true, softStartRampTime: 500 })
      wired.push(+n)
    },
    // The native wiper block (a singleton, PDM only).
    wiper: async (cfg) => {
      if (!funcs?.wiper) throw new Error('This module has no wiper block — wipers need a dingoPDM')
      if (funcs.wiper.enabled) throw new Error('The wiper block on this module is already in use — remove that first')
      await api.setFunction(guid, 'wiper', 1, { enabled: true, ...cfg })
      created.push({ kind: 'wiper', number: 1 })
      await refresh()
      const p = (prop) => idxOf('wiper', 1, prop)
      return { slow: p('Slow Output'), fast: p('Fast Output'), park: p('Park Output'), inter: p('Inter Output'), wash: p('Wash Output'), swipe: p('Swipe Output') }
    },
  })
  return ctx
}

// ---- Bus-wide output list: every PDM output and CANBoard digital output, with its connector pin, how it
// switches (high / low side), rating and what drives it now. value = '<guid>:<n>'.
// mods: [{device, outs: [{number, name, input (var index driving it), ratingA}]}].
export function outputOptions(mods, pinFor, ioTag) {
  const opts = []
  for (const { device, outs } of mods) {
    const kind = /can.?board/i.test(device.type ?? '') ? 'digitaloutput' : 'output'
    for (const o of outs) {
      const pin = pinFor(device, kind, o.number)
      const side = pin?.side ?? (kind === 'digitaloutput' ? 'low' : 'high')
      const used = o.input > 0 ? 'in use' : 'free'
      opts.push({
        value: `${device.guid}:${o.number}`, guid: device.guid, number: o.number, pin, side, used: o.input > 0, input: o.input || 0,
        module: device.name, tag: ioTag(device, kind, o.number), name: o.name?.trim() || '',
        label: [device.name, [pin?.label, ioTag(device, kind, o.number)].filter(Boolean).join(' '), o.name?.trim() || null,
          side + '-side' + (o.ratingA ? ` ${o.ratingA} A` : ''), used].filter(Boolean).join(' · '),
        search: pin ? `${pin.conn}.${pin.pin} pin ${pin.pin}` : '',
      })
    }
  }
  return opts.sort((a, b) => a.used - b.used)   // free outputs first
}

// The one module every picked output belongs to (the logic runs there), or an error.
export function logicModule(tpl, sel) {
  const guids = new Set(tpl.fields.filter((f) => f.t === 'out' && !blank(sel[f.k])).map((f) => String(sel[f.k]).split(':')[0]))
  if (guids.size > 1) return { error: 'All outputs of one template must be on the same module — its logic runs there. Split it into two templates.' }
  return { guid: [...guids][0] ?? null }
}

// ---- Wiring for one output, so the drawing adapts: what feeds the load, and what the relay coil hangs on.
// High side (PDM): the output supplies +12 V; load (or relay coil) to ground. Low side (CANBoard): the output
// pulls to ground; load (or relay coil) from a fused +12 V. With a relay the load always sits on 87 → ground,
// fed from a fused +12 V on 30.
export function outputCircuit(side, relay) {
  if (relay) return side === 'low'
    ? { coil: ['+12V fused', 'OUT'], load: ['87', 'GND'], feed30: '+12V fused' }
    : { coil: ['OUT', 'GND'], load: ['87', 'GND'], feed30: '+12V fused' }
  return side === 'low' ? { load: ['+12V fused', 'OUT'] } : { load: ['OUT', 'GND'] }
}
