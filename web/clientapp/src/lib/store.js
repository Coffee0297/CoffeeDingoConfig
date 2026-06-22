import { writable, get } from 'svelte/store'
import * as signalR from '@microsoft/signalr'
import { toast } from './toast.js'

// Live telemetry pushed from the .NET backend (devices + CAN stats), 10 Hz
export const telemetry = writable({
  connected: false, adapter: null, canTotal: 0, canRate: 0, ids: [], devices: [],
})

// Hub (SignalR) connection state, separate from the CAN-adapter status that rides
// inside the telemetry payload — so the UI can tell "device offline" from "we lost the
// live feed entirely". 'live' | 'reconnecting' | 'down'. `stale` flags telemetry that is
// no longer being refreshed (frozen) so cards can grey out instead of lying.
export const hubState = writable('live')

const conn = new signalR.HubConnectionBuilder()
  .withUrl('/hub/live')
  // Keep retrying indefinitely (the default policy gives up after ~30 s). Back off to a
  // steady 30 s once the quick attempts fail, so a long outage still recovers on its own.
  .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (c) => [0, 2000, 5000, 10000][c.previousRetryCount] ?? 30000 })
  .build()
conn.on('telemetry', (d) => telemetry.set(d))
// Backend "notify" channel (device success messages + ack-timeout write failures). An Error-level
// notify means a queued write/burn was never acknowledged by the device — surface it as a red toast
// so the user is never left thinking a write succeeded when it physically did not.
conn.on('notify', (e) => {
  const lvl = (e?.level ?? e?.Level ?? '').toString()
  const kind = lvl === 'Error' || lvl === 'Warning' ? 'error' : 'info'
  const msg = (e?.source ? e.source + ': ' : '') + (e?.message ?? e?.Message ?? '')
  if (msg.trim()) toast(msg, kind, kind === 'error' ? 8000 : 4000)
})
conn.onreconnecting(() => { hubState.set('reconnecting'); telemetry.update((t) => ({ ...t, stale: true })) })
conn.onreconnected(() => hubState.set('live'))
conn.onclose(() => { hubState.set('down'); telemetry.update((t) => ({ ...t, stale: true })) })
conn.start().then(() => hubState.set('live')).catch((e) => { console.error('SignalR connect failed', e); hubState.set('down') })
// Manual reconnect for the "down" (gave-up) state.
export async function reconnectHub() {
  try { hubState.set('reconnecting'); await conn.start(); hubState.set('live') }
  catch (e) { hubState.set('down'); throw e }
}

// ponytail: test seam — lets a harness stop the live feed and inject synthetic
// telemetry (e.g. to exercise the overload recorder without real over-current).
// Gated to dev builds so it is stripped from the production bundle (npm run build).
if (import.meta.env?.DEV && typeof window !== 'undefined') { window.__telemetry = telemetry; window.__conn = conn }

// Overload (trip) events now live ON THE DEVICE — the firmware records each trip with a
// current waveform around it (−10 s / +3 s). The tool reads them back on demand via
// api.overloads(guid); the Logs ▸ Overloads tab renders them. (Previously the tool
// captured these from live telemetry, which missed trips while disconnected.)

async function j(method, url, body, timeoutMs = 15000) {
  // Abort a hung request (wedged CAN adapter / stalled device) so callers' busy flags
  // clear instead of spinning forever. Flash uses its own raw fetch (legitimately long).
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), timeoutMs)
  let r
  try {
    r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `Request timed out after ${timeoutMs / 1000}s — is the device responding?` : `Network error: ${e.message}`)
  } finally { clearTimeout(to) }
  if (!r.ok) throw new Error(await r.text())
  // An empty / non-JSON 200 body resolves to null (not a synthesized {}), so a caller can never
  // mistake "no body" for a populated, confirmed result. Write endpoints return explicit JSON.
  return r.json().catch(() => null)
}

export const api = {
  adapters: () => j('GET', '/api/adapters'),
  connect: (Adapter, Port, Bitrate) => j('POST', '/api/connect', { Adapter, Port, Bitrate }),
  disconnect: () => j('POST', '/api/disconnect'),
  identify: () => j('GET', '/api/identify'),
  addDevice: (Type, Name, BaseId) => j('POST', '/api/devices', { Type, Name, BaseId }),
  modify: (guid, Name, BaseId) => j('POST', `/api/devices/${guid}/modify`, { Name, BaseId }),
  rename: (guid, Name) => j('POST', `/api/devices/${guid}/rename`, { Name }),
  remove: (guid) => j('POST', `/api/devices/${guid}/remove`),
  action: (guid, act) => j('POST', `/api/devices/${guid}/${act}`),
  outputConfig: (guid, body) => j('POST', `/api/devices/${guid}/outputconfig`, body),
  signals: (guid) => j('GET', `/api/devices/${guid}/signals`),
  inputs: (guid, type) => j('GET', `/api/devices/${guid}/inputs${type ? `?type=${type}` : ''}`),
  functions: (guid) => j('GET', `/api/devices/${guid}/functions`),
  luaUpload: (guid, Source) => j('POST', `/api/devices/${guid}/lua`, { Source }),
  luaRead: (guid) => j('GET', `/api/devices/${guid}/lua`),
  luaError: (guid) => j('GET', `/api/devices/${guid}/luaerror`),
  overloads: (guid) => j('GET', `/api/devices/${guid}/overloads`),
  overloadsClear: (guid) => j('POST', `/api/devices/${guid}/overloads/clear`),
  async flash(guid, bytes) {
    const r = await fetch(`/api/devices/${guid}/flash`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })
    if (!r.ok) throw new Error(await r.text())
    return r.json()
  },
  // Flash a blank / new module already in DFU (BOOT0 + reset) — no bus device needed.
  async flashBlank(bytes) {
    const r = await fetch('/api/flash/blank', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })
    if (!r.ok) throw new Error(await r.text())
    return r.json()
  },
  flashStatus: () => j('GET', '/api/flash/status'),
  flashScan: () => j('GET', '/api/flash/dfu'),   // list DFU devices dfu-util can see
  setFunction: (guid, kind, number, body) => j('POST', `/api/devices/${guid}/function/${kind}/${number}`, body),
  writeParam: (guid, Index, Sub, Value) => j('POST', `/api/devices/${guid}/writeparam`, { Index, Sub, Value }),
  sdoRead: (Node, Index, Sub) => j('POST', '/api/sdo/read', { Node, Index, Sub }),
  sdoWrite: (Node, Index, Sub, Value, Size) => j('POST', '/api/sdo/write', { Node, Index, Sub, Value, Size }),
  sdoStore: (Node) => j('POST', '/api/sdo/store', { Node }),
  dbcSignals: (guid) => j('GET', `/api/devices/${guid}/dbc/signals`),
  dbcAddSignal: (guid, body) => j('POST', `/api/devices/${guid}/dbc/signal`, body),
  async dbcOpen(guid, text) {
    const r = await fetch(`/api/devices/${guid}/dbc/open`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text })
    if (!r.ok) throw new Error(await r.text())
    return r.json()
  },
  canlog: () => j('GET', '/api/canlog'),
  syslog: () => j('GET', '/api/syslog'),
  project: () => j('GET', '/api/project'),
  projSave: (FileName) => j('POST', '/api/project/save', { FileName }),
  projOpen: (FileName) => j('POST', '/api/project/open', { FileName }),
  projNew: () => j('POST', '/api/project/new'),
  projDownload: () => j('GET', '/api/project/download'),   // full project JSON for a browser save
  async projUpload(text) {                                  // load a project file picked on the PC
    const r = await fetch('/api/project/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text })
    if (!r.ok) throw new Error(await r.text())
    return r.json()
  },
  applyConfig: (doc) => j('POST', '/api/config', doc),
  // Commissioning a module writes its ENTIRE param set (thousands of paced CAN frames) then
  // re-addresses + burns — far longer than the default 15s. Use a long timeout so the client
  // waits for the whole sequence and still runs its cleanup (remove the opened entry); aborting
  // early left the re-addressed module AND the source as a duplicate.
  applyProfile: (targetGuid, source) => j('POST', `/api/devices/${targetGuid}/apply-profile`, { Source: source }, 120000),
  configTemplate: () => j('GET', '/api/config/template'),
  configSnapshot: (lua) => j('GET', '/api/config' + (lua ? '?lua=true' : '')),
  definitions: () => j('GET', '/api/definitions'),
}

// Minimum recommended copper wire gauge to carry an output's current LIMIT (the trip
// point) on a short automotive run, with insulation/bundling headroom so the wire is
// never the weak link before the dingoPDM trips. Conservative — for long runs or
// voltage-drop-sensitive loads (lighting), step up a size. Based on the current limit,
// not the expected load, on purpose.
// ponytail: lookup table, not a thermal model — the physical world needs a margin a
// formula won't give. Edit the thresholds if your insulation/run length differ.
export function awgFor(limitA) {
  const a = Number(limitA) || 0
  if (a <= 0) return null
  // [maxAmps, AWG, EU/IEC cross-section mm²]. Automotive thin-wall, short run — sized to
  // the trip point. mm² are real EU stock sizes; AWG is the nearest equivalent.
  const tbl = [[7, '20', 0.5], [10, '18', 0.75], [15, '16', 1.5], [24, '14', 2.5], [32, '12', 4], [45, '10', 6], [60, '8', 10]]
  for (const [max, awg, mm2] of tbl) if (a <= max) return { awg, mm2 }
  return { awg: '6', mm2: 16 }
}

// Standard EU/IEC wire cross-sections with nearest AWG, for the manual gauge override.
export const WIRE_GAUGES = [
  { mm2: 0.5, awg: '20' }, { mm2: 0.75, awg: '18' }, { mm2: 1.0, awg: '17' }, { mm2: 1.5, awg: '16' },
  { mm2: 2.5, awg: '14' }, { mm2: 4, awg: '12' }, { mm2: 6, awg: '10' }, { mm2: 10, awg: '8' },
  { mm2: 16, awg: '6' }, { mm2: 25, awg: '4' }, { mm2: 35, awg: '2' },
]
export const awgForMm2 = (mm2) => WIRE_GAUGES.find((g) => g.mm2 === Number(mm2))?.awg ?? '?'

// Device hardware specs (per-model counts + per-output current ratings, icons, min firmware, …)
// are NOT hardcoded here — they come from the backend, whose single source of truth is
// pdm-definitions.json. Fetched once at startup into this store.
export const deviceDefs = writable({ pdms: [], canboards: [] })
api.definitions().then((d) => { if (d) deviceDefs.set(d) }).catch((e) => console.warn('definitions load failed', e))

// Rated channel current (A) for an output, looked up from the loaded definitions by the device's
// type name and output NUMBER (OUT1 = index 0). null when unknown (the UI then shows no rating).
// Setting a trip above the rating is allowed — advisory only; callers just flag it.
export function outputRatingA(defs, deviceType, outputNumber) {
  const t = (deviceType || '').toLowerCase()
  const all = [...(defs?.pdms ?? []), ...(defs?.canboards ?? [])]
  const def = all.find((d) => (d.typeName || '').toLowerCase() === t)
  const r = def?.outputCurrentRatings
  return Array.isArray(r) ? (r[(Number(outputNumber) | 0) - 1] ?? null) : null
}

// Voltage drop over a copper wire run at a given current. lengthM is one-way; the feed +
// return path is 2·L. ρ ≈ 0.0175 Ω·mm²/m (copper, slightly warm). Returns volts + % of
// system voltage (13.8 V running) or null if inputs are incomplete.
export function vDrop(lengthM, amps, mm2, sysV = 13.8) {
  const L = Number(lengthM) || 0, I = Number(amps) || 0, A = Number(mm2) || 0
  if (L <= 0 || I <= 0 || A <= 0) return null
  const volts = (2 * L * I * 0.0175) / A
  return { volts, pct: (volts / sysV) * 100 }
}

// ===========================================================================
// Node-graph wiring — maps the device's VarMap (every function's input is a
// varmap index pointing at another function's output) to/from a node graph.
// VarMap layout MUST match the firmware/domain InitVarMap order.
// ===========================================================================
export const SYS_VARS = ['None', 'Always On', 'State', 'Temperature', 'Battery Voltage']
const KP_BTNS = 20, KP_DIALS = 2, KP_AIN = 4, LUA_SLOTS = 32

// Which input fields each function node exposes (target handles). JSON field names.
export const NODE_INPUTS = {
  output: ['input'], virtualinput: ['var0', 'var1', 'var2'], condition: ['input'],
  flasher: ['input'], counter: ['incInput', 'decInput', 'resetInput'], canoutput: ['input'],
}

// Build varmap index ⇄ source {node id, port}. idxToSrc[i] = {id, port}; srcToIdx['id|port']=i.
export function varMapSources(funcs, outputs) {
  const idxToSrc = {}, srcToIdx = {}
  let i = 0
  const put = (id, port) => { idxToSrc[i] = { id, port }; srcToIdx[id + '|' + port] = i; i++ }
  SYS_VARS.forEach((n, k) => put('sys:' + k, 'out'))
  ;(funcs?.inputs ?? []).forEach((_, k) => put('digin:' + (k + 1), 'out'))
  ;(funcs?.canInputs ?? []).forEach((_, k) => { put('caninput:' + (k + 1), 'state'); put('caninput:' + (k + 1), 'value') })
  ;(funcs?.virtualInputs ?? []).forEach((_, k) => put('virtualinput:' + (k + 1), 'out'))
  ;(outputs ?? []).forEach((o) => { for (const p of ['on', 'current', 'oc', 'fault']) put('output:' + o.number, p) })
  ;(funcs?.flashers ?? []).forEach((_, k) => put('flasher:' + (k + 1), 'out'))
  ;(funcs?.conditions ?? []).forEach((_, k) => put('condition:' + (k + 1), 'out'))
  ;(funcs?.counters ?? []).forEach((_, k) => put('counter:' + (k + 1), 'out'))
  for (const p of ['slow', 'fast', 'park', 'inter', 'wash', 'swipe']) put('wiper', p)
  ;(funcs?.keypads ?? []).forEach((_, ki) => {
    for (let b = 0; b < KP_BTNS; b++) put('kpbtn:' + (ki + 1) + ':' + (b + 1), 'out')
    for (let d = 0; d < KP_DIALS; d++) put('kpdial:' + (ki + 1) + ':' + (d + 1), 'out')
    for (let a = 0; a < KP_AIN; a++) put('kpain:' + (ki + 1) + ':' + (a + 1), 'out')
  })
  for (let l = 0; l < LUA_SLOTS; l++) put('lua:' + l, 'out')
  return { idxToSrc, srcToIdx }
}

// Apply a graph edge: write the target function's input field = the source's varmap index.
export async function applyGraphConnection(guid, targetId, field, varIndex, devices) {
  const ci = targetId.indexOf(':')
  const kind = targetId.slice(0, ci), num = parseInt(targetId.slice(ci + 1), 10)
  if (kind === 'output') {
    const d = (devices ?? []).find((x) => x.guid === guid)
    const o = (d?.outputs ?? []).find((x) => x.number === num) ?? { number: num }
    // Preserve EVERY protection field from the live output — the backend replaces the whole
    // output config, so anything not echoed back here is wiped. Only Input changes when wiring.
    await api.outputConfig(guid, _binBody(o, varIndex))
  } else {
    await api.setFunction(guid, kind, num, { enabled: true, [field]: varIndex })
  }
}

// Function-array key for each creatable node kind.
const KIND_ARR = { caninput: 'canInputs', virtualinput: 'virtualInputs', condition: 'conditions', counter: 'counters', flasher: 'flashers', canoutput: 'canOutputs' }

// Create (enable) a function node from the canvas — claims the first free slot of that kind.
// Returns the new node id (kind:number) or null if none free / not creatable.
export async function enableFunction(guid, kind) {
  const arr = KIND_ARR[kind]; if (!arr) return null
  const f = await api.functions(guid)
  const free = (f?.[arr] ?? []).find((x) => !x.enabled)
  if (!free) return null
  await api.setFunction(guid, kind, free.number, { enabled: true })
  return kind + ':' + free.number
}

// ---- Cross-device bridges: pull another module's signal onto this module via an auto
// CAN output (source) + CAN input (target). CAN IDs from a reserved block, tracked so a
// given remote signal reuses one ID across deploys. ----
const GFX_ID_BASE = 0x580
const GFX_ID_MAX = 0x5FF   // bounded reserved window for auto-assigned bridge IDs
function loadBridges() { try { return JSON.parse(localStorage.getItem('dingoGfxBridges') || '{}') } catch { return {} } }
function saveBridges(b) { try { localStorage.setItem('dingoGfxBridges', JSON.stringify(b)) } catch {} }
function bridgeCanId(srcGuid, srcVar) {
  const b = loadBridges(); const key = srcGuid + '|' + srcVar
  if (b[key]) return b[key]
  // Avoid colliding with another bridge OR an ID already live on the bus (a keypad / CANopen node
  // / another module's frames). Stay inside a bounded window so we never wander into CANopen
  // address space, and fail loudly rather than hand back a colliding ID.
  const used = new Set(Object.values(b))
  let liveIds = new Set(); try { liveIds = new Set(get(telemetry).ids ?? []) } catch {}
  let id = GFX_ID_BASE
  while ((used.has(id) || liveIds.has(id)) && id <= GFX_ID_MAX) id++
  if (id > GFX_ID_MAX) throw new Error('No free bridge CAN ID available in 0x580–0x5FF — free one up or wire it manually.')
  b[key] = id; saveBridges(b); return id
}

// Ensure the remote signal (srcVar on srcGuid) is broadcast on CAN and received locally.
// Returns the LOCAL varmap index of the receiving CAN input (to bind a local target to).
export async function bridgeRemoteSignal(localGuid, srcGuid, srcVar, devices) {
  const id = bridgeCanId(srcGuid, srcVar)
  // 1. source device broadcasts srcVar on `id` (reuse an existing matching CAN output, else claim one)
  const sf = await api.functions(srcGuid)
  if (!(sf?.canOutputs ?? []).some((x) => x.enabled && x.id === id)) {
    const free = (sf?.canOutputs ?? []).find((x) => !x.enabled)
    if (!free) throw new Error('source module has no free CAN output')
    await api.setFunction(srcGuid, 'canoutput', free.number, { enabled: true, input: srcVar, ide: false, id, startBit: 0, bitLength: 1, byteOrder: 0, interval: 100, name: 'gfx' + id.toString(16) })
  }
  // 2. local device receives `id` (reuse an existing matching CAN input, else claim one)
  let lf = await api.functions(localGuid)
  let ci = (lf?.canInputs ?? []).find((x) => x.enabled && x.id === id)
  if (!ci) {
    const free = (lf?.canInputs ?? []).find((x) => !x.enabled)
    if (!free) throw new Error('this module has no free CAN input')
    await api.setFunction(localGuid, 'caninput', free.number, { enabled: true, ide: false, id, startBit: 0, bitLength: 1, byteOrder: 0, mode: 0, name: 'gfx' + id.toString(16) })
    lf = await api.functions(localGuid)
    ci = (lf?.canInputs ?? []).find((x) => x.id === id && x.enabled)
  }
  // 3. local varmap index of that CAN input's State port
  const localOuts = (devices ?? []).find((d) => d.guid === localGuid)?.outputs ?? []
  const { srcToIdx } = varMapSources(lf, localOuts)
  return srcToIdx['caninput:' + ci.number + '|state']
}

// ---- Lua snippets (authored per-function in the tool; the device stores one
// assembled program). Persisted to localStorage, keyed by device guid then a
// slot key ('global', 'out1'.. etc). ----
function loadLua() { try { return JSON.parse(localStorage.getItem('dingoLua') || '{}') } catch { return {} } }
export const luaSnippets = writable(loadLua())
luaSnippets.subscribe((v) => { try { localStorage.setItem('dingoLua', JSON.stringify(v)) } catch {} })

export const luaGet = (guid, key) => (get(luaSnippets)[guid]?.[key] ?? '')
// Copy a device's whole Lua snippet set onto another guid (used when flashing a profile
// onto a freshly-commissioned module so its Lua follows).
export function luaCopy(srcGuid, dstGuid) {
  luaSnippets.update((v) => ({ ...v, [dstGuid]: { ...(v[srcGuid] || {}) } }))
}
export function luaSet(guid, key, text) {
  luaSnippets.update((v) => { v[guid] = { ...(v[guid] || {}) }; v[guid][key] = text; return { ...v } })
}

// Split an assembled program back into { global, outs } using the section markers
// luaAssemble emits, so a device read-back lands on the right output tabs.
export function luaParse(text) {
  let body = (text || '').replace(/^-- Assembled by dingoConfig[^\n]*\n+/, '')
  const outs = {}
  let global = body.trim()
  const marker = body.search(/local function __fn_[a-z]+\d+\(\)/)
  if (marker >= 0) {
    global = body.slice(0, marker).trim()
    const block = body.slice(marker)
    const re = /local function __fn_([a-z]+\d+)\(\)\n([\s\S]*?)\nend\n/g
    let m
    while ((m = re.exec(block))) outs[m[1]] = m[2].replace(/^ {2}/gm, '')
  }
  return { global, outs }
}

// Read the program off the device and populate the per-function snippet store.
export async function luaReadToTabs(guid) {
  // api.luaRead can return null (j() yields null on an empty 200 body); never destructure it blind.
  const res = await api.luaRead(guid)
  const source = res?.source ?? ''
  const { global, outs } = luaParse(source)
  luaSnippets.update((v) => {
    const dev = {}
    if (global) dev.global = global
    for (const k of Object.keys(outs)) dev[k] = outs[k]
    return { ...v, [guid]: dev }
  })
  return source
}

// Concatenate the global section + every per-function snippet into one program.
// Per-function snippets are tick-body code, wrapped into the generated onTick
// (chained after any onTick the global defines), so all functions coexist.
export function luaAssemble(guid) {
  const v = get(luaSnippets)[guid] || {}
  let s = '-- Assembled by dingoConfig from per-function Lua. Do not hand-edit on the device.\n\n'
  if (v.global?.trim()) s += v.global.trimEnd() + '\n\n'
  // Cross-module generated block (System ▸ cross-module functions). It lives at global
  // scope (defines onCanRx + its own onTick), so the per-function wrapper below chains it.
  if (v.cmf?.trim()) s += v.cmf.trimEnd() + '\n\n'
  // any key like out3, caninput2, virtualinput1, canoutput4, condition5, …
  const keys = Object.keys(v).filter((k) => /^[a-z]+\d+$/.test(k) && v[k]?.trim()).sort()
  if (keys.length) {
    // Each snippet becomes its own function (defined once). Each is called inside a
    // pcall every tick, so one snippet's runtime error (e.g. a nil index) is isolated
    // — the others keep running — and the error is reported via luaLog(), which the
    // device exposes for read-back. luaLog is guarded so older firmware still runs.
    for (const k of keys) s += `local function __fn_${k}()\n${v[k].split('\n').map((l) => '  ' + l).join('\n')}\nend\n`
    s += 'local function __dingo_fns()\n'
    for (const k of keys) s += `  local ok, e = pcall(__fn_${k}); if not ok and luaLog then luaLog("${k}: " .. tostring(e)) end\n`
    s += 'end\n'
    s += 'local __dingo_userTick = onTick\n'
    s += 'function onTick()\n  if __dingo_userTick then __dingo_userTick() end\n  __dingo_fns()\nend\n'
  }
  return s
}

// ===========================================================================
// Cross-module functions — define a behaviour once (trigger + targets across
// modules, optional synced blink with a master clock + failover backup) and
// compile it to per-module Lua + output bindings, then deploy to each device.
// Stored client-side; deploy uses the existing luaUpload + outputConfig APIs.
// ===========================================================================
function loadCross() {
  try {
    const list = JSON.parse(localStorage.getItem('dingoCrossFns') || '[]')
    // Migrate: give every function a STABLE slot so its reserved CAN IDs don't shift when
    // another function is deleted/reordered (which previously remapped live CAN IDs).
    let next = 0
    for (const f of list) if (f && typeof f.slot === 'number') next = Math.max(next, f.slot + 1)
    for (const f of list) if (f && typeof f.slot !== 'number') f.slot = next++
    return list
  } catch { return [] }
}
export const crossFns = writable(loadCross())
crossFns.subscribe((v) => { try { localStorage.setItem('dingoCrossFns', JSON.stringify(v)) } catch {} })

// ---- Whole-project client state: everything kept in the browser (NOT on the device) — cross-module
// functions, per-function Lua snippets, CAN-bridge IDs, and layout (car-map pins + wiring-graph
// positions). Bundled into the saved project file so a Save/Open round-trips EVERYTHING. Device
// guids are preserved across save/load, so this state (keyed by / referencing device guids) stays
// valid on reload. ----
export function gatherClientState() {
  const ls = (k, def) => { try { return JSON.parse(localStorage.getItem(k) ?? def) } catch { return JSON.parse(def) } }
  const graph = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && (k.startsWith('dingoGraphPos:') || k.startsWith('dingoGraphRemotes:'))) graph[k] = localStorage.getItem(k)
    }
  } catch {}
  return {
    version: 1,
    crossFns: ls('dingoCrossFns', '[]'),
    lua: ls('dingoLua', '{}'),
    bridges: ls('dingoGfxBridges', '{}'),
    pinpos: ls('pinpos', '{}'),
    graph,
  }
}
export function restoreClientState(c) {
  // Opening a project replaces the whole project — including this state. A file with no client
  // section (e.g. saved before this existed) clears it, matching "the opened project has none".
  try {
    crossFns.set(Array.isArray(c?.crossFns) ? c.crossFns : [])              // store subscriptions persist these
    luaSnippets.set(c?.lua && typeof c.lua === 'object' ? c.lua : {})
    localStorage.setItem('dingoGfxBridges', JSON.stringify(c?.bridges ?? {}))
    localStorage.setItem('pinpos', JSON.stringify(c?.pinpos ?? {}))
    for (const [k, v] of Object.entries(c?.graph ?? {})) if (typeof v === 'string') localStorage.setItem(k, v)
  } catch (e) { console.warn('restore client state failed', e) }
}

// Next free stable slot for a NEW cross-module function (call when creating one).
export function nextCmfSlot(list) { let n = 0; for (const f of (list ?? [])) if (f && typeof f.slot === 'number') n = Math.max(n, f.slot + 1); return n }
// A function's stable slot (falls back to array index for any un-migrated entry).
export const cmfSlotOf = (f, i) => (f && typeof f.slot === 'number' ? f.slot : i)

// Reserved CAN-ID block for cross-module signals (2 per slot: trigger + clock). Keyed by the
// function's STABLE slot, not its array position, so deleting one never relocates another's IDs.
const CMF_ID_BASE = 0x520
export const cmfTrigId = (slot) => CMF_ID_BASE + slot * 2
export const cmfClkId = (slot) => CMF_ID_BASE + slot * 2 + 1

// A function deploys as Lua only when written in Lua, OR when it needs a backup clock
// master (native CAN can't arbitrate two masters — failover requires Lua). Everything else
// compiles to native CAN-input/flasher/output wiring.
export const cmfIsLua = (f) => f?.mode === 'lua' || !!f?.clockBackup

// Which devices have an embedded Lua engine. Only the PDMs (dingoPDM / PDM-MAX) do — the
// CANBoard firmware is built HAS_LUA=FALSE (no room on its STM32F303K8: 62 KB flash / 16 KB RAM
// vs the PDM's 384 KB / 128 KB + 48 KB Lua heap). Keypads/DBC devices aren't programmable either.
// Used to hide Lua UI and to refuse pushing Lua to a non-Lua module.
export const deviceHasLua = (type) => !/keypad|dbc|canboard|can.?board/i.test(type || '')

// Compile all cross-module functions into per-module Lua + output bindings.
// Returns { [guid]: { lua, bindings: [{ output, input }] } } for every module with a role.
export function compileCrossModule() {
  const fns = get(crossFns)
  const mods = {} // guid -> accumulators
  const M = (g) => (mods[g] ??= { rx: new Set(), decl: [], rxCases: [], tick: [], bindings: [] })

  fns.forEach((f, i) => {
    if (!f || f.disabled || !cmfIsLua(f)) return   // native rules don't generate Lua
    const slot = cmfSlotOf(f, i)
    const trig = cmfTrigId(slot), clk = cmfClkId(slot)
    const half = ((f.blinkRateMs || 350) / 1000).toFixed(3)
    const P = `_cmf${slot}`
    const blink = !!f.blink
    const ownerG = f.trigger?.guid
    const masterG = blink ? f.clockMaster : null
    const backupG = blink ? f.clockBackup : null

    // --- trigger owner: read the switch locally and publish it on the bus ---
    if (ownerG != null && f.trigger?.varIndex != null) {
      const m = M(ownerG)
      m.tick.push(`  ${P}trig = readVar(${f.trigger.varIndex}) ~= 0 and 1 or 0`)
      m.tick.push(`  txCan(1, ${trig}, false, { ${P}trig })`)
      m.decl.push(`local ${P}trig = 0`)
    }
    // helper: ensure a module tracks the trigger (locally if owner, else via CAN)
    const needTrig = (g) => {
      const m = M(g)
      if (g === ownerG) return // already set+declared above
      if (!m._trigDecl?.has(slot)) { (m._trigDecl ??= new Set()).add(slot); m.decl.push(`local ${P}trig = 0`); m.rx.add(trig); m.rxCases.push(`  if id == ${trig} then ${P}trig = data[1] end`) }
    }
    // helper: ensure a module tracks the clock value (via CAN), unless it generates it
    const needClkRx = (g) => {
      const m = M(g)
      if (!m._clkDecl?.has(slot)) { (m._clkDecl ??= new Set()).add(slot); m.decl.push(`local ${P}clk = 0`); m.rx.add(clk); m.rxCases.push(`  if id == ${clk} then ${P}clk = data[1] end`) }
    }

    // --- primary clock master: generate the blink clock, publish at priority 0 ---
    if (masterG != null) {
      const m = M(masterG)
      needTrig(masterG)
      m.decl.push(`local ${P}clk = 0`, `local ${P}ct = Timer.new()`)
      m._clkGen = (m._clkGen ??= new Set()).add(i)
      m.tick.push(
        `  if ${P}trig == 1 then\n` +
        `    if ${P}ct:getElapsedSeconds() >= ${half} then ${P}ct:reset(); ${P}clk = 1 - ${P}clk end\n` +
        `  else ${P}clk = 0; ${P}ct:reset() end\n` +
        `  txCan(1, ${clk}, false, { ${P}clk, 0 })`)
    }
    // --- backup clock master: take over if the primary's clock disappears ---
    if (backupG != null && backupG !== masterG) {
      const m = M(backupG)
      needTrig(backupG)
      m.decl.push(`local ${P}clk = 0`, `local ${P}ct = Timer.new()`, `local ${P}seen = Timer.new()`)
      m.rx.add(clk)
      m.rxCases.push(`  if id == ${clk} and data[2] == 0 then ${P}seen:reset() end`)
      m.tick.push(
        `  if ${P}seen:getElapsedSeconds() > 0.3 and ${P}trig == 1 then\n` +    // primary gone, function active
        `    if ${P}ct:getElapsedSeconds() >= ${half} then ${P}ct:reset(); ${P}clk = 1 - ${P}clk end\n` +
        `    txCan(1, ${clk}, false, { ${P}clk, 1 })\n` +
        `  end`)
    }
    // --- targets: drive each output = trigger (AND clock, if blinking) ---
    for (const t of f.targets ?? []) {
      if (t.guid == null || t.output == null) continue
      const m = M(t.guid)
      needTrig(t.guid)
      const slot = t.output - 1
      let drive
      if (blink) {
        if (!(m._clkGen?.has(i))) needClkRx(t.guid)   // follow the clock unless this module generates it
        drive = `(${P}trig ~= 0 and ${P}clk ~= 0) and 1 or 0`
      } else {
        drive = `(${P}trig ~= 0) and 1 or 0`
      }
      m.tick.push(`  setLuaOut(${slot}, ${drive})`)
      m.bindings.push({ output: t.output })
    }
  })

  // assemble each module's Lua program
  const out = {}
  for (const [g, m] of Object.entries(mods)) {
    if (!m.tick.length) continue
    let s = '-- Cross-module functions — generated by dingoConfig. Edit in System view.\n'
    s += [...new Set(m.decl)].join('\n') + '\n'
    for (const id of m.rx) s += `canRxAdd(${id})\n`
    if (m.rxCases.length) s += 'function onCanRx(bus, id, dlc, data)\n' + [...new Set(m.rxCases)].join('\n') + '\nend\n'
    s += 'function onTick()\n' + m.tick.join('\n') + '\nend\nsetTickRate(50)\n'
    out[g] = { lua: s, bindings: m.bindings }
  }
  return out
}

// ---- native-rule helpers (compile a rule to CAN-in/flasher/CAN-out + output binding) ----
// Build an outputconfig body that binds `input` but PRESERVES every other field from the
// live output object. The backend overwrites the whole output, so any field we don't carry
// through here is silently reset — that previously wiped reset/retry, PWM and soft-start.
// CurrentLimit is the hardware over-current trip: we refuse to invent it. If the source output
// was never read/configured (no currentLimit), writing a guessed value could under- or
// over-protect the circuit, so we throw and make the caller Read the module first.
const _binBody = (o, input) => {
  if (o == null || o.currentLimit == null)
    throw new Error(`Output ${o?.number ?? '?'} has no current limit yet — Read the module before writing/deploying so its trip point isn't guessed.`)
  return {
    Number: o.number, Enabled: true, Input: input,
    CurrentLimit: o.currentLimit, InrushLimit: o.inrushLimit ?? 50, InrushTime: o.inrushTime ?? 1000,
    ResetMode: o.resetMode ?? 0, ResetTime: o.resetTime ?? 1000, ResetCountLimit: o.resetCountLimit ?? 3,
    PwmEnabled: o.pwmEnabled ?? false, Freq: o.freq ?? 100, FixedDuty: o.fixedDuty ?? 100, MinDuty: o.minDuty ?? 0,
    SoftStart: o.softStart ?? false, SoftStartRamp: o.softStartRamp ?? 0,
    WarnLimit: o.warnLimit ?? 0, OpenLoadLimit: o.openLoadLimit ?? 0, OpenLoadTime: o.openLoadTime ?? 1000,
  }
}

// Disable every cross-module-owned native function (name starts "cmf") on a module, so each
// deploy is a clean rebuild — handles edits/deletes without leaking slots (auto-pick scheme).
async function cmfNativeCleanup(guid) {
  const f = await api.functions(guid)
  for (const [kind, key] of [['caninput', 'canInputs'], ['canoutput', 'canOutputs'], ['flasher', 'flashers']])
    for (const x of (f?.[key] ?? []))
      if (x.enabled && /^cmf\d/i.test(x.name ?? '')) await api.setFunction(guid, kind, x.number, { ...x, enabled: false })
}

// Deploy one native (rule) function. `i` is the function's STABLE slot (CAN IDs + cmf-names
// derive from it). `used` tracks device function-slots claimed across functions this run.
async function deployNativeRule(f, i, devices, used) {
  const TRIG = cmfTrigId(i), CLK = cmfClkId(i), rate = f.blinkRateMs || 350
  const blink = !!f.blink
  const ownerG = f.trigger?.guid
  if (ownerG == null || f.trigger?.varIndex == null || !(f.targets || []).length) return
  const U = (g) => (used[g] ??= new Set())
  const free = async (g, key) => { const fs = await api.functions(g); for (const x of (fs?.[key] ?? [])) if (!x.enabled && !U(g).has(key + x.number)) { U(g).add(key + x.number); return x.number } return null }
  const varByName = async (g, name) => (await api.inputs(g)).find((x) => x.name === name)?.index
  const canIn = (id, name) => ({ name, enabled: true, ide: false, id, startBit: 0, bitLength: 1, mode: 0, byteOrder: 0 })
  const canOut = (id, name, input, interval) => ({ name, enabled: true, input, ide: false, id, startBit: 0, bitLength: 1, interval, byteOrder: 0 })

  if (!blink) {
    // owner broadcasts the trigger; each target receives it → drives the output
    await api.setFunction(ownerG, 'canoutput', await free(ownerG, 'canOutputs'), canOut(TRIG, `cmf${i}trg`, f.trigger.varIndex, 100))
    for (const t of f.targets) {
      await api.setFunction(t.guid, 'caninput', await free(t.guid, 'canInputs'), canIn(TRIG, `cmf${i}trg`))
      const v = await varByName(t.guid, `cmf${i}trg`)
      const o = (devices.find((d) => d.guid === t.guid)?.outputs ?? []).find((x) => x.number === t.output)
      if (o && v != null) await api.outputConfig(t.guid, _binBody(o, v))
    }
    return
  }
  // blink: the master runs a trigger-gated flasher and broadcasts the FINAL lamp state on CLK
  const masterG = f.clockMaster || ownerG
  let trigVar
  if (masterG === ownerG) trigVar = f.trigger.varIndex
  else {
    await api.setFunction(ownerG, 'canoutput', await free(ownerG, 'canOutputs'), canOut(TRIG, `cmf${i}trg`, f.trigger.varIndex, 100))
    await api.setFunction(masterG, 'caninput', await free(masterG, 'canInputs'), canIn(TRIG, `cmf${i}trg`))
    trigVar = await varByName(masterG, `cmf${i}trg`)
  }
  await api.setFunction(masterG, 'flasher', await free(masterG, 'flashers'), { name: `cmf${i}blk`, enabled: true, single: false, input: trigVar, onTime: rate, offTime: rate })
  const flVar = await varByName(masterG, `cmf${i}blk`)
  await api.setFunction(masterG, 'canoutput', await free(masterG, 'canOutputs'), canOut(CLK, `cmf${i}clk`, flVar, 50))
  for (const t of f.targets) {
    await api.setFunction(t.guid, 'caninput', await free(t.guid, 'canInputs'), canIn(CLK, `cmf${i}clk`))
    const v = await varByName(t.guid, `cmf${i}clk`)
    const o = (devices.find((d) => d.guid === t.guid)?.outputs ?? []).find((x) => x.number === t.output)
    if (o && v != null) await api.outputConfig(t.guid, _binBody(o, v))
  }
}

// Deploy all cross-module functions. Native rules → CAN-in/flasher/output wiring (no Lua);
// Lua/failover functions → per-module Lua. Cleans previously-deployed native slots first.
export async function deployCrossModule(devices) {
  const fns = get(crossFns)
  const results = []
  const involved = new Set()
  fns.forEach((f) => { if (f?.trigger?.guid) involved.add(f.trigger.guid); if (f?.clockMaster) involved.add(f.clockMaster); (f?.targets ?? []).forEach((t) => involved.add(t.guid)) })

  // 1. Clean slate for native slots so re-deploys/deletes don't leak. If cleanup fails the old
  // enabled slots are still live — building fresh rules on top would leak slots / duplicate CAN
  // IDs on the bus, so record the failure and skip that module instead of silently corrupting it.
  const cleanupFailed = new Set()
  for (const g of involved) {
    try { await cmfNativeCleanup(g) }
    catch (e) {
      cleanupFailed.add(g)
      const nm = (devices ?? []).find((d) => d.guid === g)?.name ?? (g ?? '').slice(0, 6)
      results.push({ name: nm, ok: false, error: 'slot cleanup failed — skipped to avoid duplicate CAN IDs: ' + e.message })
    }
  }

  // 2. Native rules.
  const used = {}
  for (let i = 0; i < fns.length; i++) {
    const f = fns[i]
    if (!f || f.disabled || cmfIsLua(f)) continue
    const inv = [f.trigger?.guid, f.clockMaster, ...(f.targets ?? []).map((t) => t.guid)].filter(Boolean)
    if (inv.some((g) => cleanupFailed.has(g))) { results.push({ name: f.name, ok: false, error: 'skipped — a target module’s slot cleanup failed' }); continue }
    // A native rule writes CAN params to its owner/master/targets. If any involved module isn't
    // live, those writes persist to the project record but never reach hardware — report that as
    // "saved to project", not "deployed", so the summary can't claim a write that didn't land.
    const offline = [...new Set(inv.filter((g) => !(devices ?? []).find((d) => d.guid === g)?.connected)
      .map((g) => (devices ?? []).find((d) => d.guid === g)?.name ?? 'a module'))]
    try {
      await deployNativeRule(f, cmfSlotOf(f, i), devices, used)
      results.push(offline.length
        ? { name: f.name, ok: true, written: false, kind: 'native', note: `${offline.join(', ')} offline` }
        : { name: f.name, ok: true, written: true, kind: 'native' })
    }
    catch (e) { results.push({ name: f.name, ok: false, error: e.message }) }
  }

  // 3. Lua/failover functions → per-module Lua. Concatenate EVERY Lua function's hand-written
  // override for this module (previously only the first was kept, silently dropping the rest).
  const compiled = compileCrossModule()
  for (const d of devices ?? []) {
    if (cleanupFailed.has(d.guid)) continue   // already reported; don't deploy onto an unclean slate
    const c = compiled[d.guid]
    const overrides = fns.filter((f) => cmfIsLua(f)).map((f) => f.luaByModule?.[d.guid]).filter((s) => s && s.trim())
    const userLua = overrides.length ? overrides.join('\n\n') : undefined
    const lua = userLua ?? c?.lua ?? ''
    // A CANBoard (or any non-PDM) has no Lua engine — never push Lua to it. If a Lua-mode
    // cross-module function landed on one, report it instead of silently uploading dead code.
    if ((lua || c) && !deviceHasLua(d.type)) {
      results.push({ name: d.name, ok: false, error: `${d.name} has no Lua engine (a CANBoard doesn't run Lua) — switch this function to a native rule, or run the Lua on a PDM and bridge the signal over CAN.` })
      continue
    }
    luaSnippets.update((v) => { v[d.guid] = { ...(v[d.guid] || {}) }; v[d.guid].cmf = lua; return { ...v } })
    if (!lua && !c) continue
    try {
      const ins = await api.inputs(d.guid)
      const base = ins.find((x) => x.name === 'Lua Out 1')?.index
      await api.luaUpload(d.guid, luaAssemble(d.guid))
      for (const b of (c?.bindings ?? [])) {
        const o = (d.outputs ?? []).find((x) => x.number === b.output)
        if (!o) continue
        // Resolve the real "Lua Out N" varmap index off the device. If it can't be found
        // (renamed firmware / failed read), DON'T guess with a hardcoded base — a wrong
        // index would drive the wrong circuit. Skip the binding and report it instead.
        if (base == null) { results.push({ name: d.name, ok: false, error: `couldn't resolve "Lua Out 1" varmap index — output O${b.output} not bound` }); continue }
        await api.outputConfig(d.guid, _binBody(o, base + (b.output - 1)))
      }
      results.push({ name: d.name, ok: true, kind: 'lua' })
    } catch (e) { results.push({ name: d.name, ok: false, error: e.message }) }
  }
  return results
}

