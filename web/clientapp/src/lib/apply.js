// Template Apply / Remove against the device API only (no Svelte, no browser), so the Templates tab and the
// backend's template runner (MCP list/preview/apply/remove_template, run in Jint from template-runtime.js)
// do exactly the same thing. `api` is store.js's api, or the backend's loopback twin with the same methods
// (functions, inputs, setFunction, outputConfig, broadcastSignals).
import { previewTemplate, liveCtx, outputOptions, logicModule, shortfalls, validate, isInput, blank } from './templates.js'
import { pinFor, ioTag } from './pinmap.js'
import { busInputOptions, isDefaultName } from './businputs.js'

export const isMod = (d) => /pdm|can.?board/i.test(d?.type ?? '')
export const isCb = (d) => /can.?board/i.test(d?.type ?? '')
export const numOut = (v) => +String(v).split(':')[1]

// Rated channel current (A) for an output, from /api/definitions.
export function outputRatingA(defs, deviceType, outputNumber) {
  const t = (deviceType || '').toLowerCase()
  const def = [...(defs?.pdms ?? []), ...(defs?.canboards ?? [])].find((d) => (d.typeName || '').toLowerCase() === t)
  const r = def?.outputCurrentRatings
  return Array.isArray(r) ? (r[(Number(outputNumber) | 0) - 1] ?? null) : null
}

// Build an outputconfig body that binds `input` but PRESERVES every other field from the
// live output object. The backend overwrites the whole output, so any field we don't carry
// through here is silently reset — that previously wiped reset/retry, PWM and soft-start.
// CurrentLimit is the hardware over-current trip: we refuse to invent it. If the source output
// was never read/configured (no currentLimit), writing a guessed value could under- or
// over-protect the circuit, so we throw and make the caller Read the module first.
export const binBody = (o, input) => {
  if (o == null || o.currentLimit == null)
    throw new Error(`Output ${o?.number ?? '?'} has no current limit yet — Read the module before writing/deploying so its trip point isn't guessed.`)
  return {
    Number: o.number, Enabled: true, Input: input,
    CurrentLimit: o.currentLimit, InrushLimit: o.inrushLimit ?? 50, InrushTime: o.inrushTime ?? 1000,
    ResetMode: o.resetMode ?? 0, ResetTime: o.resetTime ?? 1000, ResetCountLimit: o.resetCountLimit ?? 3,
    PwmEnabled: o.pwmEnabled ?? false, Freq: o.freq ?? 100, FixedDuty: o.fixedDuty ?? 100, MinDuty: o.minDuty ?? 0,
    SoftStart: o.softStart ?? false, SoftStartRamp: o.softStartRamp ?? 0,
    // Variable-PWM (duty/freq follow a signal) — carry through so a deploy/binburn doesn't reset them.
    VariableDutyCycle: o.variableDutyCycle ?? false, DutyCycleInput: o.dutyCycleInput ?? 0, DutyCycleDenom: o.dutyCycleDenom ?? 100,
    VariableFreq: o.variableFreq ?? false, FreqInput: o.freqInput ?? 0, FreqInputDenom: o.freqInputDenom ?? 1,
    RampDutyChanges: o.rampDutyChanges ?? false, PrimaryOutput: o.primaryOutput ?? -1,
    WarnLimit: o.warnLimit ?? 0, OpenLoadLimit: o.openLoadLimit ?? 0, OpenLoadTime: o.openLoadTime ?? 1000,
  }
}

// Drive output n of `dev` from var index idx (PDM output config, or a CANBoard digital output's input).
export async function wireOut(api, dev, n, idx) {
  if (isCb(dev)) return api.setFunction(dev.guid, 'digitaloutput', n, { enabled: true, input: idx })
  await api.outputConfig(dev.guid, binBody((dev.outputs ?? []).find((x) => x.number === n) ?? { number: n }, idx))
}

// ---- Add a local CAN input on `consumerGuid` decoding a frame slice. Returns the caninput number + the
// varmap indices of its decoded ports: valueIndex (analog, float) and stateIndex (the 1-bit boolean).
// `frame` = {name, id, ide, startBit, length, byteOrder, factor, offset, isSigned}.
export async function addCanInputFromFrame(api, consumerGuid, frame) {
  const f = await api.functions(consumerGuid)
  // Idempotent: a CAN input already decoding this exact frame slice is reused, so clicking the same remote
  // signal twice (or from two pickers) doesn't pile up duplicates ("ignition" ×5 in every list).
  const same = (f?.canInputs ?? []).find((x) => x.enabled && x.id === frame.id && !!x.ide === !!frame.ide && x.startBit === frame.startBit && x.bitLength === frame.length)
  if (same) {
    const ins0 = await api.inputs(consumerGuid).catch(() => [])
    return { number: same.number, name: same.name, reused: true,
      stateIndex: ins0.find((x) => x.name === same.name)?.index ?? null,
      valueIndex: ins0.find((x) => x.name === same.name + ' Value')?.index ?? null }
  }
  const free = (f?.canInputs ?? []).find((x) => !x.enabled)
  if (!free) throw new Error('this module has no free CAN input slot — free one in Signals & logic')
  const name = (frame.name || ('dbc' + free.number)).slice(0, 32)
  // `id` BEFORE `ide`: CanInput.Id's setter forces Ide from the value (>2047), so send the source's
  // own ide flag afterwards to honour an extended-frame signal whose id happens to be ≤ 2047.
  // State = (value != 0) — the slot default "== 0" would make the on/off port read inverted.
  await api.setFunction(consumerGuid, 'caninput', free.number, {
    enabled: true, id: frame.id, ide: !!frame.ide,
    startBit: frame.startBit, bitLength: frame.length, byteOrder: frame.byteOrder,
    factor: frame.factor, offset: frame.offset, signed: frame.isSigned, mode: 0, operator: 1, operand: 0, name,
  })
  // Resolve the new input's varmap indices by VarLabel (State → name, Value → "name Value").
  const ins = await api.inputs(consumerGuid).catch(() => [])
  return {
    number: free.number, name,
    stateIndex: ins.find((x) => x.name === name)?.index ?? null,
    valueIndex: ins.find((x) => x.name === name + ' Value')?.index ?? null,
  }
}

// From a /broadcast-signals entry of another module. That DTO is base-ID-relative (offset, valueOffset,
// bitLength), so resolve the absolute id off the source's current base. Native broadcast frames are
// 11-bit standard (ide=false). `source` is the source device record (needs baseId).
export const broadcastFrame = (source, sig) => ({
  name: sig.label ?? sig.name, id: (source?.baseId ?? 0) + sig.offset, ide: false,   // the user's name ("ignition"), not "DigitalInput1.State"
  startBit: sig.startBit, length: sig.bitLength, byteOrder: sig.byteOrder,
  factor: sig.factor, offset: sig.valueOffset, isSigned: sig.signed,
})

// Turn on a physical input that a pick relies on (an unused pin reads nothing until enabled), naming it
// after what it now does when it still has its default name. phys = {kind: 'input'|'analoginput', number}.
// Returns true when it had to enable it.
export async function ensureInputEnabled(api, guid, phys, name) {
  if (!phys) return false
  const f = await api.functions(guid)
  const list = phys.kind === 'input' ? (f?.inputs ?? f?.digitalIn) : f?.analogIn
  const x = (list ?? []).find((i) => i.number === phys.number)
  if (!x || x.enabled) return false
  await api.setFunction(guid, phys.kind, phys.number, { enabled: true, ...(isDefaultName(x.name) && name ? { name: name.slice(0, 20) } : {}) })
  return true
}

// ---- Picker options. Every input on the bus as seen from `device` (its own in-use signals, its unused
// physical inputs, every other module's broadcasts); kind 'bool' | 'num'.
export async function loadInputOptions(api, device, devices, kind) {
  const types = kind === 'bool' ? ['bool'] : ['float', 'int']
  // In-use signals, plus this module's physical inputs nobody uses yet (enabled by whoever applies the pick).
  const [used, all] = await Promise.all([false, true].map(async (every) => (await Promise.all(types.map((t) => api.inputs(device.guid, t, every).catch(() => [])))).flat()))
  const usedIdx = new Set(used.map((v) => v.index))
  const local = [...used, ...all.filter((v) => !usedIdx.has(v.index) && (v.kind === 'input' || v.kind === 'analoginput')).map((v) => ({ ...v, unused: true }))]
  const others = (devices ?? []).filter((d) => d.guid !== device.guid && isMod(d))
  const remotes = await Promise.all(others.map(async (d) => ({ device: d, sigs: await api.broadcastSignals(d.guid).catch(() => []) })))
  return busInputOptions(device, local, remotes, kind)
}

// Every output on every module with what drives it now (a CANBoard's from its functions), + those functions.
export async function loadOutputOptions(api, mods, defs) {
  const funcs = {}
  await Promise.all(mods.map(async (d) => { funcs[d.guid] = await api.functions(d.guid).catch(() => null) }))
  const outOpts = outputOptions(mods.map((d) => ({ device: d, outs: isCb(d)
    ? (funcs[d.guid]?.digitalOut ?? []).map((o) => ({ number: o.number, name: o.name, input: o.enabled ? o.input : 0 }))
    : (d.outputs ?? []).map((o) => ({ number: o.number, name: o.name, input: o.inputVal, ratingA: outputRatingA(defs, d.type, o.number) })) })), pinFor, ioTag)
  return { outOpts, funcs }
}

// ---- Remove: disable what an instance made and unwire its outputs (back to what drove them before).
// CAN inputs and pins another applied template still relies on (`keep`) stay on.
export async function undoTemplate(api, devices, inst, keep = []) {
  const dev = devices.find((d) => d.guid === inst.guid); if (!dev) return
  const busyCan = new Set(keep.filter((i) => i.guid === inst.guid).flatMap((i) => i.cans ?? []))
  const pinKey = (p) => `${p.guid}|${p.kind}|${p.number}`
  const busyPin = new Set(keep.flatMap((i) => (i.pins ?? []).map(pinKey)))
  for (const n of inst.wired ?? []) await wireOut(api, dev, n, inst.prev?.[n] ?? 0).catch(() => {})
  for (const c of [...(inst.created ?? [])].reverse())
    if (!(c.kind === 'caninput' && busyCan.has(c.number))) await api.setFunction(dev.guid, c.kind, c.number, { enabled: false }).catch(() => {})
  for (const e of inst.enabled ?? []) if (!busyPin.has(pinKey(e))) await api.setFunction(e.guid, e.kind, e.number, { enabled: false }).catch(() => {})
}

// ---- Apply. sel = the picks as the UI holds them (outputs 'guid:n', local inputs a var index, remote ones
// 'remote:…'); inOpt(k) = the picked input's option; outOpts from loadOutputOptions. When `old` is given
// (an edit) it is undone first. Returns the new instance; on failure rolls back what it made and throws.
export async function applyTemplate(api, { devices, tpl, sel, relays, name, id, old = null, others = [], inOpt, outOpts }) {
  const dev = devices.find((d) => d.guid === logicModule(tpl, sel).guid)
  if (!dev) throw new Error('Pick an output first — the logic runs on the module that owns the outputs')
  const created = [], enabled = [], cans = [], pins = [], prev = {}
  const outName = (n) => outOpts.find((x) => x.value === `${dev.guid}:${n}`)?.name || 'output' + n
  let ctx = null
  try {
    if (old) await undoTemplate(api, devices, old, others)
    const s = { ...sel }
    for (const f of tpl.fields) {
      if (f.t === 'out' && !blank(s[f.k])) s[f.k] = numOut(s[f.k])
      if (!isInput(f) || blank(s[f.k])) continue
      const o = inOpt(f.k)
      // An unused pin reads nothing until it is enabled (on its own module).
      const pin = o?.phys && { guid: o.local ? dev.guid : o.source.guid, ...o.phys }
      const role = f.label.replace(/\s*[(/].*$/, '')   // 'Headlight switch', what the pin now does
      if (pin) { pins.push(pin); if (await ensureInputEnabled(api, pin.guid, o.phys, role)) enabled.push(pin) }
      if (typeof s[f.k] === 'number') continue
      if (!o?.sig) throw new Error(`${f.label}: that signal is no longer on the bus — pick it again`)
      // remote: decode its broadcast here, named after the role while the pin still has its factory name
      const r = await addCanInputFromFrame(api, dev.guid, broadcastFrame(o.source, isDefaultName(o.sig.label) ? { ...o.sig, label: role } : o.sig))
      if (!r.reused) created.push({ kind: 'caninput', number: r.number })
      cans.push(r.number)
      s[f.k] = f.t === 'bool' ? (r.stateIndex ?? r.valueIndex) : (r.valueIndex ?? r.stateIndex)
      if (s[f.k] == null) throw new Error(`${f.label}: created the CAN input but couldn't resolve its signal`)
    }
    const was = (n) => old?.prev?.[n] ?? outOpts.find((o) => o.value === `${dev.guid}:${n}`)?.input ?? 0
    ctx = await liveCtx({ api, guid: dev.guid, isCanboard: isCb(dev), outName, wireOutput: (n, idx) => { prev[n] ??= was(n); return wireOut(api, dev, n, idx) } })
    await tpl.build(ctx, s)
    return { id, key: tpl.key, name: (name ?? '').trim() || tpl.name, guid: dev.guid, sel: { ...sel }, relays: { ...relays },
      created: [...created, ...ctx.created], wired: ctx.wired, prev, enabled, cans, pins, at: new Date().toISOString() }
  } catch (e) {
    // Roll back what this run made so a failed apply leaves no half-built circuit.
    await undoTemplate(api, devices, { guid: dev.guid, created: [...created, ...(ctx?.created ?? [])], wired: ctx?.wired ?? [], prev, enabled }, others)
    throw e
  }
}

// ---- Picks by text, for agents: 'CB-1 DI3', 'PDM-01 J3-7', 'headlight'. Every word must appear in the
// option's label/search text (the pickers' own search); among several hits the one matching most words as
// whole tokens wins ('J3-1' is J3-1, not J3-10). A number is a local var index; an option's exact value matches too.
export function matchOption(opts, q) {
  const exact = opts.find((o) => o.value === q); if (exact) return exact   // a stored value (list_applied_templates' sel)
  if (typeof q === 'number') return { error: `no input with var index ${q}` }
  const words = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean)
  const text = (o) => (o.label + ' ' + (o.search ?? '')).toLowerCase()
  const hits = opts.filter((o) => words.every((w) => text(o).includes(w)))
  if (!hits.length) return { error: `nothing matches “${q}”` }
  const score = (o) => { const toks = new Set(text(o).split(/[\s·()]+/)); return words.filter((w) => toks.has(w)).length }
  const best = Math.max(...hits.map(score)), top = hits.filter((o) => score(o) === best)
  return top.length === 1 ? top[0] : { error: `“${q}” matches ${top.length}: ${top.slice(0, 8).map((o) => o.label).join(' | ')}` }
}

// Resolve a text request {key, picks: {field: text}, settings, relays, name} into the UI's sel + options,
// and preview it: what it would create, wiring per output, shortfalls. errors[] lists everything wrong.
export async function planTemplate(api, { devices, defs, templates, req }) {
  const tpl = templates.find((t) => t.key === req.key)
  if (!tpl) return { errors: [`unknown template “${req.key}” — one of ${templates.map((t) => t.key).join(', ')}`] }
  const mods = devices.filter(isMod), errors = []
  const sel = {}; for (const f of tpl.fields) sel[f.k] = f.def ?? (f.t === 'check' ? false : '')
  const relays = Object.fromEntries(tpl.fields.filter((f) => f.t === 'out').map((f) => [f.k, f.load !== 'load']))
  const picks = req.picks ?? {}
  for (const k of Object.keys({ ...picks, ...(req.settings ?? {}), ...(req.relays ?? {}) }))
    if (!tpl.fields.some((f) => f.k === k)) errors.push(`${tpl.key} has no field “${k}”`)
  for (const [k, v] of Object.entries(req.settings ?? {})) sel[k] = v
  for (const [k, v] of Object.entries(req.relays ?? {})) relays[k] = !!v
  const { outOpts, funcs } = await loadOutputOptions(api, mods, defs)
  const resolved = {}
  for (const f of tpl.fields.filter((f) => f.t === 'out' && !blank(picks[f.k]))) {
    const o = matchOption(outOpts, picks[f.k])
    if (o.error) errors.push(`${f.label}: ${o.error}`); else { sel[f.k] = o.value; resolved[f.k] = o.label }
  }
  const lm = logicModule(tpl, sel)
  if (lm.error) errors.push(lm.error)
  const dev = devices.find((d) => d.guid === lm.guid)
  const inOpts = {}
  if (dev) for (const f of tpl.fields.filter((f) => isInput(f) && !blank(picks[f.k]))) {
    inOpts[f.k] ??= await loadInputOptions(api, dev, devices, f.t)
    const o = matchOption(inOpts[f.k], picks[f.k])
    if (o.error) errors.push(`${f.label}: ${o.error}`); else { sel[f.k] = o.value; resolved[f.k] = o.label }
  }
  const v = validate(tpl, sel); if (v) errors.push(v)
  let preview = null
  try {
    const s = { ...sel }; for (const f of tpl.fields) if (f.t === 'out' && !blank(s[f.k])) s[f.k] = numOut(s[f.k])
    preview = await previewTemplate(tpl, s, (n) => outOpts.find((x) => x.value === `${lm.guid}:${n}`)?.name || 'output' + n)
    const short = shortfalls(preview.need, funcs[lm.guid]); if (short.length) errors.push(`Not enough free slots on ${dev?.name}: ${short.join(', ')}`)
  } catch (e) { errors.push(e.message) }
  const taken = tpl.fields.filter((f) => f.t === 'out' && outOpts.find((o) => o.value === sel[f.k])?.used).map((f) => resolved[f.k])
  return { tpl, sel, relays, resolved, logic: dev ? { guid: dev.guid, name: dev.name } : null, preview, errors, taken,
    inOpt: (k) => (inOpts[k] ?? []).find((o) => o.value === sel[k] && o.value !== ''), outOpts }
}
