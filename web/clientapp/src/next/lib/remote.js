// Signals that live on another module (or an ECU), offered inside any local source picker. A picked item's
// value is a key ('r:' broadcast, 'b:' not broadcast yet, 'd:' ECU/DBC); resolveRemote() turns it into a
// local var index at save time by claiming a CAN input that reads it (reusing one that already does).
import { api, addCanInputFromDbc, bridgeRemoteSignal } from '../../lib/store.js'
import { live } from './live.svelte.js'
import { broadcastOf } from '../screens/functions/flow/car.js'
import { linkRemote } from '../screens/functions/flow/net.js'

const isMod = (d) => /pdm|canboard/i.test(d?.type ?? '')
const isDbc = (d) => /dbc/i.test(d?.type ?? '')
const dbcSigs = new Map()   // key -> DBC signal record, for resolveRemote
export const isRemoteKey = (v) => /^[rbd]:/.test(String(v ?? ''))

/**
 * Picker items for signals outside `selfGuid`. kind: 'bool' (on/off) or 'num' (a number).
 * Broadcast signals first, then (bool only) other modules' signals that need a bridge frame, then ECU signals.
 */
export async function remoteItems(selfGuid, kind = 'bool') {
  const devs = live.devices.filter((d) => d.guid !== selfGuid)
  const out = []
  for (const d of devs.filter(isMod)) {
    const bc = (await broadcastOf(d.guid)).filter((x) => x.inUse && !x.isFloat && !/^CanInput/.test(x.name) && (kind === 'bool' ? x.kind === 'bool' : x.kind !== 'bool'))
    for (const x of bc) out.push({ value: `r:${d.guid}:${x.name}`, label: `${x.label ?? x.name} · ${d.name} (over CAN)` })
    if (kind === 'bool') {
      const names = new Set(bc.map((x) => x.label ?? x.name))
      const vars = await api.inputs(d.guid, 'bool', true).catch(() => [])
      for (const v of vars) if (v.index > 0 && v.kind !== 'sys' && v.kind !== 'caninput' && !names.has(v.name))
        out.push({ value: `b:${d.guid}:${v.index}`, label: `${v.name} · ${d.name} (over CAN, sent on a new frame)` })
    }
  }
  for (const d of devs.filter(isDbc)) {
    // ponytail: the server caps a search at 500 signals; a bigger DBC needs a server-side search in the picker
    const r = await api.dbcSearch(d.guid, '', 500).catch(() => null)
    for (const s of r?.items ?? []) {
      if (kind === 'bool' && s.length !== 1) continue
      const key = `d:${d.guid}:${s.id}:${s.name}`
      dbcSigs.set(key, s)
      out.push({ value: key, label: `${s.name} · ${d.name} (ECU)` })
    }
  }
  return out
}

/** CAN input `number` on `guid` -> its State (bool) or Value (num) var index. */
async function ciIndex(guid, number, kind) {
  const vars = await api.inputs(guid).catch(() => [])
  return vars.find((v) => v.kind === 'caninput' && v.number === number && v.prop === (kind === 'bool' ? 'State' : 'Value'))?.index ?? 0
}

/** A picker value -> a local var index. Local values pass through; remote keys claim (or reuse) a CAN input. */
export async function resolveRemote(selfGuid, value, kind = 'bool') {
  const v = String(value ?? '')
  if (!isRemoteKey(v)) return Number(v) || 0
  const [t, g, ...rest] = v.split(':')
  if (t === 'b') return bridgeRemoteSignal(selfGuid, g, Number(rest[0]), live.devices)
  if (t === 'd') {
    const sig = dbcSigs.get(v)
    if (!sig) throw new Error('That ECU signal is no longer in the list. Pick it again.')
    const r = await addCanInputFromDbc(selfGuid, sig)
    return kind === 'bool' ? r.stateIndex : r.valueIndex
  }
  // broadcast: reuse an enabled CAN input that already decodes this frame and bits
  const name = rest.join(':')
  const src = live.devices.find((d) => d.guid === g)
  const sig = (await broadcastOf(g)).find((x) => x.name === name)
  if (!src || !sig) throw new Error(`${src?.name ?? 'The source module'} no longer broadcasts ${name}.`)
  const f = await api.functions(selfGuid)
  const id = (src.baseId ?? 0) + sig.offset
  const have = (f?.canInputs ?? []).find((c) => c.enabled && c.id === id && c.startBit === sig.startBit && c.bitLength === sig.bitLength)
  if (have) return ciIndex(selfGuid, have.number, kind)
  const free = (f?.canInputs ?? []).findLast((c) => !c.enabled)
  if (!free) throw new Error(`No free CAN input on ${live.devices.find((d) => d.guid === selfGuid)?.name ?? 'this module'}. Free one in the flow builder.`)
  await linkRemote(selfGuid, free.number, g, name)
  const idx = await ciIndex(selfGuid, free.number, kind)
  if (!idx) throw new Error(`CAN input ${free.number} did not get a signal number.`)
  return idx
}
