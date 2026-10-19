// Template Apply / Remove against the device API only (no Svelte, no browser), so the Templates tab and the
// backend's template runner (MCP list/preview/apply/remove_template, run in Jint from template-runtime.js)
// do exactly the same thing. `api` is store.js's api, or the backend's loopback twin with the same methods
// (functions, inputs, setFunction, outputConfig, broadcastSignals).
import { previewTemplate, liveCtx, outputOptions, logicModule, shortfalls, freedBy, validate, isInput, blank } from './templates.js'
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
export const binBody = (o, input, enabled = true) => {
  if (o == null || o.currentLimit == null)
    throw new Error(`Output ${o?.number ?? '?'} has no current limit yet — Read the module before writing/deploying so its trip point isn't guessed.`)
  return {
    Number: o.number, Enabled: enabled, Input: input,
    CurrentLimit: o.currentLimit, InrushLimit: o.inrushLimit ?? 50, InrushTime: o.inrushTime ?? 1000,
    ResetMode: o.resetMode ?? 0, ResetTime: o.resetTime ?? 1000, ResetCountLimit: o.resetCountLimit ?? 3,
    PwmEnabled: o.pwmEnabled ?? false, Freq: o.freq ?? 100, FixedDuty: o.fixedDuty ?? 100, MinDuty: o.minDuty ?? 0,
    SoftStart: o.softStart ?? false, SoftStartRamp: o.softStartRamp ?? 0,
    // Variable-PWM (duty/freq follow a signal) — carry through so a deploy/binburn doesn't reset them.
    VariableDutyCycle: o.variableDutyCycle ?? false, DutyCycleInput: o.dutyCycleInput ?? 0, DutyCycleDenom: o.dutyCycleDenom ?? 100,
    VariableFreq: o.variableFreq ?? false, FreqInput: o.freqInput ?? 0, FreqInputDenom: o.freqInputDenom ?? 1,
    RampDutyChanges: o.rampDutyChanges ?? false, PrimaryOutput: o.primaryOutput ?? -1,
    WarnLimit: o.warnLimit ?? 0, OpenLoadLimit: o.openLoadLimit ?? 0, OpenLoadTime: o.openLoadTime ?? 1000,
    UnderLimit: o.underLimit ?? 0, UnderTime: o.underTime ?? 1000, UnderTrip: !!o.underTrip,   // upstream subs 27-29: kept on a re-wire
    HardShortLimit: o.hardShortLimit ?? 0,   // upstream output sub 32: carried so a re-wire keeps it
    SoftStartTimeout: o.softStartTimeout ?? 0,   // upstream output sub 30: carried so a re-wire keeps it
    SoftStopTime: o.softStopTime ?? 0,   // upstream output sub 31: carried so a re-wire keeps it
  }
}

// Drive output n of `dev` from var index idx (PDM output config, or a CANBoard digital output's input).
export async function wireOut(api, dev, n, idx) {
  if (isCb(dev)) return api.setFunction(dev.guid, 'digitaloutput', n, { enabled: true, input: idx })
  await api.outputConfig(dev.guid, binBody((dev.outputs ?? []).find((x) => x.number === n) ?? { number: n }, idx))
}

// What output n of `dev` is now, in full (PDM: its device record; CANBoard: its digital output block), so a
// remove can put it back exactly — enabled state, PWM and all, not just what drove it.
export async function outputSnapshot(api, dev, n) {
  const o = isCb(dev) ? (await api.functions(dev.guid))?.digitalOut?.find((x) => x.number === n) : (dev.outputs ?? []).find((x) => x.number === n)
  return o ? JSON.parse(JSON.stringify(o)) : null
}
const restoreOutput = (api, dev, s) => isCb(dev) ? api.setFunction(dev.guid, 'digitaloutput', s.number, s) : api.outputConfig(dev.guid, binBody(s, s.inputVal ?? 0, !!s.enabled))

// A block slot back to what it held before (a template only ever takes free slots, so that is a disabled
// block, but its old fields count: the module config should come back byte for byte). caninput: id before
// ide, as on create (CanInput.Id's setter forces Ide).
function restoreSlot(api, guid, c) {
  if (!c.before) return api.setFunction(guid, c.kind, c.number, { enabled: false })
  const { id, ide, ...rest } = c.before
  return api.setFunction(guid, c.kind, c.number, c.kind === 'caninput' ? { ...rest, id, ide } : c.before)
}

// ---- Add a local CAN input on `consumerGuid` decoding a frame slice. Returns the caninput number + the
// varmap indices of its decoded ports: valueIndex (analog, float) and stateIndex (the 1-bit boolean).
// `frame` = {name, id, ide, startBit, length, byteOrder, factor, offset, isSigned}.
export async function addCanInputFromFrame(api, consumerGuid, frame) {
  const f = await api.functions(consumerGuid)
  // Idempotent: a CAN input already decoding this exact frame slice is reused, so clicking the same remote
  // signal twice (or from two pickers) doesn't pile up duplicates ("ignition" ×5 in every list).
  // A 1-bit input is read through its State, so only one that reads "on when not 0" is the same signal.
  // Same bits only when read the same way: byte order and sign, and for a number its scale (an RPM read as Intel,
  // or raw instead of ×0.25, is a different value even at the same start bit).
  const same = (f?.canInputs ?? []).find((x) => x.enabled && x.id === frame.id && !!x.ide === !!frame.ide && x.startBit === frame.startBit && x.bitLength === frame.length
    && (x.byteOrder ?? 0) === (frame.byteOrder ?? 0) && !!x.signed === !!frame.isSigned
    && (frame.length === 1 ? x.operator === 1 && !x.operand : (x.factor ?? 1) === (frame.factor ?? 1) && (x.offset ?? 0) === (frame.offset ?? 0)))
  if (same) {
    const ins0 = await api.inputs(consumerGuid).catch(() => [])
    return { number: same.number, name: same.name, reused: true,
      stateIndex: ins0.find((x) => x.name === same.name)?.index ?? null,
      valueIndex: ins0.find((x) => x.name === same.name + ' Value')?.index ?? null }
  }
  const free = (f?.canInputs ?? []).find((x) => !x.enabled)   // also its `before` snapshot
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
    number: free.number, name, before: JSON.parse(JSON.stringify(free)),
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
// Returns what the pin was (truthy) when it had to enable it, so a remove can restore its name too.
export async function ensureInputEnabled(api, guid, phys, name) {
  if (!phys) return false
  const f = await api.functions(guid)
  const list = phys.kind === 'input' ? (f?.inputs ?? f?.digitalIn) : f?.analogIn
  const x = (list ?? []).find((i) => i.number === phys.number)
  if (!x || x.enabled) return false
  await api.setFunction(guid, phys.kind, phys.number, { enabled: true, ...(isDefaultName(x.name) && name ? { name: name.slice(0, 20) } : {}) })
  return { enabled: false, name: x.name }
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

// Watch an apply / remove's writes. The device API saves to the project only (written:false) while a module
// is off the bus, so a module that drops out ends up partly or not at all written while the rest went live.
// Returns [api, partial] — partial() = when anything was written live, the modules that took any write only
// into the project (none when it all went to the project: an offline edit, Deploy covers it).
export function trackWrites(api, devices) {
  const seen = new Map()
  const note = (g, r) => { if (!seen.has(g)) seen.set(g, new Set()); seen.get(g).add(r?.written === false ? 'project' : 'live'); return r }
  const t = { ...api,
    setFunction: async (g, ...a) => note(g, await api.setFunction(g, ...a)),
    outputConfig: async (g, b) => note(g, await api.outputConfig(g, b)),
    deviceInputs: async (g, b) => note(g, await api.deviceInputs(g, b)) }
  const anyLive = () => [...seen.values()].some((s) => s.has('live'))
  return [t, () => (anyLive() ? [...seen].filter(([, s]) => s.has('project')).map(([g]) => devices.find((d) => d.guid === g)?.name ?? g) : [])]
}
const partialMsg = (names, what) => `${names.join(', ')} dropped off the bus during ${what}: some changes went only into the project`

// ---- Remove: put back every output, block slot and pin the instance touched, as it was before (instances
// saved before snapshots existed: outputs back to their old driver, blocks just disabled).
// CAN inputs and pins another applied template still relies on (`keep`) stay on.
export async function undoTemplate(api0, devices, inst, keep = []) {
  const dev = devices.find((d) => d.guid === inst.guid); if (!dev) return
  const [api, partial] = trackWrites(api0, devices)
  const devOf = (g) => devices.find((d) => d.guid === g)
  // Outputs are keyed '<guid>:<n>'; instances saved before outputs could sit on other modules used a bare n
  // (on the logic module). CAN inputs: a bare number on the logic module, '<guid>|<n>' elsewhere.
  const key = (w) => (/^\d+$/.test(String(w)) ? `${inst.guid}:${w}` : String(w))
  const canKey = (i, c) => (typeof c === 'number' ? `${i.guid}|${c}` : c)
  const busyCan = new Set(keep.flatMap((i) => (i.cans ?? []).map((c) => canKey(i, c))))
  const pinKey = (p) => `${p.guid}|${p.kind}|${p.number}`
  const busyPin = new Set(keep.flatMap((i) => (i.pins ?? []).map(pinKey)))
  // Every step runs even when one fails; the failures are reported together at the end (so a partial
  // remove is never silent, and running Remove again retries them).
  const failed = []
  const step = async (what, f) => { try { await f() } catch (e) { failed.push(`${what}: ${e?.message ?? e}`) } }
  const name = (g) => devOf(g)?.name ?? g
  const snaps = Object.fromEntries(Object.entries(inst.outs ?? {}).map(([k, s]) => [key(k), s]))
  for (const w of inst.wired ?? []) {
    const k = key(w), [g, n] = k.split(':'), d = devOf(g)
    if (!snaps[k] && d) await step(`${name(g)} output ${n}`, () => wireOut(api, d, +n, inst.prev?.[k] ?? inst.prev?.[w] ?? 0))
  }
  if (inst.device) await step(`${name(inst.guid)} retry-all signal`, () => api.deviceInputs(inst.guid, inst.device))   // module settings it set
  for (const [k, s] of Object.entries(snaps)) { const g = k.split(':')[0], d = devOf(g); if (s && d) await step(`${name(g)} output ${s.number}`, () => restoreOutput(api, d, s)) }
  for (const c of [...(inst.created ?? [])].reverse()) {
    const g = c.guid ?? inst.guid, k = `${g}|${c.number}`
    if (!(c.kind === 'caninput' && busyCan.has(k))) { await step(`${name(g)} ${c.kind} ${c.number}`, () => restoreSlot(api, g, c)); continue }
    // still decoded for another applied template: it inherits the slot (and its before), so removing that
    // one later puts it back
    const heir = keep.find((i) => (i.cans ?? []).some((x) => canKey(i, x) === k))
    heir.created = [...(heir.created ?? []), { ...c, guid: g }]
  }
  for (const e of inst.enabled ?? []) {
    if (!busyPin.has(pinKey(e))) { await step(`${name(e.guid)} ${e.kind} ${e.number}`, () => api.setFunction(e.guid, e.kind, e.number, { enabled: false, ...(e.name ? { name: e.name } : {}) })); continue }
    // another applied template still reads the pin: it inherits switching it off (as CAN inputs do above)
    const heir = keep.find((i) => (i.pins ?? []).some((p) => pinKey(p) === pinKey(e)))
    if (!(heir.enabled ?? []).some((x) => pinKey(x) === pinKey(e))) heir.enabled = [...(heir.enabled ?? []), e]
  }
  if (failed.length) throw new Error(`couldn't put back ${failed.length} thing(s): ${failed.join('; ')}`)
  // not done on the module yet: keep the instance so Remove can run again once it is back
  if (partial().length) throw new Error(partialMsg(partial(), 'Remove') + ' — Remove again once it is back')
}

// The broadcast signal names a module sends var `v` ({kind, number, prop} of /inputs) under (PDM / CANBoard).
function broadcastNames(v) {
  const n = v?.number, base = { virtualinput: 'VirtualInput', timer: 'Timer', flasher: 'Flasher', condition: 'Condition', counter: 'Counter' }[v?.kind]
  if (base) return [base + n, `${base}${n}.State`]
  if (v?.kind === 'caninput') return v.prop === 'Value' ? [`CanInput${n}.Value`] : [`CanInput${n}`]
  if (v?.kind === 'input') return [`Input${n}.State`, `DigitalInput${n}.State`]
  if (v?.kind === 'output') return [`Output${n}.State`]
  if (v?.kind === 'digitaloutput') return [`DigitalOutput${n}.State`]
  if (v?.kind === 'wiper') return [{ 'Slow Output': 'WiperSlowState', 'Fast Output': 'WiperFastState' }[v.prop]]
  if (v?.kind === 'analoginput') return [`AnalogInput${n}.${v.prop === 'Rotary Position' ? 'Pos' : 'Millivolts'}`, `RotarySwitch${n}.Pos`]
  return []
}

// Make module `to` follow var `idx` of module `from` (an output on `to` driven by `from`'s logic): a CAN
// input on `to` decoding `from`'s broadcast of it, reused when one already does. Always On maps to `to`'s own.
// Returns addCanInputFromFrame's result ({number, stateIndex, reused, before}) or {stateIndex} for Always On.
export async function followSignal(api, from, to, idx) {
  const v = (await api.inputs(from.guid)).find((x) => x.index === idx)
  if (v?.name === 'Always On') return { stateIndex: (await api.inputs(to.guid)).find((x) => x.name === 'Always On')?.index ?? 1 }
  const names = broadcastNames(v), sig = (await api.broadcastSignals(from.guid)).find((x) => names.includes(x.name))
  if (!sig) throw new Error(`${from.name} does not broadcast “${v?.name ?? 'signal ' + idx}”, so an output on ${to.name} can't follow it — pick that output on ${from.name}`)
  const r = await addCanInputFromFrame(api, to.guid, broadcastFrame(from, { ...sig, label: `${from.name} ${v.name ?? sig.name}`.slice(0, 32) }))
  if (r.stateIndex == null) throw new Error(`created the CAN input on ${to.name} but couldn't resolve its signal`)
  return r
}

// Outputs picked on modules other than the logic one, per module: each takes a free CAN input there.
// Returns shortfall messages like 'CB-2: 2 CAN inputs (1 free)'.
export function remoteShortfalls(tpl, sel, logicGuid, funcs, devices, freed = {}) {
  const n = new Map()
  for (const f of tpl.fields) if (f.t === 'out' && !blank(sel[f.k])) { const g = String(sel[f.k]).split(':')[0]; if (g !== logicGuid) n.set(g, (n.get(g) ?? 0) + 1) }
  const out = []
  for (const [g, c] of n) { const free = (funcs?.[g]?.canInputs ?? []).filter((x) => !x.enabled).length + (freed[g]?.canInputs ?? 0); if (free < c) out.push(`${devices.find((d) => d.guid === g)?.name ?? g}: ${c} CAN inputs (${free} free)`) }
  return out
}

// ---- Apply. sel = the picks as the UI holds them (outputs 'guid:n', local inputs a var index, remote ones
// 'remote:…'); inOpt(k) = the picked input's option; outOpts from loadOutputOptions. When `old` is given
// (an edit) it is undone first. Returns the new instance; on failure rolls back what it made and throws.
// The result's `partial` (not part of the instance) names modules that took only some of the writes live.
export async function applyTemplate(api0, { devices, tpl, sel, relays, name, id, old = null, others = [], inOpt, outOpts }) {
  const [api, partial] = trackWrites(api0, devices)
  const dev = devices.find((d) => d.guid === logicModule(tpl, sel).guid)
  if (!dev) throw new Error('Pick an output first — the logic runs on the module that owns the outputs')
  const devOf = (g) => devices.find((d) => d.guid === g)
  const created = [], enabled = [], cans = [], pins = [], prev = {}, outs = {}
  const outName = (o) => outOpts.find((x) => x.value === o)?.name || 'output ' + numOut(o)
  // What an old instance stored for output v (older instances keyed outputs on the logic module by bare n).
  const oldOf = (map, v) => old && (map?.[v] ?? (v.startsWith(old.guid + ':') ? map?.[numOut(v)] : undefined))
  // Each picked output as it is before this template; an edit keeps the snapshots from the first apply.
  const picked = tpl.fields.filter((f) => f.t === 'out' && !blank(sel[f.k])).map((f) => String(sel[f.k]))
  for (const v of picked) {
    const d = devOf(v.split(':')[0]); if (!d) throw new Error(`The module of ${v} is not in the project`)
    outs[v] = oldOf(old?.outs, v) ?? await outputSnapshot(api, d, numOut(v))
  }
  // An output on another module follows the logic's broadcast of `idx` through a CAN input there.
  const wireRemote = async (d, n, idx) => {
    const r = idx ? await followSignal(api, dev, d, idx) : { stateIndex: 0 }
    if (r.number != null) { if (!r.reused) created.push({ guid: d.guid, kind: 'caninput', number: r.number, before: r.before }); cans.push(`${d.guid}|${r.number}`) }
    return wireOut(api, d, n, r.stateIndex)
  }
  let ctx = null
  try {
    if (old) await undoTemplate(api, devices, old, others)
    const s = { ...sel }
    for (const f of tpl.fields) {
      if (!isInput(f) || blank(s[f.k])) continue
      const o = inOpt(f.k)
      // An unused pin reads nothing until it is enabled (on its own module).
      const pin = o?.phys && { guid: o.local ? dev.guid : o.source.guid, ...o.phys }
      const role = f.label.replace(/\s*[(/].*$/, '')   // 'Headlight switch', what the pin now does
      if (pin) { pins.push(pin); const was = await ensureInputEnabled(api, pin.guid, o.phys, role); if (was) enabled.push({ ...pin, name: was.name }) }
      if (typeof s[f.k] === 'number') continue
      if (!o?.sig) throw new Error(`${f.label}: that signal is no longer on the bus — pick it again`)
      // remote: decode its broadcast here, named after the role while the pin still has its factory name
      const r = await addCanInputFromFrame(api, dev.guid, broadcastFrame(o.source, isDefaultName(o.sig.label) ? { ...o.sig, label: role } : o.sig))
      if (!r.reused) created.push({ kind: 'caninput', number: r.number, before: r.before })
      cans.push(r.number)
      s[f.k] = f.t === 'bool' ? (r.stateIndex ?? r.valueIndex) : (r.valueIndex ?? r.stateIndex)
      if (s[f.k] == null) throw new Error(`${f.label}: created the CAN input but couldn't resolve its signal`)
    }
    const was = (v) => oldOf(old?.prev, v) ?? outOpts.find((o) => o.value === v)?.input ?? 0
    ctx = await liveCtx({ api, guid: dev.guid, isCanboard: isCb(dev), outName, wireOutput: (v, idx) => {
      prev[v] ??= was(v)
      const [g, n] = String(v).split(':')
      return g === dev.guid ? wireOut(api, dev, +n, idx) : wireRemote(devOf(g), +n, idx)
    } })
    await tpl.build(ctx, s)
    const p = partial()
    return { ...(p.length ? { partial: partialMsg(p, 'Apply') + ` — Write All ${p.length > 1 ? 'them' : 'it'} (device_action writeall), then Burn` } : {}), id, key: tpl.key, name: (name ?? '').trim() || tpl.name, guid: dev.guid, sel: { ...sel }, relays: { ...relays },
      created: [...created, ...ctx.created], wired: ctx.wired, prev, outs, enabled, cans, pins, ...(ctx.device ? { device: ctx.device } : {}), at: new Date().toISOString() }
  } catch (e) {
    // Roll back what this run made so a failed apply leaves no half-built circuit.
    await undoTemplate(api, devices, { guid: dev.guid, created: [...created, ...(ctx?.created ?? [])], wired: ctx?.wired ?? [], prev, outs, enabled, cans, device: ctx?.device }, others)
      .catch((u) => { e.message += ` (and the roll-back ${u.message})` })
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
// old = the applied instance an edit replaces (its slots count as free).
export async function planTemplate(api, { devices, defs, templates, req, old = null }) {
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
  for (const f of tpl.fields.filter((f) => f.t === 'module' && !blank(picks[f.k]))) {
    const d = mods.find((x) => x.name.toLowerCase() === String(picks[f.k]).trim().toLowerCase())
    if (!d) errors.push(`${f.label}: no module called “${picks[f.k]}”`); else { sel[f.k] = d.guid; resolved[f.k] = d.name }
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
    preview = await previewTemplate(tpl, { ...sel }, (o) => outOpts.find((x) => x.value === o)?.name || 'output ' + numOut(o))
    const freed = freedBy(old)
    const short = shortfalls(preview.need, funcs[lm.guid], freed[lm.guid]); if (short.length) errors.push(`Not enough free slots on ${dev?.name}: ${short.join(', ')}`)
    const rs = remoteShortfalls(tpl, sel, lm.guid, funcs, devices, freed); if (rs.length) errors.push(`Outputs on other modules follow the logic over CAN — not enough free CAN inputs on ${rs.join(', ')}`)
  } catch (e) { errors.push(e.message) }
  const taken = tpl.fields.filter((f) => f.t === 'out' && outOpts.find((o) => o.value === sel[f.k])?.used).map((f) => resolved[f.k])
  return { tpl, sel, relays, resolved, logic: dev ? { guid: dev.guid, name: dev.name } : null, preview, errors, taken,
    inOpt: (k) => (inOpts[k] ?? []).find((o) => o.value === sel[k] && o.value !== ''), outOpts }
}
