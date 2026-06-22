// Resistor-ladder designer for a multi-position switch on a CANBoard analog input.
//
// The firmware already decodes a multi-position switch: RotarySwitch reads
//   pos = clamp(floor((mV - offset) / step), 0, maxPos)
// (CoffeeDingoFW/functions/analog_input.cpp). So "define a switch with N states"
// reduces to picking N evenly-spread voltages and burning offset/step/maxPos.
//
// Circuit (the topology the operator chose): one pull-up Rpu from a supply rail to
// the input pin; the rotary switch grounds the pin through a different resistor Rk at
// each position. The board's own input network (4.7k series + 10k to GND, see
// canboard_v2/port.cpp AdcToVolts) is a fixed ~14.7k load to ground in parallel with Rk.
//
// ponytail: R_IN is read off the board's measurement divider, not a free knob. If a
// future board changes those resistors, update this constant (the UI exposes Rpu/Vsup,
// which are the parts that actually vary per install).
export const R_IN = 14700        // board input impedance to GND, ohms
export const V_ADC_MAX_MV = 4851 // max readable input: 3.3 V ADC × (4.7k+10k)/10k (firmware AdcToVolts); ADC saturates above this

// Standard resistor decade values (normalized 1.0–9.1). E24 = 5%, E12 = 10% — the common
// stock. ponytail: skipped E96 (1%); add it when a design needs >8 tightly-spread positions.
const SERIES = {
  E12: [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2],
  E24: [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0,
        3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1],
}

export const parallelR = (a, b) => (a * b) / (a + b)

// Snap to the nearest standard value in log space (the correct metric for resistor choice).
export function nearestStandard(ohms, seriesName = 'E24') {
  if (!isFinite(ohms)) return Infinity
  if (ohms <= 0) return 0
  const m = SERIES[seriesName] || SERIES.E24
  let best = m[0], bestErr = Infinity
  for (let d = 0; d <= 6; d++) {
    const scale = Math.pow(10, d)
    for (const x of m) {
      const v = Math.round(x * scale)
      const err = Math.abs(Math.log(v / ohms))
      if (err < bestErr) { bestErr = err; best = v }
    }
  }
  return best
}

// Open-circuit voltage: switch open (no Rk), only the board's R_IN pulls the node down.
export const ocVoltageMv = ({ vsupMv, rpu, rin = R_IN }) => vsupMv * rin / (rpu + rin)

// Voltage at the input pin for a given per-position resistor (Infinity = open position).
export function nodeVoltageMv(rk, { vsupMv, rpu, rin = R_IN }) {
  const p = isFinite(rk) ? parallelR(rk, rin) : rin
  return vsupMv * p / (rpu + p)
}

// Per-position resistor that lands the pin at a target voltage. Infinity (= open) if the
// target is at/above the open-circuit ceiling; 0 (= short) if at/below ground.
export function resistorForMv(mv, { vsupMv, rpu, rin = R_IN }) {
  if (mv <= 0) return 0
  if (mv >= ocVoltageMv({ vsupMv, rpu, rin })) return Infinity
  const p = (mv * rpu) / (vsupMv - mv)        // required Rk‖R_IN
  const invRk = 1 / p - 1 / rin
  return invRk <= 0 ? Infinity : 1 / invRk
}

// Recommend resistors, spreading N positions evenly so the LAST (top) position sits at the
// readable max: the top detent is the switch OPEN (no resistor) — the highest the input can read —
// and the lower N-1 positions step down from it: V_k = Voc·(k+1)/N, so V_{N-1}=Voc (open). With the
// recommended pull-up Voc is the readable max (~4.85 V), so the last position is always at the top.
// Each lower target snaps to the chosen series; `mv` is the ACTUAL resulting voltage.
export function recommendResistors(n, { vsupMv, rpu, rin = R_IN, series = 'E24' }) {
  const voc = ocVoltageMv({ vsupMv, rpu, rin })
  const rows = []
  for (let k = 0; k < n; k++) {
    if (k === n - 1) { rows.push({ r: Infinity, mv: voc, target: voc }); continue }  // top detent = switch open = readable max
    const target = voc * (k + 1) / n
    const r = nearestStandard(resistorForMv(target, { vsupMv, rpu, rin }), series)
    rows.push({ r, mv: nodeVoltageMv(r, { vsupMv, rpu, rin }), target })
  }
  return rows
}

// Recommend a pull-up so the OPEN (top) position reads the readable max — that fixes the last
// detent at ~4.85 V on a 5 V supply. Voc = Vsup·Rin/(Rpu+Rin) can't exceed the supply, so we aim it
// at the readable ceiling (or just under the supply for a low rail). This pins the pull-up (the top
// is the open circuit), so unlike before it does NOT vary with position count.
// ponytail: the UI shows the resulting standing current — raise the pull-up by hand to trade top-end
// reach for less current.
export function recommendPullup({ vsupMv, rin = R_IN, series = 'E24' }) {
  if (!(vsupMv > 0)) return nearestStandard(rin * 0.11, series)
  const vocTarget = Math.min(V_ADC_MAX_MV, vsupMv * 0.98)
  const ideal = rin * (vsupMv / vocTarget - 1)
  return Math.max(Math.min(nearestStandard(ideal, series), 1_000_000), 100)
}

// Standing current the divider pulls from V+ for a given position resistor (mV/Ω = mA).
// Highest at the lowest position (smallest Rk); the open position draws the least.
export function supplyCurrentMa(rk, { vsupMv, rpu, rin = R_IN }) {
  const p = isFinite(rk) ? parallelR(rk, rin) : rin
  return vsupMv / (rpu + p)
}

export const NO_POS = 15   // firmware ROTARY_NO_POS — reading is in a dead zone / fault

// Auto sensing tolerance (half-window, mV) for the calibrated-points decode: a fraction of the
// tightest gap between positions, bounded so a far-apart 2-position switch doesn't get a half-rail
// band. This is the cap; the firmware further clamps each side at the midpoint to its neighbour.
export function autoTolerance(mvs, { min = 75, max = 300 } = {}) {
  if (mvs.length < 2) return max
  let gap = Infinity
  for (let i = 1; i < mvs.length; i++) gap = Math.min(gap, Math.abs(mvs[i] - mvs[i - 1]))
  return Math.round(Math.max(min, Math.min(max, 0.4 * gap)))
}

// Calibrated-points decode, mirrored EXACTLY from firmware analog_input.cpp RotaryUpdate (points
// mode): the position whose window contains mv, else NO_POS. Half-width each side = min(tol,
// gap-to-neighbour/2); the ends are capped at tol. `points` must be ascending. invert handled by caller.
export function decodePoints(mv, points, tol) {
  const n = points.length
  for (let k = 0; k < n; k++) {
    const c = points[k]
    const gapLo = (k === 0) ? tol * 2 : c - points[k - 1]
    const gapHi = (k === n - 1) ? tol * 2 : points[k + 1] - c
    const halfLo = Math.min(tol, Math.floor(gapLo / 2))
    const halfHi = Math.min(tol, Math.floor(gapHi / 2))
    if (mv >= c - halfLo && mv <= c + halfHi) return k
  }
  return NO_POS
}

// Firmware decode, mirrored exactly (analog_input.cpp RotaryUpdate, invert ignored here).
export function decodePos(mv, offset, step, maxPos) {
  if (step <= 0) return 0
  if (mv < offset) return 0
  return Math.min(Math.floor((mv - offset) / step), maxPos)
}

// Fit the firmware's uniform-step model to a set of position voltages (must be sorted
// ascending). Returns the offset/step/maxPos to burn, plus the worst-case noise margin —
// the smallest distance from any actual voltage to the decision boundary on either side —
// and `ok` = every voltage decodes back to its own position.
// ponytail: uniform step assumes an even spread. Wildly uneven manual voltages still get a
// best-fit, but minMargin tells the truth; per-position thresholds would need a FW change.
export function deriveBands(mvs) {
  const n = mvs.length
  if (n === 0) return { offsetMv: 0, stepMv: 0, maxPos: 0, minMarginMv: 0, ok: false }
  if (n === 1) return { offsetMv: mvs[0] - 500, stepMv: 1000, maxPos: 0, minMarginMv: Infinity, ok: true }

  const step = (mvs[n - 1] - mvs[0]) / (n - 1)
  const offset = mvs[0] - step / 2
  const maxPos = n - 1

  let minMargin = Infinity, ok = true
  for (let k = 0; k < n; k++) {
    if (decodePos(mvs[k], offset, step, maxPos) !== k) ok = false
    const lo = offset + k * step          // lower boundary of band k
    const hi = offset + (k + 1) * step     // upper boundary
    // Ends clamp, so only interior boundaries can actually mis-read.
    if (k > 0) minMargin = Math.min(minMargin, mvs[k] - lo)
    if (k < n - 1) minMargin = Math.min(minMargin, hi - mvs[k])
  }
  return { offsetMv: offset, stepMv: step, maxPos, minMarginMv: minMargin, ok }
}
