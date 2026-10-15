// Direct backend access for tests: arrange state and assert that a click really reached the module.
export const API = process.env.E2E_API ?? 'http://127.0.0.1:5000'

export async function apiJson(method, path, body, timeoutMs = 30_000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(API + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: ac.signal })
    const text = await r.text()
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`)
    try { return JSON.parse(text) } catch { return text }
  } finally { clearTimeout(t) }
}

export async function waitFor(fn, timeoutMs = 15_000, what = 'condition') {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try { if ((last = await fn())) return last } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}` + (last instanceof Error ? `: ${last.message}` : ''))
}

/** All project devices (config + live). */
export const devices = () => apiJson('GET', '/api/devices')
/** One device by name, e.g. 'PDM-01'. */
export async function deviceByName(name) {
  const d = (await devices()).find((x) => x.name === name)
  if (!d) throw new Error(`No module named ${name} in the project`)
  return d
}

/** Values the module stores as 32-bit floats read back as e.g. 0.30000001 — compare with a tolerance. */
export const near = (a, b, eps = 1e-4) => Math.abs(Number(a) - Number(b)) <= eps * Math.max(1, Math.abs(Number(b)))
