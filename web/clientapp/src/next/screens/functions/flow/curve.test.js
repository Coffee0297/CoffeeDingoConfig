// node src/next/screens/functions/flow/curve.test.js — curve block (upstream dingoFW feat/curve-block)
import assert from 'node:assert/strict'
import { curveAt, curveProblem, curvePlot, pickDutyCurve, DUTY_CURVE } from './curve.js'
import { buildModel, slotUsage } from './model.js'
import { sentenceFor } from './sentence.js'
import { createSim } from './sim.js'

// the firmware Sim test's fan curve: 80/90/100 °C → 30/50/100 %
const x = [80, 90, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0], y = [30, 50, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0]
assert.equal(curveAt(3, x, y, 20), 30)     // below: first Y held
assert.equal(curveAt(3, x, y, 85), 40)
assert.equal(curveAt(3, x, y, 95), 75)
assert.equal(curveAt(3, x, y, 100), 100)
assert.equal(curveAt(3, x, y, 150), 100)   // above: last used Y held
assert.equal(curveAt(3, [80, 70, 100], y, 90), 65)   // a point whose X doesn't rise is skipped, as on the module
assert.equal(curveAt(3, [80, 80, 100], y, 90), 65)   // equal X skipped too (no divide by zero)
assert.equal(curveAt(2, x, y, 150), 50)    // only the used points count
assert.equal(curveAt(255, x, y, 150), 100) // more than 12 points never reads past the arrays

assert.equal(curveProblem({ points: 3, x, y }), '')
assert.match(curveProblem({ points: 1, x, y }), /2 to 12/)
assert.match(curveProblem({ points: 13, x, y }), /2 to 12/)
assert.match(curveProblem({ points: 3, x: [80, 70, 100], y }), /point 2 must be above X of point 1/)
assert.match(curveProblem({ points: 2, x: [0, 2e9], y }), /within/)
assert.equal(curveProblem({ ...DUTY_CURVE }), '')

const plot = curvePlot({ points: 2, x: [0, 100], y: [0, 50] }, 200, 80)
assert.equal(plot.pts, '0.0,80.0 200.0,0.0')

// which curve the "duty curve" helper uses: the one already driving the output, else the first free one
const vars = [{ index: 225, kind: 'curve', number: 1 }, { index: 226, kind: 'curve', number: 2 }, { index: 8, kind: 'caninput', number: 1 }]
const curves = [{ number: 1, enabled: true }, { number: 2, enabled: false }]
assert.deepEqual(pickDutyCurve(curves, vars, 225), { number: 1, index: 225, fresh: false })
assert.deepEqual(pickDutyCurve(curves, vars, 8), { number: 2, index: 226, fresh: true })
assert.equal(pickDutyCurve([{ number: 1, enabled: true }], vars, 0), null)
assert.equal(pickDutyCurve(null, vars, 0), null)

// flow model, sentence and the builder's simulator
const dev = { name: 'PDM', type: 'dingoPDM', outputs: [] }
const funcs = { canInputs: [{ number: 1, enabled: true, id: 0x100, bitLength: 8, operator: 2 }], curves: [{ number: 1, name: 'Fan', enabled: true, input: 8, points: 3, x, y }, { number: 2, enabled: false }] }
const vmap = [{ index: 7, kind: 'caninput', number: 1, prop: 'State', type: 'bool', name: 'c1' }, { index: 8, kind: 'caninput', number: 1, prop: 'Value', type: 'float', name: 'c1 Value' },
  { index: 225, kind: 'curve', number: 1, prop: 'Value', type: 'float', name: 'Fan' }, { index: 226, kind: 'curve', number: 2, prop: 'Value', type: 'float', name: 'curve2' }]
const m = buildModel(dev, funcs, vmap)
const n = m.nodes.get('curve:1')
assert.equal(n.kindLabel, 'Curve')
assert.deepEqual(n.incomplete, [])
assert.equal(m.edges.some((e) => e.source === 'caninput:1' && e.target === 'curve:1'), true)
const text = sentenceFor(m, n).map((s) => s.t ?? s.label).join(' ')
assert.match(text, /Fan follows CAN input 1 value along the curve 80 → 30, 90 → 50, 100 → 100/)
assert.deepEqual(slotUsage(dev, funcs, {}).find((r) => r.arr === 'curves'), { label: 'Curves', arr: 'curves', used: 1, max: 2 })
assert.equal(slotUsage(dev, { ...funcs, curves: null }, {}).some((r) => r.arr === 'curves'), false)   // not on this module
assert.deepEqual(buildModel(dev, { ...funcs, curves: [{ ...funcs.curves[0], x: [80, 70, 100] }] }, vmap).nodes.get('curve:1').incomplete, ['X of point 2 must be above X of point 1'])

const sim = createSim(m, {})
sim.setCan('caninput:1', 95); sim.step()
assert.equal(sim.vals[225], 75)
sim.setCan('caninput:1', 20); sim.step()
assert.equal(sim.vals[225], 30)
console.log('curve.test.js ok')
