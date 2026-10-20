import { writable, get } from 'svelte/store'
import * as signalR from '@microsoft/signalr'
import { toast } from './toast.js'
import { spanAfter, isModule } from './canids.js'
import { outputRatingA, binBody, broadcastFrame, addCanInputFromFrame as addCanInputFromFrameApi, ensureInputEnabled as ensureInputEnabledApi } from './apply.js'

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
  if (msg.trim()) toast(msg, kind, kind === 'error' ? 8000 : 4000, kind === 'error' ? 'notify:' + (e?.source ?? '') : null)
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

// API errors are `{ ok:false, error:"…" }` — surface the message, not the JSON envelope (plain-text bodies pass through).
async function apiError(r) {
  const t = await r.text()
  try { return new Error(JSON.parse(t)?.error ?? t) } catch { return new Error(t) }
}

// G2: the redesigned UI (#/next) holds its edits until "Apply to car"; the backend saves them to the project
// only when a request carries this header. The old UI sends none and keeps writing live.
// Decided per request: the app can switch between the two UIs without a reload.
// A step that promises to write to the car straight away (cross-module "Send to modules") lifts it while it runs.
let unstaged = 0
const stageHdr = () => (!unstaged && typeof location !== 'undefined' && location.hash.startsWith('#/next') ? { 'X-Dingo-Stage': '1' } : {})

async function j(method, url, body, timeoutMs = 15000) {
  // Abort a hung request (wedged CAN adapter / stalled device) so callers' busy flags
  // clear instead of spinning forever. Flash uses its own raw fetch (legitimately long).
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), timeoutMs)
  let r
  try {
    r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json', ...stageHdr() } : stageHdr(),
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `Request timed out after ${timeoutMs / 1000}s — is the device responding?` : `Network error: ${e.message}`)
  } finally { clearTimeout(to) }
  if (!r.ok) throw await apiError(r)
  // An empty / non-JSON 200 body resolves to null (not a synthesized {}), so a caller can never
  // mistake "no body" for a populated, confirmed result. Write endpoints return explicit JSON.
  return r.json().catch(() => null)
}

export const api = {
  version: () => j('GET', '/api/version'),
  adapters: () => j('GET', '/api/adapters'),
  connectionOptions: (o) => j('POST', '/api/connection/options', o),
  usbIdentify: () => j('POST', '/api/usb/identify'),
  connect: (Adapter, Port, Bitrate) => j('POST', '/api/connect', { Adapter, Port, Bitrate }),
  disconnect: () => j('POST', '/api/disconnect'),
  identify: () => j('GET', '/api/identify'),
  addDevice: (Type, Name, BaseId) => j('POST', '/api/devices', { Type, Name, BaseId }),
  addLike: (guid, Name, BaseId) => j('POST', `/api/devices/${guid}/add-like`, { Type: '', Name, BaseId }),
  modify: (guid, Name, BaseId) => j('POST', `/api/devices/${guid}/modify`, { Name, BaseId }),
  rename: (guid, Name) => j('POST', `/api/devices/${guid}/rename`, { Name }),
  remove: (guid) => j('POST', `/api/devices/${guid}/remove`),
  // firmware 5.6: blink the module's status LEDs for `seconds` -> { ok, hasLed } (the CANBoard has none)
  // upstream config lock (0x0200): the project's password / contact (sent by the next write), unlock, factory reset ('WIPE')
  setLock: (guid, body) => j('POST', `/api/devices/${guid}/lock`, body),
  unlock: (guid, Password) => j('POST', `/api/devices/${guid}/unlock`, { Password }),
  factoryReset: (guid) => j('POST', `/api/devices/${guid}/factoryreset`, { Confirm: 'WIPE' }, 10000),
  blink: (guid, seconds = 10) => j('POST', `/api/devices/${guid}/identify?seconds=${seconds}`),
  // upstream feat/reset-cause: { flags, cause, names } why the module last reset (409 when its firmware does not say)
  resetCause: (guid) => j('GET', `/api/devices/${guid}/resetcause`),
  action: (guid, act) => j('POST', `/api/devices/${guid}/${act}`, undefined, 45000),   // write/writeall/burn wait for the module's confirm (server caps 30 s)
  outputConfig: (guid, body) => j('POST', `/api/devices/${guid}/outputconfig`, body),
  // Bench test: { mode: 'on'|'pwm'|'off', duty, freq, hold } — live module only, releases by itself after `hold` s.
  outputTest: (guid, n, body) => j('POST', `/api/devices/${guid}/output/${n}/test`, body),
  // The module's own inputs: { forceSleepInput?, muteTxInput? } (var-map index, 0 = unwired) — record edit offline, param write when live.
  deviceInputs: (guid, body) => j('POST', `/api/devices/${guid}/device-inputs`, body),
  signals: (guid) => j('GET', `/api/devices/${guid}/signals`),
  // inUse=true → only signals whose function is configured (the picker's view); each carries `label` = the user's name.
  broadcastSignals: (guid, inUse = false) => j('GET', `/api/devices/${guid}/broadcast-signals${inUse ? '?inUse=true' : ''}`),
  // Typed lists feed pickers → configured signals only (inUse). The untyped call is the full var map for
  // index resolution and the Wiring canvas. Pass all=true for a typed list of every slot.
  inputs: (guid, type, all = false) => j('GET', `/api/devices/${guid}/inputs${type ? `?type=${type}${all ? '' : '&inUse=true'}` : ''}`),
  // Every data type, configured functions only — for pickers that take any signal (condition input, CAN-output value, wiper speed).
  inputsInUse: (guid) => j('GET', `/api/devices/${guid}/inputs?inUse=true`),
  functions: (guid) => j('GET', `/api/devices/${guid}/functions`),
  luaUpload: (guid, Source) => j('POST', `/api/devices/${guid}/lua`, { Source }, 100000),   // waits for the read-back verify
  luaRead: (guid, stored = false) => j('GET', `/api/devices/${guid}/lua${stored ? '?stored=true' : ''}`),
  luaError: (guid) => j('GET', `/api/devices/${guid}/luaerror`),
  overloads: (guid) => j('GET', `/api/devices/${guid}/overloads`),
  overloadsClear: (guid) => j('POST', `/api/devices/${guid}/overloads/clear`),
  // upstream feat/fault-history: { bootCount, entries: [{ n, output, kind, boot, amps, volts, uptimeMs }] }, newest first
  faultLog: (guid) => j('GET', `/api/devices/${guid}/faultlog`, undefined, 60000),
  faultLogClear: (guid) => j('POST', `/api/devices/${guid}/faultlog/clear`),
  async flash(guid, bytes) {
    const r = await fetch(`/api/devices/${guid}/flash`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })
    if (!r.ok) throw await apiError(r)
    return r.json()
  },
  // Flash a blank / new module already in DFU (BOOT0 + reset) — no bus device needed.
  async flashBlank(bytes) {
    const r = await fetch('/api/flash/blank', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })
    if (!r.ok) throw await apiError(r)
    return r.json()
  },
  flashStatus: () => j('GET', '/api/flash/status'),
  flashScan: () => j('GET', '/api/flash/dfu'),   // list DFU devices dfu-util can see
  // Flash a module's app over CAN via the OpenBLT XCP bootloader (.srec). No USB/DFU.
  async flashCan(guid, bytes) {
    const r = await fetch(`/api/devices/${guid}/flash-can`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })
    if (!r.ok) throw await apiError(r)
    return r.json()
  },
  flashCanStatus: () => j('GET', '/api/flash-can/status'),
  setFunction: (guid, kind, number, body) => j('POST', `/api/devices/${guid}/function/${kind}/${number}`, body),
  writeParam: (guid, Index, Sub, Value) => {
    // The server param Value is unsigned (uint) — reject a negative/non-integer here with a clear
    // message instead of letting it hit the server as a bare 400.
    const v = Number(Value)
    if (!Number.isInteger(v) || v < 0 || v > 0xFFFFFFFF) throw new Error(`writeParam Value must be an unsigned integer 0…4294967295 (got ${Value})`)
    return j('POST', `/api/devices/${guid}/writeparam`, { Index, Sub, Value: v })
  },
  sdoRead: (Node, Index, Sub) => j('POST', '/api/sdo/read', { Node, Index, Sub }),
  sdoWrite: (Node, Index, Sub, Value, Size) => j('POST', '/api/sdo/write', { Node, Index, Sub, Value, Size }),
  sdoStore: (Node) => j('POST', '/api/sdo/store', { Node }),
  configDiff: (guid) => j('GET', `/api/devices/${guid}/config-diff`),
  canIdMap: () => j('GET', '/api/can-id-map'),
  canRecStart: () => j('POST', '/api/canlog/record/start'),
  canRecStop: () => j('POST', '/api/canlog/record/stop'),
  canRecStatus: () => j('GET', '/api/canlog/record/status'),
  simStatus: () => j('GET', '/api/sim/status'),
  simPlay: () => j('POST', '/api/sim/play'),
  simPause: () => j('POST', '/api/sim/pause'),
  simReset: () => j('POST', '/api/sim/reset'),
  simLoop: (on) => j('POST', `/api/sim/loop?on=${on ? 'true' : 'false'}`),
  simRate: (fps) => j('POST', `/api/sim/rate?fps=${fps}`),
  async simLoad(body) {
    // body is a File/Blob — the browser streams it, so even a huge log isn't held as a JS string.
    const r = await fetch('/api/sim/load', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body })
    if (!r.ok) throw await apiError(r)
    return r.json()
  },
  dbcSignals: (guid, limit) => j('GET', `/api/devices/${guid}/dbc/signals${limit ? `?limit=${limit}` : ''}`),
  dbcSearch: (guid, q, limit = 100) => j('GET', `/api/devices/${guid}/dbc/search?q=${encodeURIComponent(q ?? '')}&limit=${limit}`),
  dbcAddSignal: (guid, body) => j('POST', `/api/devices/${guid}/dbc/signal`, body),
  async dbcImport(name, text, base = 0, rebase = false) {
    const r = await fetch(`/api/devices/dbc-import?name=${encodeURIComponent(name)}&base=${base}&rebase=${rebase}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text })
    if (!r.ok) throw await apiError(r)
    return r.json()
  },
  async dbcOpen(guid, text) {
    const r = await fetch(`/api/devices/${guid}/dbc/open`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text })
    if (!r.ok) throw await apiError(r)
    return r.json()
  },
  canlog: () => j('GET', '/api/canlog'),
  // Force a CAN input: the app sends { Id, Ide, Data (hex), PeriodMs, HoldSec } until the hold runs out (max 30 s) or stop.
  canForce: (body) => j('POST', '/api/can/force', body),
  canForceStop: () => j('POST', '/api/can/force/stop'),
  canForceStatus: () => j('GET', '/api/can/force/status'),
  syslog: () => j('GET', '/api/syslog'),
  project: () => j('GET', '/api/project'),
  projSave: (FileName, Client) => j('POST', '/api/project/save', { FileName, Client }),
  projOpen: (FileName) => j('POST', '/api/project/open', { FileName }),
  projNew: () => j('POST', '/api/project/new'),
  projFolder: (Dir) => j('POST', '/api/project/folder', { Dir }),   // the project folder (user preferences)
  migrate57: () => j('POST', '/api/project/migrate57'),   // fork 5.x records -> the firmware 5.7 layout (report on each device)
  projDownload: () => j('GET', '/api/project/download'),
  // function / helper block groups per module (G16): { groups: [...], dismissed: [...] }
  groups: (guid) => j('GET', `/api/groups/${guid}`),
  allGroups: () => j('GET', '/api/groups'),
  putGroups: (guid, rec) => j('PUT', `/api/groups/${guid}`, rec),   // full project JSON for a browser save
  crossModuleGet: () => j('GET', '/api/system/cross-module'),   // cross-module defs deployed via MCP (for the UI to import)
  async projUpload(text) {                                  // load a project file picked on the PC
    const r = await fetch('/api/project/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text })
    if (!r.ok) throw await apiError(r)
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

// Wire gauge and voltage drop live in wire.js (pure, so node tests can import them).
export { awgFor, WIRE_GAUGES, awgForMm2, vDrop } from './wire.js'

// Device hardware specs (per-model counts + per-output current ratings, icons, min firmware, …)
// are NOT hardcoded here — they come from the backend, whose single source of truth is
// pdm-definitions.json. Fetched once at startup into this store.
export const deviceDefs = writable({ pdms: [], canboards: [] })
api.definitions().then((d) => { if (d) deviceDefs.set(d) }).catch((e) => console.warn('definitions load failed', e))

// Rated channel current (A) for an output, looked up from the loaded definitions by the device's
// type name and output NUMBER (OUT1 = index 0). null when unknown (the UI then shows no rating).
// Setting a trip above the rating is allowed — advisory only; callers just flag it.
export { outputRatingA }


// ===========================================================================
// Node-graph wiring — every function's input is a varmap index pointing at another
// function's output. Indices are always resolved by name against the device's REAL VarMap
// (api.inputs) — never from a hardcoded layout — so they can't drift from the firmware.
// ===========================================================================

// Which input fields each function node exposes (target handles). JSON field names.
export const NODE_INPUTS = {
  output: ['input', 'dutyCycleInput', 'freqInput'], virtualinput: ['var0', 'var1', 'var2'], condition: ['input'],
  flasher: ['input'], counter: ['incInput', 'decInput', 'resetInput'], timer: ['input'], table: ['xInput', 'yInput'], canoutput: ['input'],
  sys: ['forceSleepInput', 'muteTxInput', 'retryAllInput', 'shedInput'],   // the module block itself: force-sleep / mute-TX signals (device params)
}

// Apply a graph edge: write the target function's input field = the source's varmap index.
// For a PDM smart output `field` may also be dutyCycleInput / freqInput (variable PWM sources).
export async function applyGraphConnection(guid, targetId, field, varIndex, devices) {
  if (targetId === 'sys') { await api.deviceInputs(guid, { [field]: varIndex }); return }   // the module's own inputs
  const ci = targetId.indexOf(':')
  const kind = targetId.slice(0, ci), num = parseInt(targetId.slice(ci + 1), 10)
  if (kind === 'output') {
    const d = (devices ?? []).find((x) => x.guid === guid)
    const o = (d?.outputs ?? []).find((x) => x.number === num) ?? { number: num }
    // Preserve EVERY protection field from the live output — the backend replaces the whole
    // output config, so anything not echoed back here is wiped. Only the wired field changes.
    const body = _binBody(o, field === 'input' ? varIndex : (o.inputVal ?? 0))
    // Wiring a duty/freq source turns that variable-PWM mode (and PWM) on; unwiring turns the mode
    // off and drops PWM too unless the other variable mode is still wired — so an output that only
    // became PWM by being wired returns to plain on/off. (The caller confirms the switch-on.)
    const otherVar = field === 'dutyCycleInput' ? (o.variableFreq && o.freqInput > 0) : (o.variableDutyCycle && o.dutyCycleInput > 0)
    if (field === 'dutyCycleInput') Object.assign(body, { DutyCycleInput: varIndex, VariableDutyCycle: varIndex > 0, PwmEnabled: varIndex > 0 || otherVar })
    if (field === 'freqInput') Object.assign(body, { FreqInput: varIndex, VariableFreq: varIndex > 0, PwmEnabled: varIndex > 0 || otherVar })
    await api.outputConfig(guid, body)
  } else {
    await api.setFunction(guid, kind, num, { enabled: true, [field]: varIndex })
  }
}

// Function-array key for each creatable node kind.
const KIND_ARR = { caninput: 'canInputs', virtualinput: 'virtualInputs', condition: 'conditions', counter: 'counters', flasher: 'flashers', timer: 'timers', table: 'tables', canoutput: 'canOutputs' }

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
// 0x101–0x13F: above the default PDM span (0x0DE–0x0FB) and outside every CANopen node range (EMCY 0x081+, PDO 0x180+,
// SDO 0x580/0x600+, heartbeat 0x700+). The old 0x580–0x5FF window WAS the SDO-response range the keypads reply on.
const GFX_ID_BASE = 0x101
const GFX_ID_MAX = 0x13F   // bounded reserved window for auto-assigned bridge IDs
function loadBridges() { try { return JSON.parse(localStorage.getItem('dingoGfxBridges') || '{}') } catch { return {} } }
function saveBridges(b) { try { localStorage.setItem('dingoGfxBridges', JSON.stringify(b)) } catch {} }
function bridgeCanId(srcGuid, srcVar, devices = []) {
  const b = loadBridges(); const key = srcGuid + '|' + srcVar
  if (b[key]) return b[key]   // ids handed out earlier (any window) keep working
  // Avoid colliding with another bridge OR an ID already live on the bus (a keypad / CANopen node
  // / another module's frames). Stay inside a bounded window so we never wander into CANopen
  // address space, and fail loudly rather than hand back a colliding ID.
  const used = new Set(Object.values(b))
  let liveIds = new Set(); try { liveIds = new Set(get(telemetry).ids ?? []) } catch {}
  // …and nothing inside a configured module's frame span (base .. base+29 PDM / +13 CANBoard), live or not
  const inSpan = (id) => (devices ?? []).some((d) => isModule(d.type) && id >= (d.baseId ?? 0) - 1 && id <= (d.baseId ?? 0) + spanAfter(d.type, d))
  let id = GFX_ID_BASE
  while ((used.has(id) || liveIds.has(id) || inSpan(id)) && id <= GFX_ID_MAX) id++
  if (id > GFX_ID_MAX) throw new Error('No free bridge CAN ID available in 0x101–0x13F — free one up or wire it manually.')
  b[key] = id; saveBridges(b); return id
}

// Ensure the remote signal (srcVar on srcGuid) is broadcast on CAN and received locally.
// Returns the LOCAL varmap index of the receiving CAN input (to bind a local target to).
export async function bridgeRemoteSignal(localGuid, srcGuid, srcVar, devices) {
  const id = bridgeCanId(srcGuid, srcVar, devices)
  // 1. source device broadcasts srcVar on `id` (reuse an existing matching CAN output, else claim one)
  const sf = await api.functions(srcGuid)
  if (!(sf?.canOutputs ?? []).some((x) => x.enabled && x.id === id)) {
    const free = (sf?.canOutputs ?? []).find((x) => !x.enabled)
    if (!free) throw new Error('source module has no free CAN output')
    await api.setFunction(srcGuid, 'canoutput', free.number, { enabled: true, input: srcVar, ide: false, id, startBit: 0, bitLength: 1, byteOrder: 0, interval: 100, name: 'gfx' + id.toString(16) })
  }
  // 2. local device receives `id` (reuse an existing matching CAN input, else claim one).
  //    State = (bit != 0): a fresh slot defaults to "== 0", which would INVERT the bridged signal.
  let lf = await api.functions(localGuid)
  let ci = (lf?.canInputs ?? []).find((x) => x.enabled && x.id === id)
  if (!ci) {
    const free = (lf?.canInputs ?? []).find((x) => !x.enabled)
    if (!free) throw new Error('this module has no free CAN input')
    await api.setFunction(localGuid, 'caninput', free.number, { enabled: true, ide: false, id, startBit: 0, bitLength: 1, byteOrder: 0, mode: 0, operator: 1, operand: 0, name: 'gfx' + id.toString(16) })
    lf = await api.functions(localGuid)
    ci = (lf?.canInputs ?? []).find((x) => x.id === id && x.enabled)
  }
  // 3. local varmap index of that CAN input's State port — resolved by name off the device's real
  //    VarMap (the State var is labelled by the input's bare name), so it holds on every board type.
  const ins = await api.inputs(localGuid).catch(() => [])
  const idx = ins.find((x) => x.name === ci.name)?.index
  if (idx == null) throw new Error(`couldn't resolve the varmap index of CAN input "${ci.name}"`)
  return idx
}

// ---- Pull a signal off the bus onto a consumer module: claim a free CAN input and fill it so it
// decodes a CAN frame (absolute id + bit layout). The frame is one another device already transmits
// — an ECU/DBC message, or another module's broadcast — so NOTHING is written to the source; we just
// decode it locally. Returns the new caninput number + the varmap indices of its decoded ports:
// valueIndex (analog, float) and stateIndex (the 1-bit boolean). ----
// `frame` = {name, id, ide, startBit, length, byteOrder, factor, offset, isSigned}.
const addCanInputFromFrame = (consumerGuid, frame) => addCanInputFromFrameApi(api, consumerGuid, frame)

// From a /dbc/search or /dbc/signals hit (absolute id): {name,id,ide,startBit,length,byteOrder,isSigned,factor,offset}.
export const addCanInputFromDbc = (consumerGuid, sig) => addCanInputFromFrame(consumerGuid, sig)

// From a /broadcast-signals entry of another module. That DTO is base-ID-relative (offset, valueOffset,
// bitLength), so resolve the absolute id off the source's current base. Native broadcast frames are
// 11-bit standard (ide=false). `source` is the source device record (needs baseId).
export const addCanInputFromBroadcast = (consumerGuid, source, sig) => addCanInputFromFrame(consumerGuid, broadcastFrame(source, sig))

// Turn on a physical input that a pick relies on (an unused pin reads nothing until enabled), naming it
// after what it now does when it still has its default name. phys = {kind: 'input'|'analoginput', number}.
// Returns true when it had to enable it.
export const ensureInputEnabled = (guid, phys, name) => ensureInputEnabledApi(api, guid, phys, name)

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
  if ((get(luaSnippets)[guid]?.[key] ?? '') === (text ?? '')) return   // no-op when unchanged: an editor's effect re-runs often, localStorage shouldn't
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

// Modules whose tabs were filled from a program (device or project record) this session.
const luaLoaded = new Set()
// Fill the tabs from the project's stored program before an edit is assembled and uploaded, so a module whose
// tabs were never loaded (project opened over the API/MCP, page reloaded) keeps its global Lua and other
// functions instead of being replaced by only the edited snippet. Edits already in the tabs win.
// ponytail: a snippet deleted in the tabs but still in the stored program comes back — clear it there too.
export async function luaHydrate(guid) {
  if (luaLoaded.has(guid)) return
  const cur = get(luaSnippets)[guid] || {}
  await luaReadToTabs(guid, true)
  if (Object.keys(cur).length) luaSnippets.update((v) => ({ ...v, [guid]: { ...v[guid], ...cur } }))
}

// Read the program off the device and populate the per-function snippet store.
export async function luaReadToTabs(guid, stored = false) {
  // api.luaRead can return null (j() yields null on an empty 200 body); never destructure it blind.
  const res = await api.luaRead(guid, stored)
  const source = res?.source ?? ''
  const { global, outs } = luaParse(source)
  luaLoaded.add(guid)
  luaSnippets.update((v) => {
    const dev = {}
    if (global) dev.global = global
    for (const k of Object.keys(outs)) dev[k] = outs[k]
    return { ...v, [guid]: dev }
  })
  return source
}

// The Lua to put on a module for `guid` when deploying it: the per-function tabs if the user has any, else the
// program stored on the project record (a project loaded over the API/MCP never filled the tabs). Never the
// bare header luaAssemble() makes from empty tabs — that would wipe the module's Lua.
export async function luaForDeploy(guid) {
  await luaHydrate(guid)
  const v = get(luaSnippets)[guid] || {}
  return Object.values(v).some((x) => typeof x === 'string' && x.trim()) ? luaAssemble(guid) : ''
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

// ===========================================================================
// Remote signal references (feature B). A consumer's CAN input is tagged with the source
// module + the broadcast signal it decodes, base-ID-independent: the wanted CAN id is always
// sourceBaseId + offset, recomputed live. Stored client-side (the device only holds the raw
// CAN-input params); round-trips with the project. NOTHING auto-writes - a link only records
// intent; the user applies it by saving the CAN input (write + burn).
// ===========================================================================
function loadRemoteLinks() { try { return JSON.parse(localStorage.getItem('dingoRemoteLinks') || '[]') } catch { return [] } }
export const remoteLinks = writable(loadRemoteLinks())
remoteLinks.subscribe((v) => { try { localStorage.setItem('dingoRemoteLinks', JSON.stringify(v)) } catch {} })

// info = { sourceGuid, signal, label, offset, startBit, bitLength, factor, valueOffset, byteOrder, signed }
export function setRemoteLink(consumerGuid, canInput, info) {
  remoteLinks.update((list) => [
    ...list.filter((l) => !(l.consumerGuid === consumerGuid && l.canInput === canInput)),
    { consumerGuid, canInput, ...info },
  ])
}
export function clearRemoteLink(consumerGuid, canInput) {
  remoteLinks.update((list) => list.filter((l) => !(l.consumerGuid === consumerGuid && l.canInput === canInput)))
}
export const remoteLinkFor = (consumerGuid, canInput) =>
  get(remoteLinks).find((l) => l.consumerGuid === consumerGuid && l.canInput === canInput) || null
export const linksForSource = (sourceGuid) => get(remoteLinks).filter((l) => l.sourceGuid === sourceGuid)
// The CAN id a link WANTS, given the source's current base (null if the source isn't in the project).
export function wantedId(link, devices) {
  const src = (devices || []).find((d) => d.guid === link.sourceGuid)
  return src ? src.baseId + link.offset : null
}

// Applied templates (Templates tab): what each one was built from and what it created, so it can be edited
// or removed later. [{id, key, name, guid, sel, relays, created: [{kind, number}], wired: [n], prev: {n: input},
// enabled / pins: [{guid, kind, number}], cans: [n], at}]
function loadTemplates() { try { return JSON.parse(localStorage.getItem('dingoTemplates') || '[]') } catch { return [] } }
export const templateInstances = writable(loadTemplates())
// The backend keeps the same list for the MCP template tools (an agent may apply/remove some), so it's mirrored
// there: every change is pushed, and syncTemplates() adopts the server's list (or seeds it from this browser's
// when the server has none yet, i.e. just started). Called at startup and whenever the Templates tab opens.
let tplSynced = false
templateInstances.subscribe((v) => {
  try { localStorage.setItem('dingoTemplates', JSON.stringify(v)) } catch {}
  if (tplSynced) fetch('/api/templates/instances', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) }).catch(() => {})
})
export async function syncTemplates() {
  try {
    const r = await fetch('/api/templates/instances'), srv = r.ok ? await r.json() : null
    tplSynced = true
    if (Array.isArray(srv)) templateInstances.set(srv)
    else templateInstances.set(get(templateInstances))   // server just started (null): seed it with ours
  } catch { tplSynced = true }
}
syncTemplates()

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
      // old UI graph layout and the redesign's flow canvas positions (per module guid); function groups are
      // held by the server (G16, /api/groups) and merged into the file there
      if (k && /^(dingoGraphPos|dingoGraphRemotes|dingoNextFlowPos):/.test(k)) graph[k] = localStorage.getItem(k)
    }
  } catch {}
  return {
    version: 1,
    crossFns: ls('dingoCrossFns', '[]'),
    remoteLinks: ls('dingoRemoteLinks', '[]'),
    templates: ls('dingoTemplates', '[]'),
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
    remoteLinks.set(Array.isArray(c?.remoteLinks) ? c.remoteLinks : [])
    templateInstances.set(Array.isArray(c?.templates) ? c.templates : [])
    luaSnippets.set(c?.lua && typeof c.lua === 'object' ? c.lua : {})
    localStorage.setItem('dingoGfxBridges', JSON.stringify(c?.bridges ?? {}))
    localStorage.setItem('pinpos', JSON.stringify(c?.pinpos ?? {}))
    for (const [k, v] of Object.entries(c?.graph ?? {})) if (typeof v === 'string' && !k.startsWith('dingoNextGroups:')) localStorage.setItem(k, v)
  } catch (e) { console.warn('restore client state failed', e) }
}

// Next free stable slot for a NEW cross-module function (call when creating one).
export function nextCmfSlot(list) { let n = 0; for (const f of (list ?? [])) if (f && typeof f.slot === 'number') n = Math.max(n, f.slot + 1); return n }
// A function's stable slot (falls back to array index for any un-migrated entry).
export const cmfSlotOf = (f, i) => (f && typeof f.slot === 'number' ? f.slot : i)

// Reserved CAN-ID block for cross-module signals (2 per slot: trigger + clock). Keyed by the
// function's STABLE slot, not its array position, so deleting one never relocates another's IDs.
const CMF_ID_BASE = 0x140   // was 0x520 = CANopen RPDO4 for node ≥ 0x20; 0x140–0x17F is clear of node ranges and of the bridge window
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
import { deviceHasLua } from './pinmap.js'
export { deviceHasLua }

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
    const masterG = blink ? (f.clockMaster || f.trigger?.guid) : null   // empty = the trigger module keeps the time
    const backupG = blink ? (f.clockBackup || null) : null

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
export const _binBody = binBody

// Disable every cross-module-owned native function (name starts "cmf") on a module, so each
// deploy is a clean rebuild — handles edits/deletes without leaking slots (auto-pick scheme).
async function cmfNativeCleanup(guid, devices) {
  const f = await api.functions(guid)
  let n = 0
  const gone = []
  for (const [kind, key] of [['caninput', 'canInputs'], ['canoutput', 'canOutputs'], ['flasher', 'flashers'], ['timer', 'timers']])
    for (const x of (f?.[key] ?? []))
      if (x.enabled && /^cmf\d/i.test(x.name ?? '')) { await api.setFunction(guid, kind, x.number, { ...x, enabled: false }); n++; if (kind === 'caninput') gone.push(x.name) }
  // An output that followed a cleared cmf input would drive from a dead slot: switch it off. The rules
  // deployed after this bind the outputs still in use again; a deleted function's outputs stay off.
  if (gone.length) {
    const vars = await api.inputs(guid).catch(() => [])
    const dead = new Set(vars.filter((v) => v.kind === 'caninput' && gone.includes(v.name)).map((v) => v.index))
    for (const o of (devices ?? []).find((d) => d.guid === guid)?.outputs ?? [])
      if (dead.has(o.inputVal)) await api.outputConfig(guid, _binBody(o, 0, false))
    for (const o of f?.digitalOut ?? [])   // a CANBoard's digital outputs
      if (o.enabled && dead.has(o.input)) await api.setFunction(guid, 'digitaloutput', o.number, { enabled: false, input: 0 })
  }
  return n
}

// Drive output `n` of module `guid` from var `v`: a PDM output keeps its protection settings, a CANBoard
// digital output only has an input.
async function bindTarget(devices, guid, n, v) {
  const d = (devices ?? []).find((x) => x.guid === guid)
  if (/canboard/i.test(d?.type ?? '')) return api.setFunction(guid, 'digitaloutput', n, { enabled: true, input: v })
  const o = (d?.outputs ?? []).find((x) => x.number === n)
  if (o) await api.outputConfig(guid, _binBody(o, v))
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
  // operator NotEqual 0 → State follows the bit (a fresh slot defaults to "== 0", i.e. inverted)
  const canIn = (id, name) => ({ name, enabled: true, ide: false, id, startBit: 0, bitLength: 1, mode: 0, byteOrder: 0, operator: 1, operand: 0 })
  const canOut = (id, name, input, interval) => ({ name, enabled: true, input, ide: false, id, startBit: 0, bitLength: 1, interval, byteOrder: 0 })

  if (!blink) {
    // owner broadcasts the trigger; each target receives it → drives the output
    await api.setFunction(ownerG, 'canoutput', await free(ownerG, 'canOutputs'), canOut(TRIG, `cmf${i}trg`, f.trigger.varIndex, 100))
    for (const t of f.targets) {
      await api.setFunction(t.guid, 'caninput', await free(t.guid, 'canInputs'), canIn(TRIG, `cmf${i}trg`))
      const v = await varByName(t.guid, `cmf${i}trg`)
      if (v != null) await bindTarget(devices, t.guid, t.output, v)
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
    if (v != null) await bindTarget(devices, t.guid, t.output, v)
  }
}

// Deploy all cross-module functions. Native rules → CAN-in/flasher/output wiring (no Lua);
// Lua/failover functions → per-module Lua. Cleans previously-deployed native slots first.
// Written to the modules at once (its confirm says so), also from the redesigned UI that stages other edits.
export async function deployCrossModule(devices) {
  unstaged++
  try { return await deployCrossModuleNow(devices) } finally { unstaged-- }
}
async function deployCrossModuleNow(devices) {
  const fns = get(crossFns)
  const results = []
  const involved = new Set()
  fns.forEach((f) => { if (f?.trigger?.guid) involved.add(f.trigger.guid); if (f?.clockMaster) involved.add(f.clockMaster); (f?.targets ?? []).forEach((t) => involved.add(t.guid)) })
  // every module is cleaned, not just the ones in today's list: a deleted function's slots live on modules
  // nothing in the list touches any more
  const inList = new Set(involved)
  for (const d of devices ?? []) if (/pdm|canboard/i.test(d.type ?? '')) involved.add(d.guid)
  const cleared = new Set()

  // 1. Clean slate for native slots so re-deploys/deletes don't leak. If cleanup fails the old
  // enabled slots are still live — building fresh rules on top would leak slots / duplicate CAN
  // IDs on the bus, so record the failure and skip that module instead of silently corrupting it.
  const cleanupFailed = new Set()
  for (const g of involved) {
    try { if (await cmfNativeCleanup(g, devices)) cleared.add(g) }
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
    if ((lua || c) && !deviceHasLua(d)) {
      results.push({ name: d.name, ok: false, error: `${d.name} has no Lua engine (a CANBoard, or upstream firmware without Lua) — switch this function to a native rule, or run the Lua on a PDM and bridge the signal over CAN.` })
      continue
    }
    if (deviceHasLua(d)) await luaHydrate(d.guid)   // keep the module's own Lua around the cmf block
    const had = !!luaGet(d.guid, 'cmf').trim()   // a cmf block sent before: uploading without it stops it
    luaSnippets.update((v) => { v[d.guid] = { ...(v[d.guid] || {}) }; v[d.guid].cmf = lua; return { ...v } })
    if (!lua && !c && !had) continue
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
  // modules no function uses any more, whose earlier cross-module wiring was cleared
  for (const g of cleared) if (!inList.has(g) && !results.some((r) => r.guid === g)) {
    const d = (devices ?? []).find((x) => x.guid === g)
    results.push({ name: d?.name ?? g.slice(0, 6), guid: g, ok: true, written: !!d?.connected, kind: 'cleared' })
  }
  return results
}

