// 1-D curve block (upstream dingoFW feat/curve-block, param 0x2400): pure helpers for the editor, simulator and
// the "duty curve" helper on a PWM output.
export const CURVE_MAX = 12

/** Firmware Curve::Update (functions/curve.cpp): linear between points, ends held, a point whose X is not above the
 *  last used X is skipped. */
export function curveAt(points, x, y, input) {
  const n = Math.min(CURVE_MAX, Math.max(0, points | 0))
  const X = (i) => +x?.[i] || 0, Y = (i) => +y?.[i] || 0
  if (!(input > X(0))) return Y(0)
  let prev = 0
  for (let i = 1; i < n; i++) {
    if (X(i) <= X(prev)) continue
    if (input <= X(i)) return Y(prev) + ((input - X(prev)) * (Y(i) - Y(prev))) / (X(i) - X(prev))
    prev = i
  }
  return Y(prev)
}

/** Why a curve config is wrong ('' = fine): the firmware refuses 2..12 points out of range, and skips (does not
 *  refuse) X points that don't rise, so the editor insists on rising X. */
export function curveProblem(r) {
  const n = Number(r?.points)
  if (!Number.isInteger(n) || n < 2 || n > CURVE_MAX) return `the number of points must be 2 to ${CURVE_MAX}`
  for (let i = 0; i < n; i++) if (!Number.isFinite(+r.x?.[i]) || !Number.isFinite(+r.y?.[i]) || Math.abs(+r.x[i]) > 1e9 || Math.abs(+r.y[i]) > 1e9) return `point ${i + 1} needs X and Y numbers (within ±1e9)`
  for (let i = 1; i < n; i++) if (!(+r.x[i] > +r.x[i - 1])) return `X of point ${i + 1} must be above X of point ${i}`
  return ''
}

/** SVG polyline "x,y x,y" of the used points in a w×h box (y up), plus the box's value ranges. */
export function curvePlot(r, w, h) {
  const n = Math.min(CURVE_MAX, Math.max(2, Number(r?.points) || 2))
  const xs = Array.from({ length: n }, (_, i) => +r?.x?.[i] || 0), ys = Array.from({ length: n }, (_, i) => +r?.y?.[i] || 0)
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const sx = (v) => (x1 > x0 ? ((v - x0) / (x1 - x0)) * w : w / 2), sy = (v) => (y1 > y0 ? h - ((v - y0) / (y1 - y0)) * h : h / 2)
  return { pts: xs.map((v, i) => `${sx(v).toFixed(1)},${sy(ys[i]).toFixed(1)}`).join(' '), x0, x1, y0, y1 }
}

// A fresh duty curve: 0 % up to 80, rising to 100 % at 100 (e.g. a fan against coolant °C). Every field is set:
// a free slot keeps what it held before.
export const DUTY_CURVE = { input: 0, points: 3, x: [0, 80, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0], y: [0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0] }

/** Which curve should drive a PWM output's duty: the one it already uses, else the first free one (null = none
 *  free). `vars` = the module's var map (api.inputs), `dutyIdx` = the output's current duty source. */
export function pickDutyCurve(curves, vars, dutyIdx) {
  const using = (vars ?? []).find((v) => v.index === Number(dutyIdx) && v.kind === 'curve')
  const c = (using && curves?.find((x) => x.number === using.number)) || curves?.find((x) => !x.enabled)
  if (!c) return null
  const v = (vars ?? []).find((x) => x.kind === 'curve' && x.number === c.number)
  return v ? { number: c.number, index: v.index, fresh: !c.enabled } : null
}
