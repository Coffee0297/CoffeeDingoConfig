// Expert > CAN & parameters: CAN map, DBC devices, Parameters, Compare.
// Writes go to PDM-05 only (output 8 parameters, CAN input slot 29) and are put back.
import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'
import { API, safeGuid, paramValue, fakeTelemetry } from './f-helpers.js'
import { buildRows } from '../src/next/screens/expert/parts/canmap.js'
import { buildDbc } from '../src/next/screens/expert/parts/dbcexport.js'

// PDM-05 sometimes drops out of the live list for a few seconds on the busy shared bus; Read/Write wait for it to come back.
test.use({ actionTimeout: 60_000 })
const f32 = (v) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); return d.getUint32(0, true) }
const writeRaw = (guid, name, idx, sub, raw) => apiJson('POST', `/api/devices/${guid}/writeparam`, { Index: idx, Sub: sub, Value: raw })
const goTab = async (page, name) => { await page.getByRole('tab', { name }).click() }

// ---------------------------------------------------------------- CAN map
test('CAN map lists owners with rates and filters', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'expert/can')
  const table = page.getByTestId('can-table')
  await expect(table).toBeVisible()
  const map = await apiJson('GET', '/api/can-id-map')
  const owners = new Set(Object.values(map.claimed).flat())
  for (const o of [...owners].slice(0, 6)) await expect(table).toContainText(o)
  await expect(page.getByTestId('can-clash-count')).toContainText(map.collisions.length + map.overlaps.length ? /clash/ : 'No clashes')
  await expect(page.getByText(/ids in use/)).toBeVisible()
  // the Sim sends broadcasts: a rate in Hz and "just now" appear after a couple of polls
  await expect(table.locator('tbody tr', { hasText: 'broadcast' }).first()).toContainText(/\d+(\.\d)? Hz/, { timeout: 15_000 })
  await expect(table.locator('tbody tr', { hasText: 'broadcast' }).first()).toContainText('just now')
  // ids sent only by Lua on several modules are shown as shared on purpose, not as clashes
  if (map.shared.length) await expect(table).toContainText('Shared on purpose')
  // selecting a row fills the detail panel
  const first = table.locator('tbody tr').first().getByRole('button')
  await first.click()
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('can-detail')).toContainText('Owner')
  // filters
  await page.getByTestId('can-filter-res').click()
  await expect(table).toContainText('OBD-II')
  await expect(table).toContainText('0x7DF')
  await expect(table).not.toContainText('broadcast')
  await page.getByTestId('can-filter-ecu').click()
  await expect(page.getByText('No id matches this filter.')).toBeVisible()
  await page.getByTestId('can-filter-all').click()
  await expect(table).toContainText('broadcast')
  expect(errors).toEqual([])
})

test('a clash is shown with a square and the word Clash, and links to the fix (mocked map)', async ({ page }) => {
  const errors = watchErrors(page)
  const pdm4 = await deviceByName('PDM-04')
  await page.route('**/api/can-id-map', async (route) => {
    const real = await (await fetch(API + '/api/can-id-map')).json()
    const owners = ['PDM-04: broadcast', 'Engine ECU: ECU Wheel_speed']
    real.collisions.push({ id: pdm4.baseId + 2, hex: '0x' + (pdm4.baseId + 2).toString(16).toUpperCase(), ide: false, owners })
    real.claimed[(pdm4.baseId + 2).toString(16).toUpperCase()] = owners
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(real) })
  })
  await open(page, 'expert/can')
  await expect(page.getByTestId('can-clash-count')).toContainText('1 clash')
  const row = page.getByTestId('can-table').locator('tr[data-status="clash"]').first()
  await expect(row).toBeVisible()
  await expect(row).toContainText('Clash')
  await expect(row).toContainText('■')
  await page.getByTestId('can-filter-clash').click()
  await expect(page.getByTestId('can-table').locator('tbody tr')).toHaveCount(1)
  await expect(page.getByTestId('can-detail')).toContainText('More than one device sends this id')
  await page.getByRole('link', { name: /Change the base ID of PDM-04/ }).click()
  await expect(page).toHaveURL(new RegExp('#/next/hardware/module/' + pdm4.guid))
  expect(errors).toEqual([])
})

test('an id inside the OBD-II reserved range that something uses is a clash (mocked map)', async ({ page }) => {
  const errors = watchErrors(page)
  await page.route('**/api/can-id-map', async (route) => {
    const real = await (await fetch(API + '/api/can-id-map')).json()
    real.claimed['7E2'] = ['PDM-04: CAN out odd']
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(real) })
  })
  await open(page, 'expert/can')
  await page.getByTestId('can-filter-clash').click()
  const row = page.getByTestId('can-table').locator('tbody tr')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('0x7E2')
  await expect(page.getByTestId('can-detail')).toContainText('OBD-II')
  expect(errors).toEqual([])
})

test('the CAN map logic merges neighbours and finds collisions, overlaps and reserved ids', () => {
  const devices = [{ name: 'PDM-A', type: 'dingoPDM', baseId: 0x680, guid: 'a' }, { name: 'PDM-B', type: 'dingoPDM', baseId: 0x690, guid: 'b' }]
  const claimed = {}
  for (let i = 2; i <= 5; i++) claimed[(0x680 + i).toString(16).toUpperCase()] = ['PDM-A: broadcast']
  claimed['7E0'] = ['PDM-A: CAN out x']
  claimed['3E0'] = ['ECU: ECU Temps']
  const map = { claimed, collisions: [{ id: 0x3e0, ide: false, owners: ['ECU: ECU Temps', 'PDM-B: CAN out y'] }], shared: [], overlaps: [{ a: 'PDM-A', b: 'PDM-B' }] }
  claimed['3E0'] = ['ECU: ECU Temps', 'PDM-B: CAN out y']
  const rows = buildRows({ map, log: [{ id: 0x5aa, ide: false, count: 4 }], devices })
  const bc = rows.find((r) => r.lo === 0x682)
  expect(bc.hi).toBe(0x685)
  expect(bc.count).toBe(4)
  expect(rows.find((r) => r.lo === 0x3e0).status).toBe('clash')
  expect(rows.find((r) => r.lo <= 0x7e0 && r.hi >= 0x7e0).status).toBe('clash')
  expect(rows.find((r) => r.lo === 0x5aa).status).toBe('unknown')
  // block overlap 0x690..0x69D is shared by both modules
  expect(rows.find((r) => r.lo <= 0x692 && r.hi >= 0x692).status).toBe('clash')
  expect(rows.find((r) => r.kind === 'res' && r.lo === 0x7df)).toBeTruthy()
})

// ---------------------------------------------------------------- DBC devices
const FAKE = '11111111-2222-3333-4444-555555555555'
const SIGS = [
  { name: 'E2eCoolant', id: 0x3e1, ide: false, messageName: 'EngineTemps', startBit: 0, length: 8, byteOrder: 0, isSigned: false, factor: 1, offset: -40, unit: 'C', min: -40, max: 215, value: 87 },
  { name: 'EngineRpm', id: 0xc9, ide: false, messageName: 'EngineSpeed', startBit: 8, length: 16, byteOrder: 1, isSigned: false, factor: 0.25, offset: 0, unit: 'rpm', min: 0, max: 8000, value: 1200 },
  { name: 'ThrottlePos', id: 0x5f0, ide: false, messageName: 'Throttle', startBit: 0, length: 8, byteOrder: 0, isSigned: false, factor: 0.4, offset: 0, unit: '%', min: 0, max: 100, value: 12 },
]
async function mockDbc(page, posts = []) {
  await page.route('**/api/devices', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const real = await (await fetch(API + '/api/devices')).json()
    real.push({ guid: FAKE, name: 'MCPVAL_ECU', type: 'dbcdevice', baseId: 0 })
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(real) })
  })
  await page.route(`**/api/devices/${FAKE}/dbc/search**`, async (route) => {
    const q = (new URL(route.request().url()).searchParams.get('q') ?? '').toLowerCase()
    const items = SIGS.filter((s) => !q || s.name.toLowerCase().includes(q) || s.messageName.toLowerCase().includes(q))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total: SIGS.length, more: false, items }) })
  })
  await page.route(`**/api/devices/${FAKE}/dbc/signals**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: SIGS.length, items: SIGS }) }))
  await page.route(`**/api/devices/${FAKE}/dbc/signal`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    posts.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
}
const canInput = async (guid, n) => (await apiJson('GET', `/api/devices/${guid}/functions`)).canInputs.find((c) => c.number === n)

test('DBC devices: list, search, and use a signal as a CAN input on PDM-05 slot 29, then undo (mocked DBC device)', async ({ page }) => {
  const errors = watchErrors(page)
  const g = await safeGuid()
  const before = await canInput(g, 29)
  expect(before.enabled).toBe(false)
  try {
    await mockDbc(page)
    await open(page, 'expert/can')
    await goTab(page, 'DBC devices')
    await expect(page.getByTestId('dbc-list')).toContainText('MCPVAL_ECU')
    await expect(page.getByTestId('dbc-list')).toContainText('3 signals')
    await expect(page.getByTestId('dbc-hits')).toContainText('E2eCoolant')
    // search sends the term to the backend and narrows the table
    const req = page.waitForRequest((r) => r.url().includes('/dbc/search') && r.url().includes('q=rpm'))
    await page.getByTestId('dbc-search').fill('rpm')
    await req
    await expect(page.getByTestId('dbc-hits').locator('tbody tr')).toHaveCount(1)
    await expect(page.getByTestId('dbc-hits')).toContainText('EngineRpm')
    await page.getByTestId('dbc-search').fill('')
    // pick the module and the slot
    await page.getByTestId('dbc-target').click()
    await page.getByRole('option', { name: 'PDM-05' }).click()
    await page.getByTestId('dbc-slot').click()
    await page.getByRole('option', { name: 'CAN input 29' }).click()
    const row = page.getByTestId('dbc-hits').locator('tbody tr', { hasText: 'E2eCoolant' })
    // the bus is shared and busy: when the module does not confirm the 11 writes in time the screen shows the error and
    // the button stays, so click again (a second click finds the slot already decoding this frame and says "Already")
    for (let i = 0; i < 3; i++) {
      await row.getByTestId('dbc-use').dispatchEvent('click')
      await expect(row).toContainText(/Added|Already/, { timeout: 20_000 }).catch(() => {})
      if (await row.getByTestId('dbc-use').count() === 0) break
    }
    await expect(row).toContainText(/(Added|Already) · PDM-05 CAN in 29/)
    const ci = await waitFor(async () => { const c = await canInput(g, 29); return c.enabled ? c : null }, 10_000, 'CAN input 29 enabled')
    expect(ci.id).toBe(0x3e1)
    expect(ci.startBit).toBe(0)
    expect(ci.bitLength).toBe(8)
    expect(ci.name).toBe('E2eCoolant')
    // undo frees the slot again (only offered when this click made the input)
    const undo = row.getByRole('button', { name: 'Undo' })
    if (await undo.count()) {
      await undo.click()
      await waitFor(async () => !(await canInput(g, 29)).enabled, 20_000, 'CAN input 29 free').catch(() => {})
      await expect(row.getByTestId('dbc-use')).toBeVisible()
      await row.getByTestId('dbc-use').dispatchEvent('click')
      await expect(row).toContainText(/Added|Already/, { timeout: 20_000 })
    }
    await page.reload()
    await expect(page.getByTestId('connection-pill')).toContainText(/live/i, { timeout: 20_000 })
    await goTab(page, 'DBC devices')
    await page.getByTestId('dbc-target').click()
    await page.getByRole('option', { name: 'PDM-05' }).click()
    const row2 = page.getByTestId('dbc-hits').locator('tbody tr', { hasText: 'E2eCoolant' })
    await row2.getByTestId('dbc-use').dispatchEvent('click')
    // the car itself may already read this signal on another input; the first match is shown
    await expect(row2).toContainText(/Already · PDM-05 CAN in \d+/)
  } finally {
    for (let i = 0; i < 6 && (await canInput(g, 29)).enabled; i++) {
      await apiJson('POST', `/api/devices/${g}/function/caninput/29`, before).catch(() => {})
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  expect((await canInput(g, 29)).enabled).toBe(false)
  expect(errors).toEqual([])
})

test('DBC devices: define a signal sends the right fields and bad input is explained (mocked DBC device)', async ({ page }) => {
  const errors = watchErrors(page)
  const posts = []
  await mockDbc(page, posts)
  await open(page, 'expert/can')
  await goTab(page, 'DBC devices')
  await page.getByTestId('sg-name').fill('Brake')
  await page.getByTestId('sg-id').fill('zz')
  await page.getByTestId('sg-add').click()
  await expect(page.getByTestId('sg-error')).toContainText('not a valid 11-bit CAN id')
  expect(posts).toHaveLength(0)
  await page.getByTestId('sg-id').fill('0x1A0')
  await page.getByTestId('sg-start').fill('70')
  await page.getByTestId('sg-add').click()
  await expect(page.getByTestId('sg-error')).toContainText('Start bit must be 0 to 63')
  await page.getByTestId('sg-start').fill('12')
  await page.getByTestId('sg-len').fill('4')
  await page.getByRole('radio', { name: /Motorola/ }).click()
  await page.getByRole('checkbox', { name: 'Signed' }).click()
  await page.getByTestId('sg-add').click()
  await expect(page.locator('[role=status],[role=alert]').filter({ hasText: 'Added signal Brake.' }).first()).toBeVisible()
  expect(posts).toHaveLength(1)
  expect(posts[0]).toMatchObject({ name: 'Brake', id: 0x1a0, extended: false, startBit: 12, length: 4, byteOrder: 1, isSigned: true, isFloat: false, factor: 1, offset: 0 })
  expect(errors).toEqual([])
})

test('DBC devices: export one combined DBC from the live project', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'expert/can')
  await goTab(page, 'DBC devices')
  await expect(page.getByText('No DBC file imported yet')).toBeVisible()
  const dl = page.waitForEvent('download')
  await page.getByTestId('dbc-export').click()
  const file = await dl
  expect(file.suggestedFilename()).toBe('dingo-combined.dbc')
  const txt = fs.readFileSync(await file.path(), 'utf8')
  expect(txt).toMatch(/^VERSION ""/)
  expect(txt).toMatch(/BU_: .*PDM_05/)
  expect(txt).toMatch(/BO_ \d+ PDM_05_[0-9A-F]+: 8 PDM_05/)
  expect(txt).toMatch(/ SG_ \S+ : \d+\|\d+@[01][+-] \(/)
  await expect(page.getByTestId('dbc-export-note')).toContainText('Saved dingo-combined.dbc')
  // switching everything off explains instead of saving an empty file
  await page.getByRole('checkbox', { name: /dingo modules/ }).click()
  await page.getByRole('checkbox', { name: /ECU devices/ }).click()
  await page.getByTestId('dbc-export').click()
  await expect(page.getByTestId('dbc-export-note')).toContainText('Nothing to export')
  expect(errors).toEqual([])
})

test('the DBC writer makes valid message and signal lines', () => {
  const txt = buildDbc([
    { node: 'PDM-01', id: 0x6a2, ide: false, msg: 'PDM-01_6A2', sig: { name: 'Output 1', startBit: 0, length: 8, byteOrder: 0, isSigned: false, isFloat: false, factor: 0.1, offset: -5, unit: 'A' } },
    { node: 'ECU', id: 0x18ff0001, ide: true, msg: 'Big', sig: { name: 'Speed', startBit: 7, length: 16, byteOrder: 1, isSigned: true, isFloat: false, factor: 1, offset: 0, unit: '' } },
    { node: 'PDM-01', id: 0x6a3, ide: false, msg: 'Fl', sig: { name: 'F', startBit: 0, length: 32, byteOrder: 0, isSigned: true, isFloat: true, factor: 1, offset: 0, unit: '' } },
  ])
  expect(txt).toContain('BU_: PDM_01 ECU')
  expect(txt).toContain('BO_ 1698 PDM_01_6A2: 8 PDM_01')
  expect(txt).toContain(' SG_ Output_1 : 0|8@1+ (0.1,-5) [0|0] "A" Vector__XXX')
  expect(txt).toContain(`BO_ ${(0x18ff0001 | 0x80000000) >>> 0} Big: 8 ECU`)
  expect(txt).toContain(' SG_ Speed : 7|16@0- (1,0)')
  expect(txt).toContain('SIG_VALTYPE_ 1699 F : 1;')
})

test('importing a DBC file adds an ECU device, search works, a signal can be defined, remove cleans up @exclusive', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = watchErrors(page)
  const name = 'MCPVAL_f_ecu'
  const dbc = 'VERSION ""\nNS_ :\nBS_:\nBU_: ECU\nBO_ 1000 EngineTemps: 8 ECU\n SG_ CoolantTemp : 0|8@1+ (1,-40) [-40|215] "C" Vector__XXX\n SG_ OilTemp : 8|8@1+ (1,-40) [-40|215] "C" Vector__XXX\n\nBO_ 201 EngineSpeed: 8 ECU\n SG_ EngineRpm : 0|16@1+ (0.25,0) [0|8000] "rpm" Vector__XXX\n'
  const before = (await apiJson('GET', '/api/devices')).length
  try {
    await open(page, 'expert/can')
    await goTab(page, 'DBC devices')
    await page.getByTestId('dbc-import').click()
    await page.getByTestId('dbc-import-go').click()
    await expect(page.getByRole('dialog')).toContainText('Choose a .dbc file first.')
    await page.getByTestId('dbc-file').setInputFiles({ name: 'test.dbc', mimeType: 'text/plain', buffer: Buffer.from(dbc) })
    await page.getByTestId('dbc-name').fill(name)
    await page.getByTestId('dbc-import-go').click()
    await expect(page.getByTestId('dbc-list')).toContainText(name)
    await expect(page.getByTestId('dbc-list')).toContainText('3 signals')
    await expect(page.getByTestId('dbc-hits')).toContainText('CoolantTemp')
    await page.getByTestId('dbc-search').fill('rpm')
    await expect(page.getByTestId('dbc-hits').locator('tbody tr')).toHaveCount(1)
    await page.getByTestId('dbc-search').fill('')
    await page.getByTestId('sg-name').fill('Extra')
    await page.getByTestId('sg-id').fill('0x2A0')
    await page.getByTestId('sg-add').click()
    await expect(page.getByTestId('dbc-list')).toContainText('4 signals')
    await page.getByTestId('dbc-remove').click()
    await page.getByTestId('dbc-remove-go').click()
    await expect(page.getByTestId('dbc-list')).toHaveCount(0)
  } finally {
    for (const d of await apiJson('GET', '/api/devices')) if (d.name === name) await apiJson('POST', `/api/devices/${d.guid}/remove`)
  }
  expect((await apiJson('GET', '/api/devices')).length).toBe(before)
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- Parameters (PDM-05 output 8 only)
// The shared Sim bus is busy with other tests: a write is sometimes not acknowledged in time. The screen says so
// ("did not confirm") and the tests write again, up to a few times, instead of failing on bus noise.
const NAME = 'output[8].currentLimit'
const rowOf = (page, name) => page.locator(`tr[data-param="${name}"]`)
const resultOf = (page, name) => page.locator(`tr[data-param="${name}"] + tr.msg [data-testid=par-result]`)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
async function findParam(page, name) {
  await goTab(page, 'Parameters')
  await page.getByTestId('par-module').click()
  await page.getByRole('option', { name: 'PDM-05' }).click()
  await page.getByTestId('par-search').fill(name)
  await expect(rowOf(page, name)).toHaveCount(1)
}
/** Click Write, confirm, wait for the answer; retry when the module did not confirm in time. */
async function writeUi(page, name, expected) {
  for (let i = 0; i < 8; i++) {
    const btn = rowOf(page, name).getByTestId('par-write')
    await btn.dispatchEvent('click')
    const resp = page.waitForResponse((r) => r.url().includes('/writeparam') && r.request().method() === 'POST', { timeout: 30_000 })
    await page.getByTestId('par-confirm').dispatchEvent('click')
    await resp
    await expect(btn).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
    const t = (await resultOf(page, name).textContent()) ?? ''
    if (t.includes(expected)) return
    if (!/did not confirm/.test(t)) throw new Error(`Unexpected answer for ${name}: ${t}`)
  }
  throw new Error(`The module never confirmed the write of ${name}`)
}
/** Put a parameter back through the API, trying again when the module does not answer. */
async function restoreParam(guid, name, idx, sub, raw, want) {
  for (let i = 0; i < 6; i++) {
    if ((await paramValue(guid, name)) === want) return
    await writeRaw(guid, name, idx, sub, raw).catch(() => {})
    await new Promise((r) => setTimeout(r, 1500))
  }
  expect(await paramValue(guid, name)).toBe(want)
}

test('Parameters: search narrows the list, labels are read only', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'expert/can')
  await goTab(page, 'Parameters')
  await expect(page.getByText(/of 1\d,\d{3} parameters/)).toBeVisible()   // grows with each firmware's params
  await expect(page.getByText('Showing the first 100.')).toBeVisible()
  await findParam(page, 'output[8].name')
  const w = rowOf(page, 'output[8].name').getByTestId('par-write')
  await expect(w).toBeDisabled()
  await expect(w).toHaveAttribute('title', /stored in the project only/)
  await page.getByTestId('par-search').fill('no-such-parameter')
  await expect(page.getByText('No parameter matches.')).toBeVisible()
  expect(errors).toEqual([])
})

test('Parameters: read, write with a confirmed read-back, then restore (PDM-05 output 8)', async ({ page }) => {
  test.setTimeout(180_000)
  const errors = watchErrors(page)
  const g = await safeGuid()
  expect(await paramValue(g, NAME)).toBe(6)
  try {
    await open(page, 'expert/can')
    await findParam(page, NAME)
    const row = rowOf(page, NAME)
    await expect(resultOf(page, NAME)).toContainText('Not read or written yet')
    await row.getByTestId('par-read').dispatchEvent('click')
    await expect(resultOf(page, NAME)).toContainText('Read 6 from PDM-05.')
    // write 7: the confirm dialog names the parameter and the value; Cancel sends nothing
    await row.locator('input').fill('7')
    await row.getByTestId('par-write').dispatchEvent('click')
    const dlg = page.getByRole('dialog')
    await expect(dlg).toContainText(NAME)
    await expect(dlg).toContainText('= 7')
    await dlg.getByRole('button', { name: 'Cancel' }).click()
    await expect(dlg).toHaveCount(0)
    expect(await paramValue(g, NAME)).toBe(6)
    await writeUi(page, NAME, 'Wrote 7. Read back 7.')
    expect(await paramValue(g, NAME)).toBe(7)
    await waitFor(async () => (await deviceByName('PDM-05')).outputs.find((o) => o.number === 8).currentLimit === 7, 10_000, 'telemetry shows 7 A')
    // a second read agrees
    await row.getByTestId('par-read').dispatchEvent('click')
    await expect(resultOf(page, NAME)).toContainText('Read 7 from PDM-05.')
    // restore through the UI
    await row.locator('input').fill('6')
    await writeUi(page, NAME, 'Wrote 6. Read back 6.')
  } finally {
    await restoreParam(g, NAME, 4103, 2, f32(6), 6)
  }
  expect(await paramValue(g, NAME)).toBe(6)
  expect(errors).toEqual([])
})

test('Parameters: a value the module does not accept is reported and the module keeps its value', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = watchErrors(page)
  const g = await safeGuid()
  try {
    await open(page, 'expert/can')
    await findParam(page, NAME)
    const row = rowOf(page, NAME)
    await row.locator('input').fill('1000')
    await row.getByTestId('par-write').dispatchEvent('click')
    const resp = page.waitForResponse((r) => r.url().includes('/writeparam'), { timeout: 30_000 })
    await page.getByTestId('par-confirm').dispatchEvent('click')
    await resp
    await expect(resultOf(page, NAME)).toContainText(/Refused by the module|did not confirm/, { timeout: 30_000 })
    await expect(resultOf(page, NAME)).toContainText('It holds 6.')
    expect(await paramValue(g, NAME)).toBe(6)
    // a bad entry never leaves the browser
    await row.locator('input').fill('abc')
    await row.getByTestId('par-write').dispatchEvent('click')
    await expect(resultOf(page, NAME)).toContainText('Enter a number.')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  } finally {
    await restoreParam(g, NAME, 4103, 2, f32(6), 6)
  }
  expect(errors).toEqual([])
})

test('Parameters: on/off and list parameters write and read back, then restore (PDM-05 output 8)', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = watchErrors(page)
  const g = await safeGuid()
  const B = 'output[8].softStartEnabled', E = 'output[8].resetMode'
  expect([await paramValue(g, B), await paramValue(g, E)]).toEqual([false, 'None'])
  try {
    await open(page, 'expert/can')
    await findParam(page, B)
    await rowOf(page, B).locator('select').selectOption('on')
    await writeUi(page, B, 'Wrote on. Read back on.')
    expect(await paramValue(g, B)).toBe(true)
    await rowOf(page, B).locator('select').selectOption('off')
    await writeUi(page, B, 'Wrote off. Read back off.')
    await page.getByTestId('par-search').fill(E)
    await expect(rowOf(page, E)).toHaveCount(1)
    await rowOf(page, E).locator('select').selectOption('Count')
    await writeUi(page, E, 'Wrote Count. Read back Count.')
    expect(await paramValue(g, E)).toBe('Count')
    await rowOf(page, E).locator('select').selectOption('None')
    await writeUi(page, E, 'Wrote None. Read back None.')
  } finally {
    await restoreParam(g, B, 4103, 9, 0, false)
    await restoreParam(g, E, 4103, 5, 0, 'None')
  }
  expect([await paramValue(g, B), await paramValue(g, E)]).toEqual([false, 'None'])
  expect(errors).toEqual([])
})

test('Parameters: Write is off under the Sim adapter and Read and Write are off without a connection (injected telemetry)', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'expert/can')
  await findParam(page, NAME)
  const row = rowOf(page, NAME)
  await expect(row.getByTestId('par-write')).toBeEnabled()
  await fakeTelemetry(page, { adapter: 'Sim' })
  await expect(page.getByText('Sim adapter active.')).toBeVisible()
  await expect(row.getByTestId('par-write')).toBeDisabled()
  await expect(row.getByTestId('par-write')).toHaveAttribute('title', /Sim adapter/)
  await expect(row.getByTestId('par-read')).toBeEnabled()
  await fakeTelemetry(page, { adapter: null, connected: false })
  await expect(page.getByText('Not connected.').first()).toBeVisible()
  await expect(row.getByTestId('par-read')).toBeDisabled()
  await expect(row.getByTestId('par-write')).toBeDisabled()
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- Compare
test('Compare: every module has a state and PDM-05 can be read to compare', async ({ page }) => {
  test.setTimeout(180_000)
  const errors = watchErrors(page)
  await open(page, 'expert/can')
  await goTab(page, 'Compare')
  const chips = page.getByTestId('cmp-mod')
  await expect(chips).toHaveCount(7)
  for (const c of await chips.all()) await expect(c).toContainText(/same|not read yet|\d+ differ/)
  await page.getByRole('button', { name: /^PDM-05/ }).click()
  await page.getByTestId('cmp-read').click()
  await expect(page.getByRole('dialog')).toContainText('replace the project')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await page.getByTestId('cmp-read').click()
  await page.getByTestId('cmp-read-go').click()
  await expect(page.locator('[role=status],[role=alert]').filter({ hasText: /PDM-05: (same settings as the project|\d+ settings? differ)/ }).first()).toBeVisible({ timeout: 120_000 })
  expect(errors).toEqual([])
})

test('Compare: choices, bulk buttons and Apply send project values back to PDM-05 and keep the module value for the rest (mocked differences)', async ({ page }) => {
  test.setTimeout(180_000)
  const errors = watchErrors(page)
  const g = await safeGuid()
  const E = 'output[8].resetMode'
  await page.route(`**/api/devices/${g}/config-diff`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([
      { name: NAME, index: 4103, subIndex: 2, kind: 'value', appValue: '7', deviceValue: '6' },
      { name: E, index: 4103, subIndex: 5, kind: 'value', appValue: 'None', deviceValue: 'None' },
      { name: 'output[8].name', index: 4103, subIndex: 64, kind: 'value', appValue: 'Spare', deviceValue: null },
      { name: '0x1234:1', index: 4660, subIndex: 1, kind: 'deviceOnly', appValue: null, deviceValue: '5' },
    ]),
  }))
  try {
    await open(page, 'expert/can')
    await goTab(page, 'Compare')
    await page.getByRole('button', { name: /^PDM-05/ }).click()
    await expect(page.getByTestId('cmp-summary')).toContainText('4 settings differ')
    const table = page.getByTestId('cmp-table')
    // labels and settings the app does not know can't be sent
    await expect(table.locator('tr[data-param="output[8].name"] input[type=radio]').first()).toBeDisabled()
    await expect(table.locator('tr[data-param="0x1234:1"]')).toContainText('newer firmware')
    await expect(page.getByTestId('cmp-foot')).toContainText('2 undecided · 0 will be sent')
    await expect(page.getByTestId('cmp-apply')).toBeDisabled()
    await page.getByTestId('cmp-all-project').click()
    await expect(page.getByTestId('cmp-foot')).toContainText('0 undecided · 2 will be sent')
    await page.getByTestId('cmp-all-module').click()
    await expect(page.getByTestId('cmp-foot')).toContainText('0 undecided · 0 will be sent to the module · 2 keep')
    // first row: project value, second: module value
    await table.locator(`tr[data-param="${NAME}"]`).getByTestId('cmp-use-project').check()
    await expect(page.getByTestId('cmp-foot')).toContainText('1 will be sent to the module · 1 keep')
    const row = table.locator(`tr[data-param="${NAME}"]`)
    for (let i = 0; i < 4; i++) {
      const resp = page.waitForResponse((r) => r.url().includes('/writeparam'), { timeout: 30_000 })
      await page.getByTestId('cmp-apply').dispatchEvent('click')
      await resp
      await expect(page.getByTestId('cmp-apply')).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
      if (((await row.textContent()) ?? '').includes('Wrote 7. Read back 7.')) break
      await expect(row).toContainText('did not confirm')
    }
    await expect(row).toContainText('Wrote 7. Read back 7.')
    await expect(table.locator(`tr[data-param="${E}"]`)).toContainText("keeps the module's value")
    await expect(page.getByTestId('cmp-foot')).toContainText('Sent 1 to PDM-05 and read back: all match')
    expect(await paramValue(g, NAME)).toBe(7)
  } finally {
    await restoreParam(g, NAME, 4103, 2, f32(6), 6)
  }
  expect(await paramValue(g, NAME)).toBe(6)
  expect(errors).toEqual([])
})

test('Compare: sending to the module is off under the Sim adapter (injected telemetry, mocked differences)', async ({ page }) => {
  const errors = watchErrors(page)
  const g = await safeGuid()
  await page.route(`**/api/devices/${g}/config-diff`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ name: NAME, index: 4103, subIndex: 2, kind: 'value', appValue: '7', deviceValue: '6' }]) }))
  await open(page, 'expert/can')
  await goTab(page, 'Compare')
  await page.getByRole('button', { name: /^PDM-05/ }).click()
  await expect(page.getByTestId('cmp-table')).toBeVisible()
  await fakeTelemetry(page, { adapter: 'Sim' })
  await expect(page.getByText('Sim adapter active.')).toBeVisible()
  const row = page.locator(`tr[data-param="${NAME}"]`)
  await expect(row.getByTestId('cmp-use-project')).toBeDisabled()
  await expect(row.getByTestId('cmp-use-module')).toBeEnabled()
  await row.getByTestId('cmp-use-module').check()
  await expect(page.getByTestId('cmp-apply')).toBeEnabled()
  await page.getByTestId('cmp-apply').dispatchEvent('click')
  await expect(page.getByTestId('cmp-foot')).toContainText('Sent 0 to PDM-05')
  expect(await paramValue(g, NAME)).toBe(6)
  expect(errors).toEqual([])
})
