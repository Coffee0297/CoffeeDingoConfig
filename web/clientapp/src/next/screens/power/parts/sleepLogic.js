// Sleep & wake: helpers shared by Power home, Sleep & wake and Output roles.
// Per-module sleep fields come from telemetry (live.devices[]); writes go through the same params the
// old Settings drawer used (device param index 0, sub-index below). Nothing here burns: a change is live
// on the module at once and is stored with Apply to car.
import { api, project, toast, defs, isPdm } from '../../../lib/live.svelte.js'

export const SUB = { enabled: 2, timeout: 5, ignoreAlwaysOn: 9, forceSleep: 10, muteTx: 11, wakeMask: 12, wakeCan: 13 }
export const TIMEOUT_MIN_S = 1
export const TIMEOUT_MAX_S = 60

/** True when the module's firmware can sleep (false on a CANBoard built without CAN_SLEEP). */
export const canSleep = (d) => d?.canSleep !== false

/** Digital inputs a module has (wake matrix columns). */
export function digCount(d) {
  const list = isPdm(d) ? defs.pdms : defs.canboards
  const hit = list.find((x) => (x.typeName || '').toLowerCase() === (d?.type || '').toLowerCase())
  return hit?.numDigitalInputs ?? (isPdm(d) ? 2 : 8)
}

/** Write device params (index 0) one by one. Returns true when the module confirmed every one. */
export async function writeParams(d, writes) {
  if (!d?.connected) {
    toast(`${d?.name ?? 'The module'} is not on the bus. Connect it first, then try again.`, 'error', 7000)
    return false
  }
  try {
    for (const [sub, value] of writes) await api.writeParam(d.guid, 0, sub, value)
    project.dirty = true
    return true
  } catch (e) {
    toast(`${d.name}: ${e?.message ?? e}`, 'error', 9000)
    return false
  }
}

/** True when an error just means the module sent no confirm (the project record holds the value). */
export const isUnconfirmed = (e) => /not confirmed|no reply|didn't confirm/i.test(e?.message ?? String(e))

/** Write the module's own signal inputs (force-sleep / mute-TX). Returns true on success. */
export async function writeDeviceInput(d, body) {
  try {
    const r = await api.deviceInputs(d.guid, body)
    project.dirty = true
    if (r && r.written === false) toast(`${d.name} is offline: saved in the project only.`, 'info', 5000)
    return true
  } catch (e) {
    if (isUnconfirmed(e)) { project.dirty = true; toast(`Saved in the project, but ${d.name} did not confirm it. ${e.message}`, 'error', 9000); return true }
    toast(`${d.name}: ${e?.message ?? e}`, 'error', 9000)
    return false
  }
}

/** Plain-words sleep status of a module for display (never colour alone). */
export function sleepStatus(d, connectedBus) {
  if (!connectedBus) return { key: 'stale', glyph: '◌', word: 'No connection', detail: 'Connect to the car first.' }
  if (d.connected) {
    const outs = (d.outputs ?? []).filter((o) => /^on|overcurrent|warning/i.test(o.state ?? ''))
    const detail = outs.length ? `in use: ${outs.length} output${outs.length === 1 ? '' : 's'} on` : (d.current > 0.05 ? `drawing ${d.current.toFixed(1)} A` : 'nothing in use')
    return { key: 'on', glyph: '●', word: 'Awake', detail }
  }
  if (/sleep/i.test(d.state ?? '')) return { key: 'off', glyph: '○', word: 'Asleep', detail: 'last report before it went quiet' }
  return { key: 'stale', glyph: '◌', word: 'Not seen', detail: 'asleep or unplugged: cannot tell' }
}

/** Which module a CAN id belongs to (base-1 .. base+span), or null. */
export function moduleOfId(id, devices) {
  for (const d of devices) {
    const span = /canboard/i.test(d.type ?? '') ? 13 : 29
    if (id >= d.baseId - 1 && id <= d.baseId + span) return d
  }
  return null
}

/** Seconds as short words: 30 -> "30 s". */
export const secs = (ms) => `${Math.round((ms ?? 0) / 1000)} s`
