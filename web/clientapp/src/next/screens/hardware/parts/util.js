// Pure helpers shared by the output and input detail screens.

/** Firmware version text like "v5.5.112" -> [5,5,112], or null when unknown (the Sim reports v0.0.0). */
export function parseVersion(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? '')
  if (!m) return null
  const t = [+m[1], +m[2], +m[3]]
  return t[0] === 0 && t[1] === 0 && t[2] === 0 ? null : t
}
/** true when version v is known and older than [a,b,c]. Upstream dingoFW (v0.x) is another line, never "older":
 *  gate its features with lacks() / has() instead. */
export function olderThan(v, min) {
  const p = parseVersion(v)
  if (!p || p[0] === 0) return false
  for (let i = 0; i < 3; i++) { if (p[i] !== min[i]) return p[i] < min[i] }
  return false
}

/** The module runs upstream dingoFW (version 0.x) rather than the fork (5.x). */
export const isUpstream = (dev) => dev?.family === 'upstream'

/** Why a fixed output PWM frequency is refused ('' = fine). Upstream: 16-400 Hz or 0 = keep the timer's period (its
 *  timers can't make 1-15 Hz; fix/pwm-low-freq firmware runs them at 16). Fork: 15-400 Hz. */
export function pwmFreqError(dev, hz) {
  const fr = Math.round(+hz || 0)
  if (isUpstream(dev)) return fr === 0 || (fr >= 16 && fr <= 400) ? '' : 'PWM frequency must be 16 to 400 Hz (0 = keep the current period).'
  return fr >= 15 && fr <= 400 ? '' : 'PWM frequency must be 15 to 400 Hz.'
}

// dev.paramRuns: the upstream module's params as runs [firstIndex, indexCount, sub, sub, …] (null until a Read).
function* paramsOf(dev) {
  for (const r of dev?.paramRuns ?? []) for (let k = 0; k < r[1]; k++) for (const s of r.slice(2)) yield [r[0] + k, s]
}
/** Does the module have param (index, sub)? Fork: true (gate fork features by version). Upstream: by the list it
 *  returned on Read; true while that is unknown (Apply waits for a Read anyway). */
export function has(dev, index, sub = 0) {
  if (!isUpstream(dev) || !dev.paramRuns) return true
  for (const [i, s] of paramsOf(dev)) if (i === index && s === sub) return true
  return false
}
/** Does the module have any param of the block at base..base+0xFF (e.g. 0x1C00 math)? Same rules as has(). */
export function hasBlock(dev, base) {
  if (!isUpstream(dev) || !dev.paramRuns) return true
  return dev.paramRuns.some((r) => r[0] + r[1] > base && r[0] < base + 0x100)
}
/** A fork feature from firmware `min`, at param block `base` (or the single param base:sub): is it missing on this
 *  module? Fork: by version. Upstream: by its param list, missing until a Read shows it (no base = a fork-only
 *  command such as Lua or identify: always missing). */
export function lacks(dev, min, base, sub) {
  if (isUpstream(dev)) return base == null || !dev.paramRuns || !(sub == null ? hasBlock(dev, base) : has(dev, base, sub))
  return olderThan(dev?.version, min)
}

/** The /functions array that holds a given function kind (PDM calls digital inputs `inputs`, CANBoard `digitalIn`). */
export function funcArray(funcs, kind) {
  const m = { input: funcs?.inputs ?? funcs?.digitalIn, analoginput: funcs?.analogIn, caninput: funcs?.canInputs, virtualinput: funcs?.virtualInputs,
    condition: funcs?.conditions, counter: funcs?.counters, flasher: funcs?.flashers, timer: funcs?.timers, table: funcs?.tables, digitaloutput: funcs?.digitalOut, canoutput: funcs?.canOutputs }
  return m[kind] ?? []
}

// Upstream input fields of every function kind that reads other signals.
export const UPSTREAM = {
  condition: ['input'], virtualinput: ['var0', 'var1', 'var2'], flasher: ['input'], timer: ['input'],
  table: ['xInput', 'yInput'], counter: ['incInput', 'decInput', 'resetInput'], canoutput: ['input'],
  digitaloutput: ['input', 'dutyCycleInput', 'freqInput'],
}

/** Plain-English block label + colour family for a var-map owner kind. */
export const BLOCK = {
  input: { label: 'INPUT', fam: 'var(--color-block-input)' },
  analoginput: { label: 'ANALOG INPUT', fam: 'var(--color-block-input)' },
  caninput: { label: 'CAN INPUT', fam: 'var(--color-block-input)' },
  condition: { label: 'COMPARE', fam: 'var(--color-block-logic)' },
  virtualinput: { label: 'COMBINE', fam: 'var(--color-block-logic)' },
  flasher: { label: 'FLASHER', fam: 'var(--color-block-time)' },
  timer: { label: 'TIMER', fam: 'var(--color-block-time)' },
  table: { label: 'TABLE', fam: 'var(--color-block-time)' },
  counter: { label: 'COUNTER', fam: 'var(--color-block-time)' },
  sys: { label: 'SYSTEM', fam: 'var(--color-block-code)' },
  lua: { label: 'LUA', fam: 'var(--color-block-code)' },
  output: { label: 'OUTPUT', fam: 'var(--color-block-output)' },
}

/** Strip the property suffix the var map adds ("Brake State" -> "Brake"). */
export const bareName = (n) => String(n ?? '').replace(/ (Value|State)$/, '')

/**
 * Walk upstream from var index `idx`. Returns blocks from the source toward the output:
 * [{ kind, name, number, also: string[] }]. Follows the first non-zero upstream of each block;
 * `also` lists the other upstream names so nothing is hidden. varmap = api.inputs(guid) (all entries).
 */
export function walkChain(idx, varmap, funcs, depth = 8) {
  const out = []
  const seen = new Set()
  let cur = Number(idx) || 0
  while (cur && depth-- > 0 && !seen.has(cur)) {
    seen.add(cur)
    const v = varmap.find((x) => x.index === cur)
    if (!v) break
    const kind = v.kind
    const row = funcArray(funcs, kind).find((x) => x.number === v.number)
    const ups = (UPSTREAM[kind] ?? []).map((f) => Number(row?.[f]) || 0).filter(Boolean)
    const names = ups.map((u) => varmap.find((x) => x.index === u)?.name ?? '#' + u)
    out.unshift({ kind, name: row?.name ?? bareName(v.name), varName: v.name, number: v.number, index: cur, also: names.slice(1) })
    cur = ups[0] ?? 0
  }
  return out
}

/** Which functions / outputs read var index set `idxs`? Returns [{ name, where }] (no duplicates). */
export function consumersOf(idxs, funcs, outputs, moduleName, dev) {
  const set = new Set([...idxs].filter(Boolean))
  if (!set.size) return []
  const hits = []
  const add = (name, where) => { if (!hits.some((h) => h.name === name && h.where === where)) hits.push({ name, where }) }
  const SCAN = { conditions: ['input'], flashers: ['input'], timers: ['input'], tables: ['xInput', 'yInput'], virtualInputs: ['var0', 'var1', 'var2'],
    counters: ['incInput', 'decInput', 'resetInput'], canOutputs: ['input'], digitalOut: ['input', 'dutyCycleInput', 'freqInput'] }
  for (const [arr, fields] of Object.entries(SCAN)) {
    for (const x of funcs?.[arr] ?? []) {
      if (x.enabled === false) continue
      if (fields.some((f) => set.has(Number(x[f])))) add(x.name, moduleName)
    }
  }
  for (const o of outputs ?? []) {
    if (!o.enabled) continue
    if (['inputVal', 'dutyCycleInput', 'freqInput'].some((f) => set.has(Number(o[f])))) add(o.name?.trim() || 'Output ' + o.number, `${moduleName} out ${o.number}`)
  }
  if (dev && (set.has(dev.forceSleepInput) || set.has(dev.muteTxInput))) add('Car sleep', moduleName)
  if (dev && set.has(dev.retryAllInput)) add('Retry all faults', moduleName)
  return hits
}

/**
 * Time-stamped samples [{t,v}] onto n bins of the last windowMs. The bins sit on a fixed time grid (multiples of
 * the bin width), so a bin that has passed never changes: the history scrolls, it does not reshape each redraw.
 * agg 'last' keeps a bin's last sample, 'max' its peak (short spikes stay visible). Empty bins hold the previous
 * value; bins before the first sample take its value.
 */
export function resample(samples, windowMs, n, now = Date.now(), agg = 'last') {
  if (!samples.length) return []
  const step = windowMs / (n - 1)
  const lastBin = Math.floor(now / step), firstBin = lastBin - n + 1
  const out = new Array(n).fill(NaN)
  for (const s of samples) {
    const k = Math.floor(s.t / step) - firstBin
    if (k < 0 || k >= n) continue
    out[k] = agg === 'max' && !Number.isNaN(out[k]) ? Math.max(out[k], s.v) : s.v
  }
  // hold across empty bins; before the window's first sample, the last value seen before it (or the first sample)
  let prev = samples.filter((s) => Math.floor(s.t / step) < firstBin).at(-1)?.v ?? samples[0].v
  return out.map((x) => (Number.isNaN(x) ? prev : (prev = x)))
}

export const f1 = (x, d = 1) => (Number.isFinite(+x) ? (+x).toFixed(d) : '—')
export const volts = (mv) => (Number(mv) / 1000).toFixed(2)

/** Normalise the router's kind segment ('input', 'digital', 'di', 'analog', 'can' ...) to a setFunction kind. */
export function normKind(k) {
  const s = String(k ?? '').toLowerCase()
  if (['input', 'digital', 'digitalinput', 'di', 'pin'].includes(s)) return 'input'
  if (['analoginput', 'analog', 'ai', 'ain', 'rotary'].includes(s)) return 'analoginput'
  if (['caninput', 'can', 'canin'].includes(s)) return 'caninput'
  return s
}
