// Fault history (upstream feat/fault-history): the module's FRAM log of output trips, newest first. No clock on the
// module: an entry has its boot number and the time since that boot's power-on.

export const KIND = ['', 'Overcurrent', 'Fault', 'Latched off']
export const KIND_WHY = ['', 'went over its current limit and switched off', 'switched off on a fault the output switch reported', 'stayed off: no retries left after an overcurrent']

/** 3.2 s · 4 min 05 s · 2 h 04 min */
export function upText(ms) {
  const s = (Number(ms) || 0) / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`
}

/** Which boot an entry is from, against the module's current boot count. */
export function bootText(boot, now) {
  const ago = now - boot
  return ago === 0 ? 'this boot' : ago === 1 ? 'the boot before' : ago > 1 ? `${ago} boots ago` : `boot ${boot}`
}

/** Display rows; outputs = the module's outputs (for names). */
export const rows = (entries, now, outputs = []) => (entries ?? []).map((e) => ({
  ...e, when: `${bootText(e.boot, now)} · ${upText(e.uptimeMs)} after power-on`,
  name: (outputs.find((o) => o.number === e.output)?.name ?? '').trim() || `Output ${e.output}`,
  what: KIND[e.kind] ?? `kind ${e.kind}`, why: KIND_WHY[e.kind] ?? '',
}))
