// Self-check: `node pinmap.test.js`. Pins as drawn in the dingoPDM v7.5, dingoPDM-Max v1.2 and CANBoard v2 schematics.
import assert from 'node:assert/strict'
import { boardOf, pinFor, pinFromSignal, pinSearchText } from './pinmap.js'

const pdm = { type: 'dingoPDM' }, max = { type: 'dingoPDM-Max' }, cb = { type: 'CANBoard' }

// dingoPDM: Deutsch DT 12-pin J3, high-side outputs
assert.equal(pinFor(pdm, 'input', 1).label, 'J3-8')
assert.equal(pinFor(pdm, 'input', 2).label, 'J3-11')
assert.equal(pinFor(pdm, 'output', 1).label, 'J3-7')
assert.equal(pinFor(pdm, 'output', 2).label, 'J3-12')
assert.equal(pinFor(pdm, 'output', 8).label, 'J3-3')
assert.equal(pinFor(pdm, 'output', 3).side, 'high')
assert.equal(pinFor(pdm, 'input', 3), null)                 // only two digital inputs
assert.equal(pinFromSignal(pdm, 'Output4.Current').label, 'J3-9')

// CANBoard: J2 analog, J3 digital, J4 low-side outputs
assert.equal(pinFor(cb, 'input', 5).label, 'J3-5')
assert.equal(pinFor(cb, 'analoginput', 4).label, 'J2-6')
assert.equal(pinFor(cb, 'digitaloutput', 1).label, 'J4-2')
assert.equal(pinFor(cb, 'digitaloutput', 4).side, 'low')
assert.equal(pinFromSignal(cb, 'DigitalInput3.State').label, 'J3-3')
assert.equal(pinFromSignal(cb, 'RotarySwitch2').label, 'J2-3')
assert.equal(pinFromSignal(cb, 'AnalogInput5.Millivolts').label, 'J2-8')

// dingoPDM-Max v1.2: Deutsch DT 12-pin J4, each output on two pins, not in order
assert.equal(pinFor(max, 'output', 1).label, 'J4-7/8')
assert.equal(pinFor(max, 'output', 4).label, 'J4-1/2')
assert.equal(pinFor(max, 'output', 2).side, 'high')
assert.equal(pinFor(max, 'output', 5), null)                 // four outputs
assert.equal(pinFor(max, 'input', 2).label, 'J4-10')
assert.match(pinSearchText(pinFor(max, 'output', 3)), /J4-5 .*J4-6 /)
assert.equal(boardOf({ type: 'dingoPDM', pdmType: 1 }).name, 'dingoPDM-Max')

// Logic functions have no pin
assert.equal(pinFor(cb, 'condition', 1), null)
assert.equal(pinFromSignal(cb, 'BatteryVoltage'), null)

assert.match(pinSearchText(pinFor(cb, 'input', 7)), /J3-7.*pin 7/)
console.log('pinmap ok')
