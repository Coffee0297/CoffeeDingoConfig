// Self-check: `node ladder.test.js`. No framework — the logic that decides switch
// positions must round-trip, so this proves recommended resistors actually decode back.
import assert from 'node:assert/strict'
import { nearestStandard, recommendResistors, deriveBands, decodePos, nodeVoltageMv, resistorForMv, recommendPullup, supplyCurrentMa, ocVoltageMv, autoTolerance, decodePoints, NO_POS, R_IN, V_ADC_MAX_MV } from './ladder.js'

// nearest standard value snaps in log space
assert.equal(nearestStandard(4700, 'E24'), 4700)
assert.equal(nearestStandard(4800, 'E24'), 4700)   // 4800 closer to 4700 than 5100
assert.equal(nearestStandard(5000, 'E24'), 5100)   // 5000 closer to 5100 than 4700
assert.equal(nearestStandard(990, 'E12'), 1000)

// resistorForMv / nodeVoltageMv are inverses (within the readable range)
const opts = { vsupMv: 5000, rpu: 4700 }
for (const mv of [500, 1500, 2500, 3000]) {
  const r = resistorForMv(mv, opts)
  assert.ok(Math.abs(nodeVoltageMv(r, opts) - mv) < 1, `roundtrip ${mv}mV`)
}

// the headline guarantee: a recommended N-position ladder, with the bands we burn, must decode
// every position back to itself with a usable margin. The TOP position is the switch-open detent.
for (let n = 2; n <= 8; n++) {
  const rows = recommendResistors(n, opts)
  const mvs = rows.map((x) => x.mv)
  for (let k = 1; k < n; k++) assert.ok(mvs[k] > mvs[k - 1], `n=${n} monotonic`)
  for (let k = 0; k < n - 1; k++) assert.ok(isFinite(rows[k].r) && rows[k].r > 0, `n=${n} pos ${k} finite`)
  assert.ok(!isFinite(rows[n - 1].r), `n=${n} top position is the open switch`)

  const b = deriveBands(mvs)
  assert.equal(b.maxPos, n - 1)
  assert.ok(b.ok, `n=${n} decodes cleanly`)
  for (let k = 0; k < n; k++) assert.equal(decodePos(mvs[k], b.offsetMv, b.stepMv, b.maxPos), k, `n=${n} pos ${k}`)
  assert.ok(b.minMarginMv > 100, `n=${n} margin ${b.minMarginMv.toFixed(0)}mV too small`)
}

// a deliberately bad manual spread (two voltages almost touching) is reported, not hidden
const bad = deriveBands([1000, 1050, 3000])
assert.ok(!bad.ok || bad.minMarginMv < 100, 'crowded voltages flagged')

// auto pull-up fixes the OPEN/top detent at the readable max (~4.85 V), independent of N
const rpu5 = recommendPullup({ vsupMv: 5000 })
assert.ok(rpu5 > 100 && isFinite(rpu5), 'pull-up is a real value')
assert.ok(Math.abs(ocVoltageMv({ vsupMv: 5000, rpu: rpu5 }) - V_ADC_MAX_MV) < 200, 'open ≈ readable max')
for (const n of [3, 5, 8, 10]) {
  const rows = recommendResistors(n, { vsupMv: 5000, rpu: rpu5 })
  assert.equal(rows.length, n)
  assert.ok(!isFinite(rows[n - 1].r), `n=${n} top is open`)
  assert.ok(Math.abs(rows[n - 1].mv - V_ADC_MAX_MV) < 200, `n=${n} top ≈ readable max (${rows[n - 1].mv | 0} mV)`)
  const b = deriveBands(rows.map((r) => r.mv))
  assert.ok(b.ok && b.minMarginMv > 150, `n=${n} margin ${b.minMarginMv | 0} mV solid`)
}
// 12 V supply: bigger pull-up, open still lands near the readable max
const rpu12 = recommendPullup({ vsupMv: 12000 })
assert.ok(rpu12 > rpu5 && ocVoltageMv({ vsupMv: 12000, rpu: rpu12 }) <= V_ADC_MAX_MV + 100, '12V open ≈ readable max')

// standing current: positive, and a lower position (smaller R) draws more than a higher one
const ci = { vsupMv: 5000, rpu: rpu5 }
assert.ok(supplyCurrentMa(680, ci) > supplyCurrentMa(18000, ci), 'lower position draws more')
assert.ok(supplyCurrentMa(680, ci) > 0 && supplyCurrentMa(680, ci) < 50, 'current sane')

// calibrated per-position decode (uneven switches): every point decodes to itself; midpoint
// dead-zones report NO_POS; close pairs never overlap. Mirrors the firmware window decode.
{
  // even spread
  const even = [500, 1500, 2500, 3500, 4500]
  const tEven = autoTolerance(even)
  for (let k = 0; k < even.length; k++) assert.equal(decodePoints(even[k], even, tEven), k, `even point ${k}`)
  assert.equal(decodePoints(1000, even, tEven), NO_POS, 'even midpoint is a dead zone (tol < gap/2)')

  // UNEVEN: tight pair + a far one (the case uniform offset/step can't handle)
  const uneven = [300, 600, 4500]
  const tUneven = autoTolerance(uneven)
  for (let k = 0; k < uneven.length; k++) assert.equal(decodePoints(uneven[k], uneven, tUneven), k, `uneven point ${k}`)
  assert.equal(decodePoints(450, uneven, tUneven), NO_POS, 'tight-pair midpoint is a dead zone')
  // windows never overlap → the midpoint can't read as both 0 and 1
  assert.ok(decodePoints(449, uneven, tUneven) !== 1 && decodePoints(451, uneven, tUneven) !== 0, 'no overlap at the boundary')

  // tolerance is bounded: a far-apart 2-position switch is capped, not half-rail
  assert.ok(autoTolerance([500, 4500]) <= 300, '2-pos tolerance capped')
  assert.equal(decodePoints(2500, [500, 4500], autoTolerance([500, 4500])), NO_POS, '2-pos middle is dead zone, not a position')
}

console.log('ladder.test.js: all assertions passed')
