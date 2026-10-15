// POST /api/devices/{guid}/{write|writeall|burn|read|sleep|wakeup|version|bootloader} and keep the whole
// answer, including the module's refusals ({ rejected:[{param, reason, kept}], noReply:[], error }).
// api.action only keeps the error text, which loses which value the module refused and what it kept.
export async function postAction(guid, act, timeoutMs = 45_000) {
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`/api/devices/${guid}/${act}`, { method: 'POST', signal: ac.signal })
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { /* plain text */ }
    const error = r.ok ? '' : (body?.error ?? (text || `HTTP ${r.status}`))
    return { ok: r.ok && body?.ok !== false, status: r.status, body, error, rejected: body?.rejected ?? [], noReply: body?.noReply ?? [] }
  } catch (e) {
    return { ok: false, status: 0, body: null, error: e.name === 'AbortError' ? `No answer after ${timeoutMs / 1000} s. Is the module responding?` : `Network error: ${e.message}`, rejected: [], noReply: [] }
  } finally { clearTimeout(to) }
}

/** Wait until a module's read finishes (telemetry `reading` goes false), up to `ms`. */
export async function waitRead(getDevice, ms = 20_000) {
  const sleep = (t) => new Promise((r) => setTimeout(r, t))
  const t0 = Date.now()
  await sleep(400)
  while (Date.now() - t0 < ms && getDevice()?.reading) await sleep(250)
  await sleep(300)
}
