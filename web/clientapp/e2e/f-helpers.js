// Helpers shared by the f-*.spec.js tests (Expert screens: Lua, CAN & parameters, AI agent & Sim replay).
import fs from 'node:fs'
import { apiJson, deviceByName } from './api.js'

export const API = process.env.E2E_API ?? 'http://127.0.0.1:5000'

/** The only module these tests may change. */
export const SAFE = 'PDM-05'
export const safeGuid = async () => (await deviceByName(SAFE)).guid

/** Stored (project) Lua program of a module. */
export const storedLua = async (guid) => (await apiJson('GET', `/api/devices/${guid}/lua?stored=true`)).source

/** Value of one parameter in the project copy (= what the module last acknowledged). */
export async function paramValue(guid, name) {
  const snap = await apiJson('GET', '/api/config')
  return snap.devices.find((d) => d.guid === guid)?.params?.[name]
}

/**
 * PDM-05's own script, as it must be at the end. The first run saves it to e2e-results/pdm05-lua-backup.lua and every
 * later run reads that file, so a run that was killed half way (module left with a test script) can never become "the original".
 */
export async function backupLua(guid) {
  const file = 'e2e-results/pdm05-lua-backup.lua'
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
  const src = await storedLua(guid)
  fs.mkdirSync('e2e-results', { recursive: true })
  fs.writeFileSync(file, src)
  return src
}

/** Put a script back through the API (slow for a full script: about 90 s). Retries, and ends by reading the module. */
export async function restoreLua(guid, src) {
  const liveIs = async () => (await apiJson('GET', `/api/devices/${guid}/lua`, undefined, 150_000)).source === src
  // an upload started by a browser that died may still be running on the backend: let it finish first
  await new Promise((r) => setTimeout(r, 5_000))
  if ((await storedLua(guid)) === src && (await liveIs())) return
  let last
  for (let i = 0; i < 4; i++) {
    try {
      await apiJson('POST', `/api/devices/${guid}/lua`, { Source: src }, 180_000)
      if (await liveIs()) return
    } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, 20_000))
  }
  throw new Error('Could not put the original script back on PDM-05: ' + (last?.message ?? 'read-back differs'))
}

/** Freeze the live feed and push a made-up telemetry state (dev build only): e.g. { adapter: 'Sim' } or { connected: false }. */
export async function fakeTelemetry(page, patch) {
  await page.evaluate(async (p) => {
    await window.__conn.stop()
    // like the backend: the Sim adapter turns programming off
    window.__telemetry.update((t) => ({ ...t, ...('adapter' in p ? { programmingAllowed: !/^sim$/i.test(p.adapter ?? '') } : {}), ...p }))
  }, patch)
}

/** Dev server does not forward /mcp, so route it to the backend. */
export async function proxyMcp(page) {
  await page.route(/\/mcp(\/info)?$/, async (route) => {
    const req = route.request()
    const url = API + new URL(req.url()).pathname
    const r = await fetch(url, { method: req.method(), headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: req.method() === 'POST' ? req.postData() : undefined })
    await route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() })
  })
}

/** Answer a GET with fixed JSON. */
export const mockJson = (page, pattern, body, status = 200) =>
  page.route(pattern, (route) => (route.request().method() === 'GET' ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }) : route.fallback()))
