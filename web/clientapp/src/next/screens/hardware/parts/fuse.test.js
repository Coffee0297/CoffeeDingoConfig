// node src/next/screens/hardware/parts/fuse.test.js
import assert from 'node:assert/strict'
import { simulate, summary, windowMs, thin, loadFromName, loadCurrent } from './fuse.js'

const f = (o) => ({ currentLimit: 10, inrushLimit: 40, inrushTime: 500, resetMode: 0, resetCountLimit: 3, resetTime: 1000, ...o })

// a lamp of 5 A peaks at 35 A: inside 40 A inrush → runs
let s = simulate(f(), 'lamp', 5, 1000)
assert.equal(s.trips.length, 0); assert.equal(s.fault, null)
assert.match(summary(s, 'lamp', 5, f()), /runs without tripping/)
assert.equal(s.limit[0], 40); assert.equal(s.limit[s.limit.length - 1], 10, 'inrush limit, then the trip current')

// inrush allowed 20 A: trips at once and latches (reset mode 0)
s = simulate(f({ inrushLimit: 20 }), 'lamp', 5, 1000)
assert.equal(s.trips.length, 1); assert.equal(s.trips[0].t, 0); assert.ok(s.trips[0].inrush)
assert.equal(s.fault, 2, 'latched on the next loop')
assert.ok(s.flow.slice(1).every((a) => a === 0), 'nothing flows after the latch')
assert.match(summary(s, 'lamp', 5, f({ inrushLimit: 20 })), /trips at once .*inrush allowed 20 A.* stays off/)

// no inrush window: the steady limit applies from turn-on
s = simulate(f({ inrushTime: 0 }), 'motor', 6, 1000)
assert.equal(s.trips[0].t, 0); assert.equal(s.trips[0].limit, 10); assert.ok(!s.trips[0].inrush)

// a motor still above the limit when the inrush window ends trips then
s = simulate(f({ inrushTime: 100 }), 'motor', 6, 1000)
assert.equal(s.trips[0].t, 100); assert.ok(loadCurrent('motor', 6, 100) > 10)

// retry 3 times, then fault; each retry restarts the inrush window
s = simulate(f({ inrushLimit: 20, resetMode: 1, resetTime: 200 }), 'lamp', 5, 2000)
assert.equal(s.trips.length, 3); assert.ok(s.fault > s.trips[2].t)
assert.ok(s.trips.every((x) => x.inrush))
assert.match(summary(s, 'lamp', 5, f({ inrushLimit: 20, resetMode: 1 })), /retries 2 times and stays off/)

// endless: keeps retrying, never a fault
s = simulate(f({ currentLimit: 4, inrushTime: 0, resetMode: 2, resetTime: 100 }), 'steady', 5, 1000)
assert.ok(s.trips.length >= 8); assert.equal(s.fault, null)
assert.match(summary(s, 'steady', 5, f({ resetMode: 2, resetTime: 100 })), /keeps retrying every 100 ms/)

// dead short: latches at once during inrush, no retry even in endless mode
s = simulate(f({ hardShortLimit: 30, resetMode: 2, resetTime: 100 }), 'lamp', 5, 1000)
assert.equal(s.trips.length, 1); assert.ok(s.trips[0].hard); assert.equal(s.fault, 0)
assert.match(summary(s, 'lamp', 5, f()), /dead short 30 A.* stays off/)
assert.equal(simulate(f({ hardShortLimit: 0 }), 'lamp', 5, 1000).trips.length, 0, '0 = no dead-short trip')

// PWM soft start ramps the current: the lamp's 7x peak is never reached, so 20 A inrush holds
s = simulate(f({ inrushLimit: 20, pwmEnabled: true, softStart: true, softStartRamp: 200 }), 'lamp', 5, 1000)
assert.equal(s.trips.length, 0); assert.equal(s.demand[0], 0)
assert.equal(simulate(f({ inrushLimit: 20, pwmEnabled: false, softStart: true, softStartRamp: 200 }), 'lamp', 5, 1000).trips.length, 1, 'soft start needs PWM')

assert.equal(windowMs(f()), 1000); assert.equal(windowMs(f({ resetMode: 2, resetTime: 60000 })), 20000)
assert.deepEqual(thin([1, 5, 2, 0, 3, 1], 3), [5, 2, 3])
assert.equal(loadFromName('Rad fan'), 'motor'); assert.equal(loadFromName('Low beam'), 'lamp'); assert.equal(loadFromName('ECU'), 'steady')
console.log('fuse.test.js ok')
