// Fuse curve for the output editor: what the trip logic does to an example load. Pure.
// Mirrors the firmware's output state machine (functions/profet.cpp, 500 Hz): trips at once when the current is
// above the inrush limit during the first inrushTime ms after turn-on, or above the current limit after that;
// then latches (reset mode 0), retries up to resetCountLimit times (1) or for ever (2), resetTime ms apart.
// Each retry is a new turn-on, so the inrush window starts again.
// Optional, when the module has them: hardShortLimit (> 0: latches off at once, even during inrush, no retry) and
// PWM soft start (pwmEnabled + softStart: duty ramps up over softStartRamp ms, the current with it).

export const DT = 2   // ms, the firmware's control loop

// Example loads: current = run × (1 + (peak − 1) · e^(−t/tau)) after turn-on. Typical figures, not a datasheet.
export const LOADS = {
  lamp: { label: 'Lamp', peak: 7, tau: 25, sub: 'cold filament, ~7× for a few 10 ms' },
  motor: { label: 'Motor', peak: 5, tau: 120, sub: 'starting current, ~5× for ~0.3 s' },
  steady: { label: 'Heater / LED', peak: 1.1, tau: 20, sub: 'about the running current' },
}

/** A first guess from the output's name. */
export function loadFromName(name) {
  const s = String(name ?? '').toLowerCase()
  if (/fan|pump|motor|wiper|horn|blower|compressor|starter|window|seat|lift/.test(s)) return 'motor'
  if (/lamp|light|beam|bulb|indicator|blink|turn|brake|tail|stop|park|fog|spot|reverse/.test(s)) return 'lamp'
  return 'steady'
}

export const loadCurrent = (load, runA, msSinceOn) => {
  const l = LOADS[load] ?? LOADS.steady
  return runA * (1 + (l.peak - 1) * Math.exp(-msSinceOn / l.tau))
}

/**
 * Run the example load through the protection settings f (currentLimit, inrushLimit, inrushTime, resetMode,
 * resetCountLimit, resetTime) for durationMs, switched on at t = 0.
 * Returns { t[], demand[], flow[], limit[], trips: [{ t, a, limit, inrush }], fault: t|null }.
 * demand = what the load would draw, flow = what flows (0 while tripped), limit = the threshold in force.
 */
export function simulate(f, load, runA, durationMs) {
  const num = (x) => Number(x) || 0
  const lim = num(f.currentLimit), inLim = num(f.inrushLimit), inT = num(f.inrushTime)
  const mode = num(f.resetMode), count = num(f.resetCountLimit), wait = num(f.resetTime)
  const hard = num(f.hardShortLimit), ramp = f.pwmEnabled && f.softStart ? num(f.softStartRamp) : 0
  const draw = (since) => loadCurrent(load, runA, since) * (ramp > 0 ? Math.min(1, since / ramp) : 1)
  const out = { t: [], demand: [], flow: [], limit: [], trips: [], fault: null }
  let st = 'on', onAt = 0, trigAt = 0, n = 0
  for (let t = 0; t <= durationMs; t += DT) {
    const inrush = inT + onAt > t
    const thr = inrush ? inLim : lim
    // the trip state is handled one loop after the trip, as in the firmware (latch first, then the retry timer)
    if (st === 'oc') {
      if (mode === 0) st = 'fault'
      if (n >= count && mode === 1) st = 'fault'
      if (wait + trigAt < t) { onAt = t; st = 'on' }
      if (st === 'fault' && out.fault == null) out.fault = t
    }
    const a = st === 'on' ? draw(t - onAt) : 0
    if (st === 'on' && hard > 0 && a > hard) { st = 'fault'; out.fault = t; out.trips.push({ t, a, limit: hard, inrush, hard: true }) }
    else if (st === 'on' && a > thr) { st = 'oc'; trigAt = t; n++; out.trips.push({ t, a, limit: thr, inrush }) }
    out.t.push(t); out.demand.push(draw(t - onAt)); out.flow.push(st === 'on' ? a : 0); out.limit.push(inT + onAt > t ? inLim : lim)
  }
  return out
}

/** A window that shows the inrush, and a few retries when there are any. */
export function windowMs(f) {
  const inT = Number(f.inrushTime) || 0, wait = Number(f.resetTime) || 0
  const base = Math.max(500, inT * 2)
  return Math.min(20000, Number(f.resetMode) ? base + 3 * (wait + inT) : base)
}

/** Down-sample to at most n points, keeping peaks (max per bucket). */
export function thin(values, n = 400) {
  if (values.length <= n) return values
  const k = Math.ceil(values.length / n), out = []
  for (let i = 0; i < values.length; i += k) out.push(Math.max(...values.slice(i, i + k)))
  return out
}

/** One sentence: what happens to this load. */
export function summary(sim, load, runA, f) {
  const what = `A ${LOADS[load].label.toLowerCase()} drawing ${runA.toFixed(1)} A`
  if (!sim.trips.length) return `${what} runs without tripping.`
  const first = sim.trips[0]
  const why = `${first.a.toFixed(1)} A > ${first.hard ? 'dead short' : first.inrush ? 'inrush allowed' : 'trip current'} ${first.limit} A`
  const at = first.t < 1 ? 'at once' : `after ${first.t} ms`
  if (sim.fault != null) return `${what} trips ${at} (${why})${sim.trips.length > 1 ? `, retries ${sim.trips.length - 1} time${sim.trips.length === 2 ? '' : 's'}` : ''} and stays off.`
  if (sim.trips.length === 1 && sim.flow[sim.flow.length - 1] > 0) return `${what} trips ${at} (${why}), then runs after one retry.`
  return `${what} trips ${at} (${why}) and keeps retrying every ${Number(f.resetTime) || 0} ms.`
}
