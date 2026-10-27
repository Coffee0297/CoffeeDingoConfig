// Latch / Gate block (upstream dingoFW feat/latch-gate-block, param 0x2600, 8 per PDM). Mirrors functions/latch_gate.cpp.
export const LATCH_TYPES = ['Latch', 'Gate']
export const LATCH_MAX_MS = 600000

/** Input ports by type: a latch has set / reset, a gate value / enable. */
export const latchGateIns = (row) => (row?.type === 1
  ? [['input', 'Value', 'num'], ['controlInput', 'Enable', 'bool']]
  : [['input', 'Set', 'bool'], ['controlInput', 'Reset', 'bool']])

export function latchGateProblem(row) {
  if (row?.type !== 1 && !(Number.isInteger(+row?.timeMs) && +row.timeMs >= 0 && +row.timeMs <= LATCH_MAX_MS)) return 'the auto-cancel time must be 0 to 600 s'
  return null
}

/** One firmware cycle. st = per-block state ({init, lastIn, lastCtl, setAt, val}); returns the block value. */
export function latchGateStep(st, row, inVal, ctlVal, now) {
  if (!row?.enabled) { st.init = false; return (st.val = 0) }
  const i = +inVal > 0.5, c = +ctlVal > 0.5
  // first pass after enable only samples, so an input already on is not an edge
  if (!st.init) { st.init = true; st.lastIn = i; st.lastCtl = c; return (st.val = 0) }
  if (row.type === 1) { if (c) st.val = +inVal || 0 }
  else if (c && !st.lastCtl) st.val = 0   // reset wins over a set in the same cycle
  else if (i && !st.lastIn) { st.val = 1; st.setAt = now }
  else if (st.val > 0.5 && row.timeMs > 0 && now - st.setAt >= row.timeMs) st.val = 0
  st.lastIn = i; st.lastCtl = c
  return st.val
}
