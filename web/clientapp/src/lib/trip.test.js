// node src/lib/trip.test.js
import assert from 'node:assert/strict';
import { tripReason, onTimeBeforeTrip } from './trip.js';

const wave = (onAt) => Array.from({ length: 326 }, (_, k) => { const dt = -10 + k * 0.04; return { dt, i: dt >= onAt && dt <= 0 ? 8 : 0 }; });
const out = { currentLimit: 12, inrushLimit: 50, inrushTime: 1000, resetMode: 0 };

// tripped at turn-on (all samples before the trip are 0): inrush limit applies
let r = tripReason({ state: 'Fault', peakA: 63, limitA: 12, samples: wave(1) }, out);
assert.equal(r.kind, 'inrush'); assert.equal(r.limitA, 50);
assert.match(r.text, /at turn-on: 63\.0 A peak > inrush limit 50 A \(first 1000 ms\)/);
assert.match(r.clears, /power-cycled/);

// on for 3 s, then tripped: steady limit applies
r = tripReason({ state: 'Overcurrent', peakA: 15, limitA: 12, samples: wave(-3) }, { ...out, resetMode: 1, resetTime: 1000, resetCountLimit: 3 });
assert.equal(r.kind, 'steady'); assert.equal(r.limitA, 12);
assert.match(r.text, /3\.0 s after turn-on: 15\.0 A peak > limit 12 A/);
assert.match(r.clears, /up to 3 times/);

// on for the whole window: steady
assert.equal(onTimeBeforeTrip(wave(-20)), null);
assert.equal(tripReason({ state: 'Fault', peakA: 20, limitA: 12, samples: wave(-20) }, out).kind, 'steady');

// 0.5 s after turn-on, inside a 1000 ms window: inrush
assert.equal(tripReason({ state: 'Fault', peakA: 63, samples: wave(-0.5) }, out).kind, 'inrush');
console.log('trip.test OK');
