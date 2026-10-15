// Endpoints the shared `api` wrapper (src/lib/store.js) has no method for yet. Same JSON rules as store.js.
export async function postJson(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const t = await r.text()
  let d
  try { d = JSON.parse(t) } catch { d = t }
  if (!r.ok) throw new Error((d && (d.error || d.title)) || (typeof d === 'string' && d) || `HTTP ${r.status}`)
  return d
}
/** POST /devices/{id}/link-remote — fill CAN input `canInput` to decode `signal` broadcast by `sourceGuid`. */
export const linkRemote = (guid, canInput, sourceGuid, signal) => postJson(`/api/devices/${guid}/link-remote`, { CanInput: canInput, SourceGuid: sourceGuid, Signal: signal })
