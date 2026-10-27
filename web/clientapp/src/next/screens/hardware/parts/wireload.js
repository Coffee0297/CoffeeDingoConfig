// Upstream feat/wire-load: the module's estimate of how warm an output's wire runs, as a % of the temperature it
// reaches carrying the current limit for good (Msg 30, saturates at 255). Report only.
export const WARN_PCT = 80

/** {pct, headroom, hot, over} for an output DTO with a wire time constant set, else null. */
export function wireLoad(o) {
  if (!(o?.thermalTau > 0)) return null
  const pct = Math.round(Number(o.wireLoad) || 0)
  return { pct, headroom: Math.max(0, 100 - pct), hot: pct >= WARN_PCT, over: pct >= 100 }
}

/** One line for a tile or a card: "wire 38 % · 62 % headroom", "wire 104 % · over its limit". */
export function wireLoadText(w) {
  if (!w) return ''
  return `wire ${w.pct} %` + (w.over ? ' · over its limit' : ` · ${w.headroom} % headroom`)
}
