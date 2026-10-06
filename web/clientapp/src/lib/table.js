// 2-axis lookup table maths — the JS mirror of the firmware's Table::Interpolate (functions/table.cpp)
// and the backend's LookupTable.Interpolate, used for the editor's live preview. Keep all three in step.
export const AXIS_MAX = 8

// Lower index + fraction of v on an ascending axis of n points; clamps outside the range.
function locate(axis, n, v) {
  if (n <= 1 || v <= axis[0]) return [0, 0]
  if (v >= axis[n - 1]) return [n - 2, 1]
  let i = 0
  while (i < n - 2 && v > axis[i + 1]) i++
  const span = axis[i + 1] - axis[i]
  return [i, span > 0 ? (v - axis[i]) / span : 0]
}

// cells is row-major [y*8 + x]; a table with ySize = 1 is a 1-D curve along X.
export function interpolate(xSize, ySize, xAxis, yAxis, cells, x, y) {
  const nx = Math.min(AXIS_MAX, Math.max(1, xSize | 0))
  const ny = Math.min(AXIS_MAX, Math.max(1, ySize | 0))
  const [ix, tx] = locate(xAxis, nx, x)
  const [iy, ty] = locate(yAxis, ny, y)
  const ix1 = nx > 1 ? ix + 1 : ix, iy1 = ny > 1 ? iy + 1 : iy
  const c = (yy, xx) => +cells[yy * AXIS_MAX + xx] || 0
  const r0 = c(iy, ix) + (c(iy, ix1) - c(iy, ix)) * tx
  const r1 = c(iy1, ix) + (c(iy1, ix1) - c(iy1, ix)) * tx
  return r0 + (r1 - r0) * ty
}

// Spread an axis linearly between its first and last used entry (editor convenience).
export function spreadAxis(axis, n) {
  const out = [...axis]
  if (n < 2) return out
  const a = +axis[0] || 0, b = +axis[n - 1] || 0
  for (let i = 0; i < n; i++) out[i] = a + ((b - a) * i) / (n - 1)
  return out
}

// The firmware's lookup assumes a strictly ascending axis — report the first violation (or -1).
export function firstNonAscending(axis, n) {
  for (let i = 1; i < n; i++) if (!(+axis[i] > +axis[i - 1])) return i
  return -1
}
