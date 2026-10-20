// Ignition live in the Sim (Ranchero scene: key switch CB-1 DI3, PDM-02 main on sync 0x740): on / off on the Ignition
// page and the dashboard tile, followers' link when the main goes quiet. The main is silenced by turning its Ignition
// block off on the module (RAM, over the Sim's SLCAN bridge; the app hears the reply too) and back on.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { deviceByName, waitFor } from './api.js'
import { appErrors, sim, modWrite } from './ui-ign-helpers.js'

const key = (on) => sim('sim_switch', { node: 'CB-1.di3', state: on })
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
