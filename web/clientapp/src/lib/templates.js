// Templates: ready-made circuits (headlights, washer + wipers, blinkers…) whose inputs can be any signal on
// the bus and whose outputs any module's output, optionally through a relay. The logic runs on the module
// that owns most of the outputs (or the one a template pins with `logicOn`); an input from another module
// arrives there as a CAN input decoding its broadcast, and an output on another module follows the logic's
// broadcast the same way.
// A template's build(ctx, sel) runs twice: against previewCtx (records the blocks it would create, for the
// preview and the links drawing) and against liveCtx (creates them). The Circuit Builder in the Wiring tab
// uses the same list.
//
// Field types: bool / num = an input signal, out = an output (load: lamp | motor | pump | horn | fan | load),
// number = a value, op = a comparison, check = a yes/no option. opt = may be left empty.
// In build(ctx, s) an output is its '<guid>:<n>' value: pass it to ctx.wireOutput / ctx.outName as is.

const And = 0, Or = 1   // BoolOperator
const OnDelay = 0, OffDelay = 1   // TimerMode (2 = pulse)
const Eq = 0, Gt = 2    // Operator
// Firmware ranges (core/param_defs.h): flasher on/off 0..5000 ms, timer preset 0..3600000 ms. The device
// NAKs anything out of range, so round + clamp here and "built" means the device really got it.
const ms = (v, max) => Math.min(max, Math.max(0, Math.round(+v || 0)))

export const TEMPLATES = [
  { key: 'headlights', group: 'lights', name: 'Headlights', icon: '💡',
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
  { key: 'washwipe', group: 'wipers', name: 'Washer + wipers', icon: '🌧', logicOn: 'slowOut',
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
      const w = await ctx.wiper({ mode: 0, slowInput: +s.slow, fastInput: +s.fast || 0, interInput: +s.int || 0, onInput: 0, speedInput: 0, swipeInput: 0,
        parkInput: +s.park, parkStopLevel: !!s.parkHigh, washInput: +s.wash, washWipeCycles: Math.round(+s.cycles), name: 'Wipers' })
      await ctx.wireOutput(s.slowOut, w.slow)
      if (s.fastOut) await ctx.wireOutput(s.fastOut, w.fast)
      await ctx.wireOutput(s.pumpOut, +s.wash)
    } },
  { key: 'simple', group: 'accessories', name: 'Simple switched circuit', icon: '🔌', desc: 'One input drives one output directly.',
    fields: [{ k: 'input', t: 'bool', label: 'Driven by' }, { k: 'output', t: 'out', load: 'load', label: 'Output' }],
    build: async (ctx, s) => { await ctx.wireOutput(s.output, +s.input) } },
  { key: 'analog', group: 'accessories', name: 'Analog triggered switch', icon: '📈', desc: 'Output turns on when an analog signal crosses a threshold (creates a Condition).',
    fields: [{ k: 'analog', t: 'num', label: 'Analog signal' }, { k: 'op', t: 'op', label: 'Turn on when it is', def: 2 }, { k: 'thr', t: 'number', label: 'Threshold', def: 0 }, { k: 'output', t: 'out', load: 'load', label: 'Output' }],
    build: async (ctx, s) => { const c = await ctx.condition(+s.analog, +s.op, +s.thr, 'TP ' + ctx.outName(s.output)); await ctx.wireOutput(s.output, c) } },
  { key: 'blinker', group: 'signals', name: 'Blinker / hazard', icon: '↔', desc: 'Left/right (+ optional hazard) blink two outputs. Optional US mode where the rear light is also the brake light (turn signal overrides brake on that side); the high-mount 3rd brake stays independent.',
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
  { key: 'fuelpump', group: 'fuel', name: 'Fuel pump', icon: '⛽', desc: 'Primes on power-up for a moment, then runs while the engine is turning: a run signal (e.g. RPM) above a threshold, and/or a run switch (oil pressure, alternator, ECU pump request).',
    need: [['run', 'runSw']],
    fields: [{ k: 'run', t: 'num', label: 'Run signal (e.g. RPM)', opt: true }, { k: 'runSw', t: 'bool', label: 'Or a run switch (oil pressure / ECU pump request)', opt: true }, { k: 'thr', t: 'number', label: 'Running above', def: 300 },
      { k: 'prime', t: 'number', label: 'Prime time (ms, max 1 h)', def: 3000, min: 0, max: 3600000 }, { k: 'output', t: 'out', load: 'pump', label: 'Pump output' }],
    build: async (ctx, s) => {
      const run = s.run ? await ctx.condition(+s.run, 2, +s.thr, 'TP FuelRun') : 0      // run signal > threshold
      const prime = await ctx.timer(ctx.alwaysOn(), 2, +s.prime, 'TP Prime')             // one pulse at power-up (Timer, pulse mode)
      await ctx.wireOutput(s.output, await ctx.anyOf([run, +s.runSw || 0, prime], 'TP FuelPump'))
    } },
  { key: 'wipers', group: 'wipers', name: 'Wipers, simple (no park switch)', icon: '🌂', desc: 'Low/High run the wiper output; Intermittent pulses it on a gap. Combines whatever you provide. For a motor with a park switch use Washer + wipers.',
    fields: [{ k: 'low', t: 'bool', label: 'Low / On' }, { k: 'high', t: 'bool', label: 'High', opt: true },
      { k: 'int', t: 'bool', label: 'Intermittent', opt: true }, { k: 'intRate', t: 'number', label: 'Intermittent gap (ms, max 5000)', def: 3000, min: 0, max: 5000 },
      { k: 'output', t: 'out', load: 'motor', label: 'Wiper output' }],
    build: async (ctx, s) => {
      const flInt = s.int ? await ctx.flasher(+s.int, 700, +s.intRate, 'TP WipeInt') : 0
      await ctx.wireOutput(s.output, await ctx.anyOf([+s.low, +s.high || 0, flInt], 'TP Wipers'))
    } },
  { key: 'afterrun', group: 'accessories', name: 'After-run (stay on after switch-off)', icon: '⏲', desc: 'Output follows a trigger and keeps running for a hold time after it drops — radiator fan or turbo cooling after ignition off, courtesy light after the door closes (creates an off-delay Timer).',
    fields: [{ k: 'trig', t: 'bool', label: 'Trigger' }, { k: 'hold', t: 'number', label: 'Hold after off (ms, max 1 h)', def: 60000, min: 0, max: 3600000 }, { k: 'output', t: 'out', load: 'fan', label: 'Output' }],
    build: async (ctx, s) => { await ctx.wireOutput(s.output, await ctx.timer(+s.trig, 1, +s.hold, 'TP ' + ctx.outName(s.output) + ' Hold')) } },
  { key: 'pwmfan', group: 'cooling', name: 'PWM fan (duty from analog)', icon: '🌀', logicOn: 'output', desc: 'Fan output runs PWM with its duty following an analog signal (e.g. a temp sensor), with soft start. CANBoard outputs only — set a PDM output’s variable duty in its output editor.',
    fields: [{ k: 'analog', t: 'num', label: 'Duty source (e.g. temperature)' }, { k: 'full', t: 'number', label: 'Signal value at 100% duty', def: 5000 },
      { k: 'min', t: 'number', label: 'Min duty (%)', def: 0 }, { k: 'freq', t: 'number', label: 'PWM frequency (Hz)', def: 200 }, { k: 'output', t: 'out', load: 'fan', label: 'Fan output' }],
    build: async (ctx, s) => { await ctx.setOutputPwm(s.output, { source: +s.analog, full: +s.full, min: +s.min, freq: +s.freq }) } },
]

// More ready-made circuits (appended so the existing keys keep their order).
TEMPLATES.push(
  { key: 'relaywipe', group: 'wipers', name: 'Wipers, relay-switched (self-park / Ford concealed)', icon: '🚘', logicOn: 'runOut',
    desc: 'A motor with its own park circuit, switched by a RUN relay (and a FAST relay for high speed) while it keeps its supply: open RUN and the motor parks itself. Intermittent and after-wash wipes close RUN for a set time. Ford concealed (depressed) park: when RUN opens the motor REVERSES the blades down into the hidden park, so RUN is held for whole sweeps and the supply stays on after ignition off until it has parked.',
    need: [['low', 'pos']],
    fields: [
      { k: 'low', t: 'bool', label: 'Wiper switch: low / on', opt: true },
      { k: 'high', t: 'bool', label: 'Wiper switch: high', opt: true },
      { k: 'int', t: 'bool', label: 'Wiper switch: intermittent', opt: true },
      { k: 'pos', t: 'num', label: 'Or a rotary wiper switch (its position signal)', opt: true },
      { k: 'posInt', t: 'number', label: 'Rotary: intermittent position', def: 1 },
      { k: 'posLow', t: 'number', label: 'Rotary: low position', def: 2 },
      { k: 'posHigh', t: 'number', label: 'Rotary: high position', def: 3 },
      { k: 'wash', t: 'bool', label: 'Wash button', opt: true },
      { k: 'ign', t: 'bool', label: 'Ignition (wipers only with it on)', opt: true },
      { k: 'ford', t: 'check', label: 'Ford concealed park: the motor reverses into the hidden park' },
      { k: 'sweep', t: 'number', label: 'One full low-speed sweep (ms; measure it, Ford needs the whole sweep)', def: 1500, min: 200, max: 5000 },
      { k: 'gap', t: 'number', label: 'Intermittent gap (ms, max 5000)', def: 3000, min: 0, max: 5000 },
      { k: 'washWipes', t: 'number', label: 'Wipes after washing (0–5)', def: 2, min: 0, max: 5 },
      { k: 'hold', t: 'number', label: 'Supply held after ignition off so it can park (ms)', def: 3000, min: 0, max: 60000 },
      { k: 'runOut', t: 'out', load: 'motor', label: 'RUN relay (motor on; open = park)' },
      { k: 'fastOut', t: 'out', load: 'motor', label: 'FAST relay (high speed)', opt: true },
      { k: 'supplyOut', t: 'out', load: 'motor', label: 'Motor supply (feeds the park circuit)', opt: true },
      { k: 'pumpOut', t: 'out', load: 'pump', label: 'Washer pump', opt: true }],
    build: async (ctx, s) => {
      if (s.fastOut && !s.high && !s.pos) throw new Error('The FAST relay needs a high-speed switch')
      if (s.pumpOut && !s.wash) throw new Error('The washer pump needs a wash button')
      const ign = +s.ign || 0, sweep = +s.sweep, wash = +s.wash || 0
      // a rotary stalk: each position is a Condition (position == n), combined with any separate switch
      const at = async (p, nm) => (s.pos ? ctx.condition(+s.pos, Eq, +p, 'TP Wipe' + nm) : 0)
      const low = await ctx.anyOf([+s.low || 0, await at(s.posLow, 'Low')], 'TP WipeLowSw')
      const high = await ctx.anyOf([+s.high || 0, await at(s.posHigh, 'High')], 'TP WipeHighSw')
      const int = await ctx.anyOf([+s.int || 0, await at(s.posInt, 'Int')], 'TP WipeIntSw')
      // Standard self-park: a short kick, the park contact finishes the wipe. Ford: RUN must cover a whole
      // sweep, or the park circuit reverses the blade back down mid-wipe.
      const kick = int ? await ctx.flasher(int, s.ford ? sweep : 400, +s.gap, 'TP WipeInt') : 0
      const afterWash = wash && +s.washWipes > 0 ? await ctx.timer(wash, OffDelay, Math.round(+s.washWipes * sweep), 'TP WashWipe') : wash
      const any = await ctx.anyOf([low, high, kick, afterWash], 'TP Wipe')
      await ctx.wireOutput(s.runOut, ign ? await ctx.virtual({ v0: any, op0: And, v1: ign }, 'TP WipeRun') : any)
      if (s.fastOut) await ctx.wireOutput(s.fastOut, ign ? await ctx.virtual({ v0: high, op0: And, v1: ign }, 'TP WipeFast') : high)
      if (s.supplyOut) {
        // with ignition: fed while it (or the washer) is on, then for `hold` so a wipe in progress can park
        const feed = ign ? await ctx.anyOf([ign, wash], 'TP WipeFeed') : 0
        await ctx.wireOutput(s.supplyOut, !ign ? ctx.alwaysOn() : +s.hold > 0 ? await ctx.timer(feed, OffDelay, +s.hold, 'TP WipeSupply') : feed)
      }
      if (s.pumpOut) await ctx.wireOutput(s.pumpOut, wash)
    } },
  { key: 'interior', group: 'lights', name: 'Interior / courtesy light', icon: '🚪',
    desc: 'On while any door is open and for a delay after the last one closes. With ignition picked, the delay is cut short when the ignition comes on (an open door still lights it).',
    fields: [{ k: 'door1', t: 'bool', label: 'Door switch' }, { k: 'door2', t: 'bool', label: 'Door switch 2', opt: true }, { k: 'door3', t: 'bool', label: 'Door switch 3 (tailgate)', opt: true },
      { k: 'delay', t: 'number', label: 'Stay on after closing (ms, max 1 h)', def: 15000, min: 0, max: 3600000 },
      { k: 'ign', t: 'bool', label: 'Ignition (cancels the delay)', opt: true },
      { k: 'output', t: 'out', load: 'lamp', label: 'Interior light' }, { k: 'output2', t: 'out', load: 'lamp', label: 'Second light', opt: true }],
    build: async (ctx, s) => {
      const door = await ctx.anyOf([+s.door1, +s.door2 || 0, +s.door3 || 0], 'TP Door')
      const held = await ctx.timer(door, OffDelay, +s.delay, 'TP DoorHold')
      const light = s.ign ? await ctx.anyOf([door, await ctx.virtual({ v0: held, op0: And, v1: +s.ign, not1: true }, 'TP DoorFade')], 'TP Courtesy') : held
      await ctx.wireOutput(s.output, light)
      if (s.output2) await ctx.wireOutput(s.output2, light)
    } },
  { key: 'reverse', group: 'lights', name: 'Reverse lights', icon: '⏪',
    desc: 'On in reverse: from a gear signal (a gear-selector rotary position, or a TCU value) equal to the reverse value, and/or a reverse switch.',
    need: [['gear', 'sw']],
    fields: [{ k: 'gear', t: 'num', label: 'Gear signal (e.g. selector rotary position)', opt: true },
      { k: 'rev', t: 'number', label: 'Reverse is when the gear signal equals', def: 1 },
      { k: 'sw', t: 'bool', label: 'Or a reverse switch', opt: true },
      { k: 'ign', t: 'bool', label: 'Ignition (only with it on)', opt: true },
      { k: 'left', t: 'out', load: 'lamp', label: 'Reverse light (left, or both)' }, { k: 'right', t: 'out', load: 'lamp', label: 'Reverse light right', opt: true }],
    build: async (ctx, s) => {
      const g = s.gear ? await ctx.condition(+s.gear, Eq, +s.rev, 'TP Reverse') : 0
      let on = await ctx.anyOf([g, +s.sw || 0], 'TP ReverseAny')
      if (s.ign) on = await ctx.virtual({ v0: on, op0: And, v1: +s.ign }, 'TP ReverseIgn')
      await ctx.wireOutput(s.left, on)
      if (s.right) await ctx.wireOutput(s.right, on)
    } },
  { key: 'brake', group: 'lights', name: 'Brake lights', icon: '🛑',
    desc: 'Brake switch to the brake lights and the high-mount 3rd brake light. (For US rear lamps that are both turn signal and brake light, use Blinker / hazard in US mode.)',
    fields: [{ k: 'brake', t: 'bool', label: 'Brake switch' },
      { k: 'left', t: 'out', load: 'lamp', label: 'Brake light (left, or both)' }, { k: 'right', t: 'out', load: 'lamp', label: 'Brake light right', opt: true },
      { k: 'third', t: 'out', load: 'lamp', label: '3rd (high-mount) brake light', opt: true }],
    build: async (ctx, s) => { for (const k of ['left', 'right', 'third']) if (s[k]) await ctx.wireOutput(s[k], +s.brake) } },
  { key: 'radfan', group: 'cooling', name: 'Radiator fan (temperature, A/C, after-run)', icon: '🌡',
    desc: 'Fan on above a temperature and off again below a lower one (hysteresis, so it does not chatter), and whenever the A/C asks for it. With ignition picked it runs only with the ignition on, plus an after-run time after switch-off while it is still hot.',
    fields: [{ k: 'temp', t: 'num', label: 'Coolant temperature signal' },
      { k: 'on', t: 'number', label: 'Fan on above', def: 95 }, { k: 'off', t: 'number', label: 'Fan off below', def: 90 },
      { k: 'ac', t: 'bool', label: 'A/C fan request', opt: true },
      { k: 'ign', t: 'bool', label: 'Ignition', opt: true },
      { k: 'hold', t: 'number', label: 'After-run after ignition off (ms, max 1 h)', def: 120000, min: 0, max: 3600000 },
      { k: 'output', t: 'out', load: 'fan', label: 'Fan output' }, { k: 'output2', t: 'out', load: 'fan', label: 'Second fan', opt: true }],
    build: async (ctx, s) => {
      if (+s.off >= +s.on) throw new Error('“Fan off below” must be lower than “Fan on above”')
      const hot = await ctx.condition(+s.temp, Gt, +s.on, 'TP FanHot', +s.off)
      let fan = await ctx.anyOf([hot, +s.ac || 0], 'TP FanDemand')
      if (s.ign) fan = await ctx.virtual({ v0: fan, op0: And, v1: +s.hold > 0 ? await ctx.timer(+s.ign, OffDelay, +s.hold, 'TP FanAfter') : +s.ign }, 'TP Fan')
      await ctx.wireOutput(s.output, fan)
      if (s.output2) await ctx.wireOutput(s.output2, fan)
    } },
  { key: 'starter', group: 'power', name: 'Starter (interlock + crank limit)', icon: '🔑',
    desc: 'Cranks while the start button is held with the ignition on: only in neutral / with the clutch down if you pick that switch, never while the engine already runs, and never longer than the crank limit (release the button to try again).',
    fields: [{ k: 'start', t: 'bool', label: 'Start button' }, { k: 'ign', t: 'bool', label: 'Ignition' },
      { k: 'neutral', t: 'bool', label: 'Neutral / clutch switch (must be on to crank)', opt: true },
      { k: 'running', t: 'bool', label: 'Engine running (blocks cranking)', opt: true },
      { k: 'limit', t: 'number', label: 'Crank limit (ms, max 1 h)', def: 8000, min: 0, max: 3600000 },
      { k: 'output', t: 'out', load: 'motor', label: 'Starter solenoid / relay' }],
    build: async (ctx, s) => {
      const req = await ctx.allOf([+s.start, +s.ign, +s.neutral || 0], 'TP StartReq')
      const tooLong = await ctx.timer(req, OnDelay, +s.limit, 'TP CrankLimit')
      await ctx.wireOutput(s.output, await ctx.allOf([req, { v: tooLong, not: true }, { v: +s.running || 0, not: true }], 'TP Crank'))
    } },
  { key: 'drl', group: 'lights', name: 'Daytime running lights', icon: '🔆',
    desc: 'On with the ignition (optionally only once the engine runs) and off while the headlights are on.',
    fields: [{ k: 'ign', t: 'bool', label: 'Ignition' }, { k: 'lights', t: 'bool', label: 'Headlights on (DRL off)', opt: true },
      { k: 'running', t: 'bool', label: 'Engine running (DRL only then)', opt: true },
      { k: 'left', t: 'out', load: 'lamp', label: 'DRL (left, or both)' }, { k: 'right', t: 'out', load: 'lamp', label: 'DRL right', opt: true }],
    build: async (ctx, s) => {
      const drl = await ctx.allOf([+s.ign, +s.running || 0, { v: +s.lights || 0, not: true }], 'TP DRL')
      await ctx.wireOutput(s.left, drl)
      if (s.right) await ctx.wireOutput(s.right, drl)
    } },
  { key: 'toggle', group: 'accessories', name: 'Push-button toggle (latching)', icon: '🔘',
    desc: 'Each press of a momentary button turns the output on, the next one off (light bar, aux lights, heated screen). Optionally it switches off when another signal goes off, e.g. the ignition.',
    fields: [{ k: 'button', t: 'bool', label: 'Push button' }, { k: 'reset', t: 'bool', label: 'Off when this goes off (e.g. ignition)', opt: true },
      { k: 'output', t: 'out', load: 'load', label: 'Output' }, { k: 'output2', t: 'out', load: 'load', label: 'Second output', opt: true }],
    build: async (ctx, s) => {
      const on = await ctx.counter({ inc: +s.button, reset: +s.reset || 0, resetEdge: 1, min: 0, max: 1, wrap: true }, 'TP Toggle')
      await ctx.wireOutput(s.output, on)
      if (s.output2) await ctx.wireOutput(s.output2, on)
    } },
  { key: 'reminder', group: 'lights', name: 'Lights-on reminder', icon: '🔔',
    desc: 'Beeps a buzzer while the lights are on with the ignition off (and the door open, if you pick a door switch).',
    fields: [{ k: 'lights', t: 'bool', label: 'Lights on' }, { k: 'ign', t: 'bool', label: 'Ignition' }, { k: 'door', t: 'bool', label: 'Door switch (only while open)', opt: true },
      { k: 'output', t: 'out', load: 'horn', label: 'Buzzer / chime' }],
    build: async (ctx, s) => {
      const warn = await ctx.allOf([+s.lights, { v: +s.ign, not: true }, +s.door || 0], 'TP LightsOn')
      await ctx.wireOutput(s.output, await ctx.flasher(warn, 300, 300, 'TP Chime'))
    } },
  // The PID block takes its setpoint from a signal only, so the fan ramp uses setpoint 0 + a negative feed-forward:
  // duty = Kp·(temp − start) with Kp = 100 / (full − start), clamped 0..100 %. Ki stays 0 (it would integrate temp).
  { key: 'pidfan', group: 'cooling', name: 'Fan by coolant temperature (PID)', icon: '🌀', logicOn: 'output',
    desc: 'The fan speed (PWM duty) follows the coolant temperature: 0 % at the start temperature, rising to 100 % at the full-speed temperature. If the temperature signal is lost (a CAN frame that stops reads 0) or out of range, the fan runs at 100 %. Needs a dingoPDM whose firmware has the PID block, and a fan output on that module.',
    fields: [{ k: 'temp', t: 'num', label: 'Coolant temperature signal' },
      { k: 'start', t: 'number', label: 'Fan starts at', def: 85 }, { k: 'full', t: 'number', label: 'Full speed at', def: 100 },
      { k: 'ign', t: 'bool', label: 'Ignition (fan only with it on)', opt: true },
      { k: 'output', t: 'out', load: 'fan', label: 'Fan output (PWM)' }],
    build: async (ctx, s) => {
      if (+s.full <= +s.start) throw new Error('“Full speed at” must be above “Fan starts at”')
      const kp = 100 / (+s.full - +s.start)
      const pid = await ctx.pid({ setpointInput: 0, processInput: +s.temp, activateInput: ctx.alwaysOn(), feedForward: -kp * +s.start, feedFwdInput: 0,
        kp, ki: 0, kd: 0, iMin: -100, iMax: 100, outMin: 0, outMax: 100, invert: true, spRate: 0, deadband: 0,
        pvMin: 1, pvMax: 200, fallback: 100, periodMs: 100 }, 'TP Fan PID', `${s.start}–${s.full} → 0–100 %`)
      await ctx.outputDuty(s.output, pid, +s.ign || ctx.alwaysOn())
    } },
)

export const OPS = [{ v: 2, t: 'greater than' }, { v: 3, t: 'less than' }, { v: 4, t: '≥' }, { v: 5, t: '≤' }, { v: 0, t: 'equals' }]
export const isInput = (f) => f.t === 'bool' || f.t === 'num'
export const blank = (v) => v === '' || v == null

// Default selection for a template (each field's def, '' otherwise).
export function defaults(tpl) { const s = {}; for (const f of tpl.fields) s[f.k] = f.def ?? (f.t === 'check' ? false : ''); return s }

// Missing required fields / out-of-range numbers, as one message, or '' when ready.
export function validate(tpl, sel) {
  const missing = tpl.fields.filter((f) => !f.opt && f.t !== 'check' && blank(sel[f.k]))
  if (missing.length) return 'Fill in: ' + missing.map((f) => f.label).join(', ')
  const none = (tpl.need ?? []).find((ks) => ks.every((k) => blank(sel[k])))   // at least one of these
  if (none) return 'Fill in one of: ' + none.map((k) => tpl.fields.find((f) => f.k === k).label).join(' or ')
  const bad = tpl.fields.find((f) => f.t === 'number' && f.max != null && (+sel[f.k] < (f.min ?? 0) || +sel[f.k] > f.max))
  if (bad) return `${bad.label}: must be ${bad.min ?? 0}–${bad.max} (the module rejects anything outside).`
  const outs = tpl.fields.filter((f) => f.t === 'out' && !blank(sel[f.k])).map((f) => String(sel[f.k]))
  if (new Set(outs).size !== outs.length) return 'The same output is picked twice.'
  return ''
}

// OR / AND-combine source vars (1 → passthrough, 2/3 → one VirtualInput, more → chained). Shared by both
// ctx kinds. Left-out (0) terms are dropped, never passed on: the firmware reads var0 and var1 always (index
// 0 is a constant 0, so an empty middle slot makes an AND always false) and skips only var2 == 0.
const withAnyOf = (ctx) => Object.assign(ctx, {
  // terms: var indices or {v, not}
  allOf: async (terms, name) => {
    const t = terms.map((x) => (typeof x === 'object' ? x : { v: x })).filter((x) => x.v > 0)
    if (!t.length) return ctx.alwaysOn()
    if (t.length === 1) return t[0].not ? ctx.virtual({ v0: t[0].v, not0: true, op0: And, v1: ctx.alwaysOn() }, name) : t[0].v
    if (t.length > 3) return ctx.allOf([await ctx.allOf(t.slice(0, 3), name + ' A'), ...t.slice(3)], name)
    return ctx.virtual({ v0: t[0].v, not0: !!t[0].not, op0: And, v1: t[1].v, not1: !!t[1].not, op1: And, v2: t[2]?.v ?? 0, not2: !!t[2]?.not }, name)
  },
  anyOf: async (vars, name) => {
    const v = vars.filter((x) => x > 0)
    // more than 3: OR the first three, then chain
    if (v.length > 3) return ctx.anyOf([await ctx.virtual({ v0: v[0], op0: Or, v1: v[1], op1: Or, v2: v[2] }, name + ' A'), ...v.slice(3)], name)
    return v.length <= 1 ? (v[0] ?? 0) : ctx.virtual({ v0: v[0], op0: Or, v1: v[1], op1: Or, v2: v[2] ?? 0 }, name)
  },
})

// ---- Preview: run build without touching a module. Every signal is a token (a fake index > 0); every
// block it would create becomes an op {id, op, name, ins: [node ids], detail}; every output wire a {out, src}.
// Node ids: 'in:<field>' for a template input, 'on' for Always On, 'op<n>' for a created block.
const TOK_OP = 100000, TOK_IN = 200000
export async function previewTemplate(tpl, sel, outName = (o) => 'output ' + o) {
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
    condition: async (input, o, arg, name, argOff = arg) => op('condition', name, ids(input), `${OPS.find((x) => x.v === o)?.t ?? 'op ' + o} ${arg}` + (argOff !== arg ? `, off at ${argOff}` : '')),
    counter: async (c, name) => op('counter', name, ids(c.inc, c.reset), c.wrap && c.max === 1 ? 'toggle' : `count ${c.min}–${c.max}`),
    flasher: async (input, on, off, name) => op('flasher', name, ids(input), `${ms(on, 5000)} / ${ms(off, 5000)} ms`),
    timer: async (input, mode, preset, name) => op('timer', name, ids(input), `${['on-delay', 'off-delay', 'pulse'][mode]} ${ms(preset, 3600000)} ms`),
    virtual: async (c, name) => op('virtual', name, ids(c.v0, c.v1, c.v2), virtualText(c)),
    wireOutput: async (o, src) => { wires.push({ out: o, src: ids(src)[0] ?? null }) },
    setOutputPwm: async (o, { source }) => { wires.push({ out: o, src: ids(source)[0] ?? null, pwm: true }) },
    pid: async (c, name, detail) => op('pid', name, ids(c.processInput, c.setpointInput), detail ?? 'PID'),
    outputDuty: async (o, duty) => { wires.push({ out: o, src: ids(duty)[0] ?? null, pwm: true }) },
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
const ARR = { condition: 'conditions', flasher: 'flashers', timer: 'timers', virtual: 'virtualInputs', counter: 'counters', pid: 'pids' }
const countNeeds = (ops) => ops.reduce((m, o) => { const a = ARR[o.op]; if (a) m[a] = (m[a] ?? 0) + 1; return m }, {})

// Free-slot shortfalls on the logic module for a preview, e.g. ['2 timers (1 free)']. freed = {arr: n} slots an
// edit gives back first (the old version's blocks, see freedBy).
export function shortfalls(need, funcs, freed = {}) {
  const out = []
  for (const [arr, n] of Object.entries(need)) {
    const free = (funcs?.[arr] ?? []).filter((x) => !x.enabled).length + (freed[arr] ?? 0)
    if (free < n) out.push(`${n} ${arr} (${free} free)`)
  }
  return out
}

// Slots an applied instance holds, per module: {guid: {virtualInputs: 2, canInputs: 1, …}} — an edit frees them
// before it rebuilds, so its preview counts them as free.
const SLOT_ARR = { virtualinput: 'virtualInputs', condition: 'conditions', flasher: 'flashers', timer: 'timers', counter: 'counters', caninput: 'canInputs', pid: 'pids' }
export function freedBy(inst) {
  const m = {}
  for (const c of inst?.created ?? []) { const a = SLOT_ARR[c.kind], g = c.guid ?? inst.guid; if (a) { m[g] ??= {}; m[g][a] = (m[g][a] ?? 0) + 1 } }
  return m
}

// ---- Live: create the blocks on module `guid`. env = {api, guid, wireOutput(out, idx), isCanboard,
// outName(out)} with out = an output's '<guid>:<n>' value; created / wired collect what was made, so the
// instance can be removed later.
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
    created.push({ kind, number: slot.number, before: slot })   // what the slot held, put back on remove
    await refresh()
    const i = idxOf(kind, slot.number, prop)
    if (i == null) throw new Error(`couldn't resolve ${kind} ${slot.number}'s signal index`)
    return i
  }
  const ctx = withAnyOf({
    created, wired, outName: env.outName ?? ((n) => 'output' + n),
    alwaysOn: () => vmap.find((v) => v.name === 'Always On')?.index ?? 1,
    // Every field is set: a free slot keeps whatever it held before (a leftover argOff is a hysteresis release
    // point — e.g. argOff 2 on a '> 2500' never lets the output turn off).
    // argOff = the release point (hysteresis); the same as arg = none
    condition: (input, operator, arg, name, argOff = arg) => make('condition', 'conditions', 'Value', { input, operator, arg: +arg || 0, argOff: +argOff || 0, name }),
    // edges: 0 rising, 1 falling (InputEdge)
    counter: (c, name) => make('counter', 'counters', 'Value', { incInput: c.inc, decInput: 0, resetInput: c.reset ?? 0, minCount: c.min ?? 0, maxCount: c.max ?? 1,
      incEdge: 0, decEdge: 0, resetEdge: c.resetEdge ?? 0, wrapAround: !!c.wrap, holdToReset: false, resetTime: 2000, name }),
    flasher: (input, on, off, name, single = false) => make('flasher', 'flashers', 'State', { input, onTime: ms(on, 5000), offTime: ms(off, 5000), single, name }),
    // mode: 0 on-delay, 1 off-delay, 2 pulse (firmware TimerMode)
    timer: (input, mode, preset, name) => make('timer', 'timers', 'State', { input, mode, edge: 0, preset: ms(preset, 3600000), name }),
    virtual: (c, name) => make('virtualinput', 'virtualInputs', 'State', { not0: !!c.not0, var0: c.v0 ?? 0, cond0: c.op0 ?? And, not1: !!c.not1, var1: c.v1 ?? 0, cond1: c.op1 ?? And, not2: !!c.not2, var2: c.v2 ?? 0, mode: 0, name }),
    wireOutput: async (o, src) => { await env.wireOutput(o, src); wired.push(o) },
    // Configure a CANBoard digital output for variable-duty PWM from an analog source + soft start.
    setOutputPwm: async (o, { source, full, min, freq, on }) => {
      const [g, n] = String(o).includes(':') ? String(o).split(':') : [guid, o]   // the Circuit Builder passes a bare n
      if (!env.isCanboard || g !== guid) throw new Error('PWM-from-analog is wired on CANBoard outputs; for a PDM output set it in the output editor')
      await api.setFunction(guid, 'digitaloutput', +n, { enabled: true, input: on ?? ctx.alwaysOn(), pwmEnabled: true, variableDutyCycle: true, dutyCycleInput: source, dutyCycleDenominator: Math.max(1, Math.round(full / 100)), minDutyCycle: min, frequency: freq, variableFreq: false, freqInput: 0, rampDutyChanges: false, softStartEnabled: true, softStartRampTime: 500 })
      wired.push(o)
    },
    // A PID block (upstream dingoFW with the PID feature, PDMs only); returns its Output signal.
    pid: (c, name) => {
      if (!funcs?.pids) throw new Error('This module has no PID block: it needs a dingoPDM whose firmware has the PID feature')
      return make('pid', 'pids', 'Output', { ...c, name })
    },
    // A PDM output on this module: on from `on`, PWM with its duty from `duty` (a 0–100 % signal, denominator 1).
    outputDuty: async (o, duty, on) => {
      const [g] = String(o).split(':')
      if (env.isCanboard || g !== guid || !env.outputDuty) throw new Error('The fan output must be a dingoPDM output on the module that runs the PID')
      await env.outputDuty(o, duty, on)
      wired.push(o)
    },
    // The native wiper block (a singleton, PDM only).
    wiper: async (cfg) => {
      if (!funcs?.wiper) throw new Error('This module has no wiper block — wipers need a dingoPDM')
      if (funcs.wiper.enabled) throw new Error('The wiper block on this module is already in use — remove that first')
      await api.setFunction(guid, 'wiper', 1, { enabled: true, ...cfg })
      created.push({ kind: 'wiper', number: 1, before: funcs.wiper })
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

// Where the logic runs: the module of the template's `logicOn` output (one that needs that module's own
// hardware — the wiper block, PWM) when picked, else the module owning most picked outputs (ties: the first
// picked). Outputs on other modules follow the logic over CAN.
export function logicModule(tpl, sel) {
  const g = (k) => String(sel[k]).split(':')[0]
  if (tpl.logicOn && !blank(sel[tpl.logicOn])) return { guid: g(tpl.logicOn) }
  const n = new Map()
  for (const f of tpl.fields) if (f.t === 'out' && !blank(sel[f.k])) n.set(g(f.k), (n.get(g(f.k)) ?? 0) + 1)
  let best = null; for (const [k, c] of n) if (best == null || c > n.get(best)) best = k
  return { guid: best }
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
