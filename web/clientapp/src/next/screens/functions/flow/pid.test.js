// PID block: the simulator's pidStep against the firmware's behaviour (functions/pid.cpp, host self-test PID_ONLY),
// pidProblem (the Inspector's validation), the model and the sentence.
import assert from 'node:assert/strict'
import { pidStep, createSim } from './sim.js'
import { pidProblem, buildModel, incompleteReasons } from './model.js'
import { sentenceFor } from './sentence.js'

const base = { enabled: true, kp: 1, ki: 0, kd: 0, iMin: -100, iMax: 100, outMin: 0, outMax: 100, invert: false, spRate: 0, deadband: 0, pvMin: 0, pvMax: 0, fallback: 0, feedForward: 0, periodMs: 20 }
// a first-order plant (pv moves toward the output) on a 1 ms main loop
function run(r, { sp = 50, pv = 0, ms = 20000, plant = 0.002 } = {}) {
  const s = {}
  for (let t = 0; t <= ms; t++) { pidStep(s, r, t, sp, pv, 1, 0); pv += (s.val - pv) * plant }
  return { s, pv }
}

// P only leaves an error; PI removes it
assert.ok(Math.abs(50 - run({ ...base, kp: 1 }).pv) > 10, 'P only keeps a steady-state error')
const pi = run({ ...base, kp: 1, ki: 2 })
assert.ok(Math.abs(50 - pi.pv) < 0.5, `PI reaches the setpoint (pv ${pi.pv})`)

// the period is respected: nothing changes between updates
{ const s = {}; pidStep(s, base, 0, 10, 0, 1, 0); const v = s.val; pidStep(s, base, 5, 90, 0, 1, 0); assert.equal(s.val, v); pidStep(s, base, 20, 90, 0, 1, 0); assert.equal(s.val, 90) }

// saturation: 20 s at the limit keeps I from winding up, and the output leaves the limit at once
{
  const s = {}, r = { ...base, kp: 1, ki: 1 }
  for (let t = 0; t <= 20000; t += 20) pidStep(s, r, t, 1000, 0, 1, 0)
  assert.equal(s.val, 100); assert.equal(s.i, 0)
  pidStep(s, r, 20020, 0, 50, 1, 0); assert.ok(s.val < 100, 'leaves saturation at once')
}
// I clamp
{ const s = {}, r = { ...base, kp: 0, ki: 10, iMax: 30, outMax: 1000 }; for (let t = 0; t <= 5000; t += 20) pidStep(s, r, t, 10, 0, 1, 0); assert.equal(s.i, 30) }

// invert (cooling): the output rises while pv is above sp
{ const s = {}; pidStep(s, { ...base, invert: true, kp: 5 }, 0, 85, 90, 1, 0); assert.equal(s.val, 25) }
// deadband
{ const s = {}; pidStep(s, { ...base, deadband: 3 }, 0, 50, 48, 1, 0); assert.equal(s.val, 0) }
// derivative on measurement: a setpoint step gives no D kick, a pv step does
{
  const r = { ...base, kp: 0, kd: 1 }, s = {}
  pidStep(s, r, 0, 10, 5, 1, 0); pidStep(s, r, 20, 60, 5, 1, 0); assert.ok(s.d === 0)
  pidStep(s, r, 40, 60, 4, 1, 0); assert.ok(Math.abs(s.d - 50) < 1e-9, `D ${s.d}`)
}
// setpoint slew: the ramp starts at pv and moves rate·dt
{ const s = {}, r = { ...base, spRate: 10 }; pidStep(s, r, 0, 100, 20, 1, 0); assert.equal(s.ramp, 20); pidStep(s, r, 1000, 100, 20, 1, 0); assert.equal(s.ramp, 30) }
// activate off: feed-forward only (constant + var), I reset
{ const s = { i: 40 }; pidStep(s, { ...base, feedForward: 20 }, 0, 50, 0, 0, 10); assert.deepEqual([s.val, s.i, s.p], [30, 0, 0]) }
// sensor window / NaN → fallback (clamped to the output limits), I frozen; then control resumes
{
  const s = {}, r = { ...base, ki: 1, pvMin: 1, pvMax: 200, fallback: 150 }
  for (let t = 0; t <= 1000; t += 20) pidStep(s, r, t, 50, 40, 1, 0)
  const i = s.i
  pidStep(s, r, 1020, 50, 0, 1, 0); assert.deepEqual([s.val, s.i, s.fault], [100, i, true])
  pidStep(s, r, 1040, 50, NaN, 1, 0); assert.equal(s.val, 100)
  pidStep(s, r, 1060, 50, 40, 1, 0); assert.equal(s.fault, false); assert.ok(s.val > 0 && s.val < 100)
}
// crossed limits and disabled → 0
{ const s = {}; pidStep(s, { ...base, outMin: 50, outMax: 10 }, 0, 50, 0, 1, 0); assert.equal(s.val, 0) }
{ const s = {}; pidStep(s, { ...base, enabled: false }, 0, 50, 0, 1, 0); assert.equal(s.val, 0) }
// NaN gain: the output stays finite and inside the limits
{ const s = {}; pidStep(s, { ...base, kp: NaN }, 0, 50, 0, 1, 0); assert.ok(Number.isFinite(s.val) && s.val >= 0 && s.val <= 100) }

// validation: what the firmware refuses or runs as disabled
assert.equal(pidProblem(base), '')
assert.match(pidProblem({ ...base, periodMs: 1 }), /2 to 1000/)
assert.match(pidProblem({ ...base, periodMs: 1001 }), /2 to 1000/)
assert.match(pidProblem({ ...base, kp: -1 }), /0 or more/)
assert.match(pidProblem({ ...base, outMin: 60, outMax: 50 }), /output min/)
assert.match(pidProblem({ ...base, iMin: 1, iMax: 0 }), /I min/)
assert.match(pidProblem({ ...base, pvMin: 200, pvMax: 1 }), /window/)
assert.match(pidProblem({ ...base, fallback: 2e6 }), /±1000000/)

// model + simulator + sentence: CAN in 1 = coolant (pv), PID 1 = the template's ramp (Kp 5, ff −425)
const vmap = [{ index: 1, name: 'Always On', kind: 'sys', number: 0, prop: 'Always On', type: 'bool' },
  { index: 40, name: 'coolant', kind: 'caninput', number: 1, prop: 'State', type: 'bool' }, { index: 41, name: 'coolant Value', kind: 'caninput', number: 1, prop: 'Value', type: 'float' },
  ...['Output', 'P', 'I', 'D'].map((prop, k) => ({ index: 225 + k, name: 'fan pid ' + prop, kind: 'pid', number: 1, prop, type: 'float' }))]
const row = { ...base, number: 1, name: 'fan pid', invert: true, kp: 5, processInput: 41, setpointInput: 0, activateInput: 1, feedFwdInput: 0, feedForward: -425, pvMin: 1, pvMax: 200, fallback: 100 }
const funcs = { canInputs: [{ number: 1, name: 'coolant', enabled: true, id: 0x100, bitLength: 8, operator: 2, operand: 0 }], pids: [row] }
const model = buildModel({ type: 'dingoPDM', outputs: [] }, funcs, vmap)
const node = model.nodes.get('pid:1')
assert.deepEqual(node.outs.map((o) => o.prop), ['Output', 'P', 'I', 'D'])
assert.deepEqual(node.ins.map((i) => [i.id, i.optional]), [['setpointInput', true], ['processInput', false], ['activateInput', true], ['feedFwdInput', true]])
assert.deepEqual(incompleteReasons('pid', { ...row, processInput: 0 }, true), ['needs a measured value'])
assert.deepEqual(incompleteReasons('pid', { ...row, outMin: 101 }, true), ['output min is above output max'])
const sim = createSim(model, { 1: true })
sim.setCan('caninput:1', 95); for (let i = 0; i < 4; i++) sim.step(50)
assert.equal(sim.vals[225], 50)   // 5·95 − 425
sim.setCan('caninput:1', 0); sim.step(50)
assert.equal(sim.vals[225], 100); assert.equal(sim.status['pid:1'].text, 'FALLBACK')
const text = sentenceFor(model, node).map((x) => x.t ?? x.label).join(' ')
assert.match(text, /fan pid drives its output 0 to 100 up while coolant value is above 0 : Kp 5/)
assert.match(text, /Outside 1 to 200 it holds 100/)
console.log('pid ok')
