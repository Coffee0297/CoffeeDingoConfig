// CAN input detail (hardware/module/<guid>/input/caninput/<n>). Writes: PDM-05 CAN inputs 29 to 32 only; restored after each test.
import { test, expect } from '@playwright/test'
import { near } from './api.js'
import { open, watchErrors } from './helpers.js'
import { deviceByName, funcRow, withFunc, stepper, pickSelect, waitFor, apiJson } from './b-helpers.js'

test.describe.configure({ timeout: 120_000 })

let p5, p2
test.beforeAll(async () => { p5 = await deviceByName('PDM-05'); p2 = await deviceByName('PDM-02') })
const row = (n) => funcRow(p5.guid, 'canInputs', n)
const openCan = async (page, n) => { await open(page, `hardware/module/${p5.guid}/input/caninput/${n}`); await expect(page.getByTestId('save')).toBeVisible() }
const withCan = (n, fn) => withFunc(p5.guid, 'caninput', 'canInputs', n, fn)
const save = async (page) => { await page.getByTestId('save').dispatchEvent('click'); await expect(page.getByTestId('save-status')).toContainText(/Saved to/, { timeout: 30_000 }) }

test('reads a configured CAN input: live value, last frame, byte map and source choices', async ({ page }) => {
  const errors = watchErrors(page)
  await openCan(page, 1)   // "Headlights"
  await expect(page.getByTestId('in-state')).toContainText(/0x/)
  await expect(page.getByTestId('decoded')).toBeVisible()
  await expect(page.getByRole('img', { name: /Last frame 0x/ })).toBeVisible()
  await expect(page.getByText(/Last frame .* ago/)).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('img', { name: /Line graph of/ })).toBeVisible()
  // keypad buttons are picked in the flow builder: the choice is visibly disabled with its reason
  await expect(page.getByRole('radio', { name: /Keypad button/ })).toBeDisabled()
  await expect(page.getByText('in the flow builder')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: /Float/ })).toBeDisabled()
  expect(errors).toEqual([])
})

test('value on timeout is disabled behind a firmware badge', async ({ page }) => {
  await openCan(page, 29)
  await expect(page.getByLabel('Value to use then')).toBeDisabled()
  await expect(page.getByText('Needs firmware 5.6')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Update firmware' })).toHaveAttribute('href', '#/next/hardware/firmware')
})

test('picking another module\'s signal fills the frame fields and saves them', async ({ page }) => {
  const errors = watchErrors(page)
  await withCan(29, async () => {
    await openCan(page, 29)
    await expect(page.getByRole('radio', { name: 'Another module' })).toBeChecked()
    await pickSelect(page, 'Module', 'PDM-02')
    await page.getByTestId('search').fill('TotalCurrent')
    await expect(page.getByTestId('module-row')).toHaveCount(1)
    await page.getByTestId('module-row').click()
    const sigs = await apiJson('GET', `/api/devices/${p2.guid}/broadcast-signals?inUse=true`)
    const s = sigs.find((x) => x.name === 'TotalCurrent')
    await expect(page.getByTestId('can-id')).toHaveValue('0x' + (p2.baseId + s.offset).toString(16).toUpperCase().padStart(3, '0'))
    await expect(page.getByTestId('start-bit')).toHaveValue(String(s.startBit))
    await expect(page.getByTestId('bit-length')).toHaveValue(String(s.bitLength))
    await expect(page.getByTestId('factor')).toHaveValue(String(s.factor))
    await expect(page.getByTestId('name')).toHaveValue(/PDM-02 /)
    await expect(page.getByRole('switch', { name: 'Input in use' })).toBeChecked()
    await save(page)
    await waitFor(async () => { const r = await row(29); return r.enabled && r.id === p2.baseId + s.offset && r.startBit === s.startBit && r.bitLength === s.bitLength && near(r.factor, s.factor) }, 20_000, 'CAN input 29 on the module')
    await expect(page.getByTestId('in-state')).toContainText(/0x/)
  })
  expect(errors).toEqual([])
})

test('typed frame fields are checked and saved: ID, ID type, bits, byte order, sign, factor, offset', async ({ page }) => {
  const errors = watchErrors(page)
  await withCan(30, async () => {
    await openCan(page, 30)
    await page.getByRole('radio', { name: 'Type it in' }).click()
    await page.getByTestId('name').fill('MCPVAL b manual')
    await page.getByTestId('can-id').fill('0xZZ'); await page.getByTestId('can-id').blur()
    await expect(page.getByTestId('save-status')).toContainText('is not a CAN ID')
    await page.getByTestId('can-id').fill('0x1A5'); await page.getByTestId('can-id').blur()
    await page.getByTestId('start-bit').fill('70'); await page.getByTestId('start-bit').blur()
    await expect(page.getByTestId('save-status')).toContainText('Start bit must be 0 to 63')
    await page.getByTestId('start-bit').fill('12')
    await page.getByTestId('bit-length').fill('16')
    await page.getByRole('radio', { name: 'Big-endian' }).click()
    await page.getByRole('radio', { name: 'Extended' }).click()
    await expect(page.getByTestId('save-status')).not.toContainText('is not a CAN ID')
    await page.getByRole('radio', { name: 'Standard' }).click()
    await page.getByRole('checkbox', { name: 'Signed' }).click()
    await page.getByTestId('factor').fill('0.5')
    await page.getByTestId('offset').fill('-10')
    await page.getByRole('switch', { name: 'Input in use' }).click()
    await save(page)
    await waitFor(async () => { const r = await row(30); return r.enabled && r.name === 'MCPVAL b manual' && r.id === 0x1a5 && !r.ide && r.startBit === 12 && r.bitLength === 16 && r.byteOrder === 1 && r.signed && r.factor === 0.5 && r.offset === -10 }, 20_000, 'CAN input 30 on the module')
    await expect(page.getByTestId('in-state')).toContainText('0x1A5')
  })
  expect(errors).toEqual([])
})

test('timeout: switch and delay are saved', async ({ page }) => {
  await withCan(31, async () => {
    await openCan(page, 31)
    await expect(page.getByTestId('timeout')).toBeDisabled()
    await page.getByRole('checkbox', { name: /Treat it as lost after a gap/ }).click()
    await expect(page.getByTestId('timeout')).toBeEnabled()
    await stepper(page, 'Timeout').more.click()
    await expect(page.getByTestId('timeout')).toHaveValue('1050')
    await stepper(page, 'Timeout').input.fill('2500'); await stepper(page, 'Timeout').input.blur()
    await page.getByTestId('name').fill('MCPVAL b timeout')
    await save(page)
    await waitFor(async () => { const r = await row(31); return r.timeoutEnabled && r.timeout === 2500 }, 20_000, 'timeout on the module')
  })
})

test('DBC source without a file explains what to do and offers Import', async ({ page }) => {
  await openCan(page, 32)
  await page.getByRole('radio', { name: /ECU \(DBC file\)/ }).click()
  const hasDbc = await page.getByTestId('dbc-row').count().catch(() => 0)
  if (!hasDbc) await expect(page.getByText('No ECU file imported yet')).toBeVisible()
  await expect(page.getByTestId('import-dbc')).toBeVisible()
})

// ---- Learn a switch
const FRAMES = (t) => {
  // a bus with a counter on 0x1F0, a noisy bit on 0x551 and a switch on bit 12 of 0x3A1 that flips four times
  const flips = [1.0, 2.2, 3.4, 4.6]
  const on = flips.filter((f) => t > f).length % 2 === 1
  const counter = Math.floor(t * 10) % 16
  const noisy = Math.floor(t * 10) % 2
  const byte1 = (on ? 0x10 : 0)
  return [
    { dir: 'Rx', id: 0x3a1, ide: false, len: 8, data: `00 ${byte1.toString(16).padStart(2, '0')} 00 00 00 00 00 00`, count: 100 + Math.floor(t * 10) },
    { dir: 'Rx', id: 0x1f0, ide: false, len: 8, data: `${counter.toString(16).padStart(2, '0')} 00 00 00 00 00 00 00`, count: 100 + Math.floor(t * 10) },
    { dir: 'Rx', id: 0x551, ide: false, len: 8, data: `00 00 ${noisy ? '20' : '00'} 00 00 00 00 00`, count: 100 + Math.floor(t * 10) },
  ]
}
// stands in for GET /api/canlog/changes (G17): a change event whenever an id's data differs from before
async function mockBus(page) {
  const t0 = { v: 0 }, last = new Map()
  await page.route('**/api/canlog/changes*', async (route) => {
    const now = Date.now()
    if (!t0.v) t0.v = now
    const changes = []
    for (const f of FRAMES((now - t0.v) / 1000)) {
      const data = f.data.replace(/ /g, ''), prev = last.get(f.id) ?? null
      if (prev !== data) { changes.push({ t: now, id: f.id, ext: false, dir: 'Rx', data, prev }); last.set(f.id, data) }
    }
    await route.fulfill({ json: { now, changes } })
  })
  return t0
}

test('the backend keeps a timestamped history of data changes per id (G17)', async () => {
  const a = await apiJson('GET', '/api/canlog/changes?since=0&max=500')
  expect(a.changes.length).toBeGreaterThan(0)
  const c = a.changes.at(-1)
  expect(typeof c.t).toBe('number'); expect(c.t).toBeLessThanOrEqual(a.now)
  expect(c.data).toMatch(/^([0-9A-F]{2})*$/)
  // polling from "now" returns only what changed after it
  await new Promise((r) => setTimeout(r, 500))
  const b = await apiJson('GET', '/api/canlog/changes?since=' + a.now)
  expect(b.changes.every((x) => x.t > a.now)).toBe(true)
})

test('Learn a switch finds the bit that followed the switch and fills the frame fields', async ({ page }) => {
  const errors = watchErrors(page)
  await withCan(32, async () => {
    const t0 = await mockBus(page)
    await openCan(page, 32)
    await page.getByRole('radio', { name: 'Type it in' }).click()
    t0.v = 0
    await page.getByTestId('learn').click()
    await expect(page.getByRole('dialog', { name: 'Learn a switch' })).toBeVisible()
    await expect(page.getByTestId('learn-timer')).toBeVisible()
    await expect(page.getByTestId('learn-bits')).not.toHaveText('0', { timeout: 15_000 })
    await expect(page.getByTestId('learn-summary')).toBeVisible({ timeout: 20_000 })
    const cands = page.getByTestId('cand')
    await expect(cands.first()).toContainText('0x3A1')
    await expect(cands.first()).toContainText('bit 12')
    await expect(cands.first()).toContainText('Best match')
    await expect(page.getByTestId('learn-note')).toContainText('Using 0x3A1 bit 12')
    // the counter and the noisy bit are listed but ignored: choosing one disables Use this bit
    const ignored = cands.filter({ hasText: /Ignored/ })
    expect(await ignored.count()).toBeGreaterThan(0)
    await ignored.first().click()
    await expect(page.getByTestId('learn-use')).toBeDisabled()
    await cands.first().click()
    await expect(page.getByTestId('learn-use')).toBeEnabled()
    await page.getByTestId('learn-use').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('Filled in by Learn')).toBeVisible()
    await expect(page.getByTestId('can-id')).toHaveValue('0x3A1')
    await expect(page.getByTestId('start-bit')).toHaveValue('12')
    await expect(page.getByTestId('bit-length')).toHaveValue('1')
    await save(page)
    await waitFor(async () => { const r = await row(32); return r.enabled && r.id === 0x3a1 && r.startBit === 12 && r.bitLength === 1 && r.name === 'Learned switch' }, 20_000, 'learned bit on the module')
  })
  expect(errors).toEqual([])
})

test('Learn a switch: Stop now ends early, Record again restarts, Cancel closes', async ({ page }) => {
  const errors = watchErrors(page)
  await openCan(page, 29)
  await page.getByTestId('learn').click()
  await expect(page.getByTestId('learn-timer')).toBeVisible()
  await page.getByTestId('learn-stop').click()
  await expect(page.getByTestId('learn-again')).toBeVisible()      // a result or the "nothing followed" help
  await page.getByTestId('learn-again').click()
  await expect(page.getByTestId('learn-timer')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Learn a switch with nothing changing explains what to check', async ({ page }) => {
  await page.route('**/api/canlog', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: [{ dir: 'Rx', id: 0x100, ide: false, len: 8, data: '00 00 00 00 00 00 00 00', count: 5 }] }) : route.continue())
  await openCan(page, 29)
  await page.getByTestId('learn').click()
  await page.getByTestId('learn-stop').click()
  await expect(page.getByText('Nothing followed the switch')).toBeVisible()
  await expect(page.getByText(/Flip it slower/)).toBeVisible()
  await page.getByRole('button', { name: 'Pick the bit by hand' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

// Imports an ECU file into the project (adds a module entry), so it runs alone; the entry is removed afterwards.
test('DBC import then search and pick an ECU signal @exclusive', async ({ page }) => {
  const dbc = 'VERSION ""\nNS_ :\nBS_:\nBU_: ECU\nBO_ 201 MCPVAL_ENGINE: 8 ECU\n SG_ MCPVAL_RPM : 15|16@0+ (0.25,0) [0|16000] "rpm" Vector__XXX\n SG_ MCPVAL_FAN : 3|1@1+ (1,0) [0|1] "" Vector__XXX\n'
  await withCan(29, async () => {
    await openCan(page, 29)
    await page.getByRole('radio', { name: /ECU \(DBC file\)/ }).click()
    await page.getByTestId('dbc-file').setInputFiles({ name: 'mcpval_b.dbc', mimeType: 'text/plain', buffer: Buffer.from(dbc) })
    await page.getByTestId('search').fill('rpm')
    await expect(page.getByTestId('dbc-row')).toHaveCount(1, { timeout: 15_000 })
    await page.getByTestId('dbc-row').click()
    await expect(page.getByTestId('can-id')).toHaveValue('0x0C9')
    await expect(page.getByTestId('bit-length')).toHaveValue('16')
    await expect(page.getByTestId('factor')).toHaveValue('0.25')
  })
  const devs = await apiJson('GET', '/api/devices')
  for (const d of devs.filter((x) => /mcpval_b/i.test(x.name))) await apiJson('POST', `/api/devices/${d.guid}/remove`)
})
