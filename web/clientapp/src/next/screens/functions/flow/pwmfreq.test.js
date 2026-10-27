// node src/next/screens/functions/flow/pwmfreq.test.js — the output sentence names the frequency source of a PWM output
// whose frequency follows a signal (output subs 21-23), and the flow model only offers that port when it is on.
import assert from 'node:assert/strict'
import { sentenceFor } from './sentence.js'

const out = { enabled: true, inputVal: 5, pwmEnabled: true, fixedDuty: 50, variableFreq: true, freqInput: 6, freqInputDenom: 10 }
const nodes = new Map([
  ['input:1', { id: 'input:1', kind: 'input', title: 'Pump switch', enabled: true, outs: [{ prop: 'State', idx: 5, label: 'State' }] }],
  ['caninput:1', { id: 'caninput:1', kind: 'caninput', title: 'Pump speed', enabled: true, outs: [{ prop: 'Value', idx: 6, label: 'Value' }] }],
  ['output:1', { id: 'output:1', kind: 'output', title: 'Pump', enabled: true, row: out, outs: [{ prop: 'On', idx: 10 }] }],
])
const model = { nodes, byIdx: new Map([[5, { kind: 'input', number: 1 }], [6, { kind: 'caninput', number: 1 }]]) }
const txt = () => sentenceFor(model, nodes.get('output:1')).map((s) => s.t ?? s.label).join(' ')

assert.equal(txt(), 'When Pump switch is on → turn on Pump at 50 % with a frequency of Pump speed ÷ 10 Hz .')
out.variableFreq = false
assert.equal(txt(), 'When Pump switch is on → turn on Pump at 50 % .')
out.variableFreq = true; out.freqInput = 0
assert.ok(sentenceFor(model, nodes.get('output:1')).some((s) => s.tok === 'missing' && s.field === 'freqInput'))
console.log('pwmfreq.test OK')

// feat/pwm-ramp-duty-changes (sub 24): only with soft start and a duty from a signal
Object.assign(out, { freqInput: 6, variableFreq: false, variableDutyCycle: true, dutyCycleInput: 6, rampDutyChanges: true, softStart: true, softStartRamp: 2000 })
assert.match(txt(), /\. Duty changes ramp at up to 100 % per 2000 ms \.$/)
out.softStart = false
assert.doesNotMatch(txt(), /ramp/)
out.softStart = true; out.variableDutyCycle = false
assert.doesNotMatch(txt(), /ramp/)
console.log('pwmramp OK')
