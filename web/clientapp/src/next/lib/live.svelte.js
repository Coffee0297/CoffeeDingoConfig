// Reactive data layer for the redesigned UI. Wraps the existing store.js (SignalR telemetry +
// REST `api`) so every screen reads the same live state and calls the same endpoints.
import { telemetry, hubState, api, deviceDefs } from '../../lib/store.js'
import { toast } from '../../lib/toast.js'

export { api, toast }

/** Live telemetry, ~10 Hz: { connected, adapter, canTotal, canRate, ids, devices[] } */
export const live = $state({ connected: false, adapter: null, canTotal: 0, canRate: 0, ids: [], devices: [], stale: false })
/** SignalR feed state: 'live' | 'reconnecting' | 'down' */
export const hub = $state({ state: 'live' })

telemetry.subscribe((t) => {
  live.connected = !!t.connected
  live.adapter = t.adapter ?? null
  live.canTotal = t.canTotal ?? 0
  live.canRate = t.canRate ?? 0
  live.ids = t.ids ?? []
  live.devices = t.devices ?? []
  live.stale = !!t.stale
})
hubState.subscribe((s) => (hub.state = s))

/** Project file state. `dirty` comes from the backend; edits also set it at once so the chip does not wait for the poll. */
export const project = $state({ current: null, dir: '', files: [], dirty: false, loaded: false })

export async function refreshProject() {
  try {
    const was = project.dirty
    const p = await api.project()
    project.current = p?.current ?? null
    project.dir = p?.dir ?? ''
    project.files = p?.files ?? []
    // an edit that landed while this request was out is newer than the answer
    if (typeof p?.dirty === 'boolean' && !(p.dirty === false && !was && project.dirty)) project.dirty = p.dirty
    project.loaded = true
  } catch { /* backend down: keep last */ }
}
refreshProject()
setInterval(refreshProject, 5000)

/** Board definitions (block limits, output ratings) from /api/definitions, loaded once. */
export const defs = $state({ pdms: [], canboards: [], loaded: false })
api.definitions().then((d) => { defs.pdms = d?.pdms ?? []; defs.canboards = d?.canboards ?? []; defs.loaded = true }).catch(() => {})
export { deviceDefs }

export const isPdm = (d) => /pdm/i.test(d?.type ?? '')
export const isCanboard = (d) => /canboard/i.test(d?.type ?? '')
export const hex = (n) => '0x' + Number(n ?? 0).toString(16).toUpperCase().padStart(3, '0')

/** Find a device by guid or by name. */
export function device(key) {
  return live.devices.find((d) => d.guid === key || d.name === key) ?? null
}

/** Module live state for display: { key, word, shape } — never colour alone. */
export function moduleState(d) {
  if (!live.connected) return { key: 'stale', word: 'No connection', shape: 'ring' }
  if (!d?.connected) return { key: 'fault', word: 'Not found', shape: 'square' }
  if (/sleep/i.test(d.state ?? '')) return { key: 'off', word: 'Asleep', shape: 'ring' }
  if (/error|overtemp/i.test(d.state ?? '')) return { key: 'fault', word: d.state, shape: 'square' }
  return { key: 'on', word: 'Connected', shape: 'dot' }
}

/** Changes not sent to the car = modules whose config differs from the project (configMismatch). */
export function pendingModules() {
  return live.devices.filter((d) => d.configMismatch && d.connected)
}

/**
 * Run a mutating API call: marks the project unsaved, shows a toast on error (and on success when
 * `ok` is given). Returns the result, or undefined on failure.
 */
export async function mutate(fn, ok) {
  try {
    const r = await fn()
    project.dirty = true
    if (ok) toast(ok, 'info', 2500)
    return r
  } catch (e) {
    toast(e?.message ?? String(e), 'error', 8000)
    return undefined
  }
}

/** Run a read-only API call with an error toast. */
export async function read(fn) {
  try { return await fn() } catch (e) { toast(e?.message ?? String(e), 'error', 6000); return undefined }
}
