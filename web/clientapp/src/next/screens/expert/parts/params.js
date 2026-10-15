// Raw parameter access for Expert > CAN & parameters: schema, snapshot, read, confirmed write.
import { api } from '../../../lib/live.svelte.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function getSchema() {
  const r = await fetch('/api/config/schema')
  if (!r.ok) throw new Error('Could not load the parameter list (HTTP ' + r.status + ')')
  return r.json()
}
export async function getSnapshot() {
  const r = await fetch('/api/config')
  if (!r.ok) throw new Error('Could not read the parameter values (HTTP ' + r.status + ')')
  return r.json()
}
export const hexIdx = (i, s) => '0x' + Number(i).toString(16).toUpperCase().padStart(4, '0') + ':' + String(s).padStart(2, '0')
export const showVal = (v) => (v === null || v === undefined ? '—' : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v))

const f32 = (v) => Math.fround(v)
/** The 32-bit unsigned number the wire carries for `input`, plus the value in snapshot form. Throws a plain message. */
export function encode(p, input) {
  const s = String(input ?? '').trim()
  switch (p.type) {
    case 'bool': {
      if (/^(1|true|on|yes)$/i.test(s)) return { raw: 1, want: true }
      if (/^(0|false|off|no)$/i.test(s)) return { raw: 0, want: false }
      throw new Error('Choose on or off.')
    }
    case 'enum': {
      const i = (p.options ?? []).indexOf(s)
      if (i < 0) throw new Error('Choose one of: ' + (p.options ?? []).join(', ') + '.')
      return { raw: i, want: s }
    }
    case 'float': {
      const v = Number(s)
      if (s === '' || !Number.isFinite(v)) throw new Error('Enter a number.')
      const buf = new DataView(new ArrayBuffer(4)); buf.setFloat32(0, v, true)
      return { raw: buf.getUint32(0, true), want: f32(v) }
    }
    case 'int': {
      const v = Number(s)
      if (s === '' || !Number.isInteger(v)) throw new Error('Enter a whole number.')
      if (v < -2147483648 || v > 4294967295) throw new Error('That number does not fit in 32 bits.')
      return { raw: v >>> 0, want: v }
    }
    default: throw new Error('This setting is a label. It is stored in the project only and is not sent to the module.')
  }
}
export function same(p, got, want) {
  if (p.type === 'float') return typeof got === 'number' && Math.abs(f32(got) - want) <= 1e-6 * Math.max(1, Math.abs(want))
  return got === want
}
export const writable = (p) => p.type !== 'string'

/** Ask the module for one parameter; the reply updates the project's copy, so read it back from the snapshot. */
export async function readParam(guid, p) {
  const r = await fetch(`/api/devices/${guid}/readparam`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Index: p.index, Sub: p.sub }) })
  if (!r.ok) {
    const t = await r.text()
    let m = t; try { m = JSON.parse(t).error ?? t } catch { /* plain text */ }
    throw new Error(m || 'HTTP ' + r.status)
  }
  await sleep(500)
  const snap = await getSnapshot()
  return snap.devices.find((d) => d.guid === guid)?.params?.[p.name]
}

/**
 * Write one parameter, then read back what the module holds.
 * Returns { state: 'ok' | 'clamped' | 'noreply' | 'refused', want, got, text }.
 * noreply = the module did not answer in time (the value may or may not have arrived); refused = it answered that the value is out of range.
 */
export async function writeConfirmed(guid, p, input) {
  const { raw, want } = encode(p, input)
  let refusal = null
  try { await api.writeParam(guid, p.index, p.sub, raw) } catch (e) { refusal = String(e?.message ?? e) }
  await sleep(200)
  const snap = await getSnapshot()
  const got = snap.devices.find((d) => d.guid === guid)?.params?.[p.name]
  if (refusal && /no reply/i.test(refusal)) return { state: 'noreply', want, got, text: `The module did not confirm in time. It holds ${showVal(got)}. Write again to retry.` }
  if (refusal) return { state: 'refused', want, got, text: `Refused by the module: ${refusal}. It holds ${showVal(got)}.` }
  if (same(p, got, want)) return { state: 'ok', want, got, text: `Wrote ${showVal(want)}. Read back ${showVal(got)}.` }
  return { state: 'clamped', want, got, text: `Module kept ${showVal(got)}. You asked for ${showVal(want)}.` }
}
