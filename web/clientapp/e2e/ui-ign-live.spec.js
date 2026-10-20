// Ignition live in the Sim (Ranchero scene: key switch CB-1 DI3, PDM-02 main on sync 0x740): on / off on the Ignition
// page and the dashboard tile, followers' link when the main goes quiet. The main is silenced by turning its Ignition
// block off on the module alone (RAM, over the Sim's SLCAN bridge) and back on: the project is not touched.
import { test, expect } from '@playwright/test'
import net from 'node:net'
import { open, watchErrors } from './helpers.js'
import { SIM_MCP, deviceByName, waitFor } from './api.js'

const appErrors = (errors) => errors.filter((e) => !/Failed to load resource: the server responded with a status of 403/.test(e))
async function sim(name, args) {
  const r = await fetch(SIM_MCP, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  return (await r.json()).result
}
const key = (on) => sim('sim_switch', { node: 'CB-1.di3', state: on })
/** Write one param on the module only (cmd 2, not stored): the project keeps its value. */
async function modWrite(base, index, sub, value) {
  const [host, port] = (process.env.SIM_PORT ?? '').replace('tcp://', '').split(':')
  const s = net.connect(Number(port), host)
  await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej) })
  const hx = (n, w) => n.toString(16).toUpperCase().padStart(w, '0')
  s.write('O\r')
  s.write(`t${hx(base + 1, 3)}8${[2, index & 0xff, index >> 8, sub, value & 0xff, 0, 0, 0].map((v) => hx(v, 2)).join('')}\r`)
  await new Promise((r) => setTimeout(r, 1500))
  s.destroy()
}
const tile = (page) => page.locator('a, div').filter({ has: page.getByText('Ignition', { exact: true }) }).filter({ hasText: /from PDM-02|not sending|Not set up/ }).last()

test.describe.configure({ mode: 'serial' })
test.afterAll(async () => { await key(true) })

test('key off and on: the Ignition page banner and the dashboard tile follow, never a raw state number', async ({ page }) => {
  const errors = watchErrors(page)
  await key(true)
  await open(page, 'power/ignition')
  const banner = page.getByTestId('ignition-banner')
  await expect(banner).toContainText(/State: On · dash on · awake/, { timeout: 20_000 })
  await key(false)
  await expect(banner).toContainText(/State: Off · dash off/, { timeout: 20_000 })
  await expect(page.getByText(/CB-1 \(dash off · following the main · hears the main\)/)).toBeVisible()
  await open(page, 'live')
  await expect(tile(page)).toContainText('Off', { timeout: 20_000 })
  await key(true)
  await expect(tile(page)).toContainText('On', { timeout: 20_000 })
  // the tile only ever names a state (raw numbers came from another module's frame on the status slot)
  for (let i = 0; i < 10; i++) {
    await expect(tile(page)).not.toContainText(/Ignition\s*\d+/)
    await page.waitForTimeout(300)
  }
  expect(appErrors(errors)).toEqual([])
})

test('the main goes quiet: followers say "main lost", the banner says PDM-02 is not sending; back when it returns', async ({ page }) => {
  const errors = watchErrors(page)
  const main = await deviceByName('PDM-02')
  await open(page, 'power/ignition')
  const banner = page.getByTestId('ignition-banner')
  await expect(banner).toContainText(/State: On/, { timeout: 20_000 })
  try {
    await modWrite(main.baseId, 0x1E00, 0, 0)   // the main's Ignition block off: no sync, no status frame
    await expect(banner).toContainText('PDM-02 is not sending it', { timeout: 20_000 })
    await expect(page.getByText(/PDM-05 \(dash on · awake · main lost\)/)).toBeVisible({ timeout: 20_000 })
    // (not the dashboard tile here: the app also hears the module's write reply, so its record says the block is off)
  } finally {
    await modWrite(main.baseId, 0x1E00, 0, 1)
  }
  await waitFor(async () => (await deviceByName('PDM-05')).ignition?.status?.link === 1, 30_000, 'PDM-05 hears the main again')
  await open(page, 'power/ignition')
  await expect(banner).toContainText(/State: On/, { timeout: 20_000 })
  await expect(page.getByText(/PDM-05 \(dash on · awake · hears the main\)/)).toBeVisible()
  expect(appErrors(errors)).toEqual([])
})
