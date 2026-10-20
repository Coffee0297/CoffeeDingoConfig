// Car home: stats, car map (drag, keyboard, reset), needs-a-look, on-right-now, empty and offline states.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { inject, mockTrips, waveform, devs } from './e-util.js'

const PIN = 'pinpos'
const pinPos = (page) => page.evaluate((k) => localStorage.getItem(k), PIN)
const restorePins = (page, v) => page.evaluate(([k, x]) => (x == null ? localStorage.removeItem(k) : localStorage.setItem(k, x)), [PIN, v])
// A module with no stored position sits in the tray beside the car: put one on the car first (then reload).
const placePin = async (page, guid, p) => {
  await page.evaluate(([k, g, q]) => { const s = JSON.parse(localStorage.getItem(k) || '{}'); s[g] = q; localStorage.setItem(k, JSON.stringify(s)) }, [PIN, guid, p])
  await page.reload()
  await expect(page.locator(`[data-testid="map-tray"] a.pin[data-guid="${guid}"]`)).toHaveCount(0)
}

test('stats match what the modules report', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'car')
  const d = await devs()
  const pd = d.filter((x) => x.type === 'dingoPDM' && x.connected)
  const batt = Math.max(...pd.map((x) => x.battery))
  const shownBatt = parseFloat(await page.getByTestId('stat-battery').innerText())
  expect(Math.abs(shownBatt - batt)).toBeLessThan(0.6)
  const cur = pd.reduce((s, x) => s + x.current, 0)
  const shownCur = parseFloat(await page.getByTestId('stat-current').innerText())
  expect(Math.abs(shownCur - cur)).toBeLessThan(10)
  const hot = Math.max(...d.filter((x) => x.connected).map((x) => x.temp))
  expect(Math.abs(parseFloat(await page.getByTestId('stat-temp').innerText()) - hot)).toBeLessThan(3)
  const enabled = d.flatMap((x) => x.outputs ?? []).filter((o) => o.enabled !== false)
  const digital = d.flatMap((x) => x.digitalOut ?? []).filter((o) => o.enabled)   // a CANBoard's outputs count too
  await expect(page.getByTestId('stat-outputs')).toContainText(`of ${enabled.length + digital.length}`)
  const worst = enabled.reduce((s, o) => s + o.currentLimit, 0)
  await expect(page.getByText(`of ${Math.round(worst)} A if every output hit its limit`)).toBeVisible()
  await expect(page.getByTestId('stat-ignition')).toHaveText(/Not set up|Off|On|Cranking|Running|—/)
  expect(errors).toEqual([])
})

test('header actions: Find modules and Add function', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'car')
  await page.getByRole('button', { name: 'Find modules' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('link', { name: '+ Add function' }).click()
  await expect(page).toHaveURL(/#\/next\/functions\/add/)
  expect(errors).toEqual([])
})

test('car map shows every module and a pin opens the module', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'car')
  const d = await devs()
  for (const m of d) await expect(page.locator(`a.pin[data-guid="${m.guid}"]`)).toContainText(m.name)
  const m = d.find((x) => x.name === 'PDM-03')
  await page.locator(`a.pin[data-guid="${m.guid}"]`).click()
  await expect(page).toHaveURL(new RegExp('#/next/hardware/module/' + m.guid))
  expect(errors).toEqual([])
})

test('dragging a pin saves its place in the browser and Reset layout puts it back', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'car')
  const before = await pinPos(page)
  try {
    const d = await devs()
    const m = d.find((x) => x.name === 'CB-1')
    await placePin(page, m.guid, { x: 30, y: 50 })
    const pin = page.locator(`a.pin[data-guid="${m.guid}"]`)
    const b0 = await pin.boundingBox()
    await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2)
    await page.mouse.down()
    await page.mouse.move(b0.x + b0.width / 2 + 40, b0.y + b0.height / 2 + 30, { steps: 6 })
    await page.mouse.up()
    // a drag must not follow the link
    await expect(page).toHaveURL(/#\/next\/car/)
    const stored = JSON.parse(await pinPos(page))
    expect(stored[m.guid]).toBeTruthy()
    const b1 = await pin.boundingBox()
    expect(Math.abs(b1.x - b0.x - 40)).toBeLessThan(6)
    expect(Math.abs(b1.y - b0.y - 30)).toBeLessThan(6)
    // survives a reload
    await page.reload()
    await expect(page.locator(`a.pin[data-guid="${m.guid}"]`)).toBeVisible()
    const b2 = await page.locator(`a.pin[data-guid="${m.guid}"]`).boundingBox()
    expect(Math.abs(b2.x - b1.x)).toBeLessThan(4)
    // reset: every module to its default spot on the car
    const dragged = JSON.parse(await pinPos(page))[m.guid]
    await page.getByRole('button', { name: 'Reset layout' }).click()
    const after = JSON.parse((await pinPos(page)) ?? '{}')
    expect(after[m.guid]).toBeTruthy()
    expect(after[m.guid]).not.toEqual(dragged)
    for (const x of d) expect(after[x.guid]).toBeTruthy()
    await expect(page.getByTestId('map-tray')).toHaveCount(0)
    await expect(page.getByText('Layout reset to the default.')).toBeAttached()
  } finally {
    await restorePins(page, before)
  }
  expect(errors).toEqual([])
})

test('a pin moves with the arrow keys', async ({ page }) => {
  await open(page, 'car')
  const before = await pinPos(page)
  try {
    const m = (await devs()).find((x) => x.name === 'PDM-05')
    await placePin(page, m.guid, { x: 50, y: 50 })
    const pin = page.locator(`a.pin[data-guid="${m.guid}"]`)
    const b0 = await pin.boundingBox()
    await pin.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowUp')
    const b1 = await pin.boundingBox()
    expect(b1.x).toBeLessThan(b0.x - 4)
    expect(b1.y).toBeLessThan(b0.y - 4)
    await expect(page.getByText(/PDM-05 moved to/)).toBeAttached()
    await expect(page).toHaveURL(/#\/next\/car/)
  } finally {
    await restorePins(page, before)
  }
})

test('modules with no place wait in the tray, and Place them for me puts them on the car', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'car')
  const before = await pinPos(page)
  try {
    await restorePins(page, null)
    await page.reload()
    const d = await devs()
    const tray = page.getByTestId('map-tray')
    await expect(tray.locator('a.pin')).toHaveCount(d.length)
    await expect(tray).toContainText(`Not placed yet · ${d.length}`)
    await tray.getByRole('button', { name: 'Place them for me' }).click()
    await expect(tray).toHaveCount(0)
    const stored = JSON.parse(await pinPos(page))
    for (const m of d) expect(stored[m.guid]).toBeTruthy()
    // the same layout on the first-run map: nothing "not placed"
    await open(page, 'connect')
    for (const m of d.filter((x) => !/dbc/i.test(x.type))) await expect(page.getByTestId('first-' + m.name)).toContainText('placed ✓')   // the first-run list has modules only, no ECU
  } finally {
    await restorePins(page, before)
  }
  expect(errors).toEqual([])
})

test('Ignition not set up: the tile links to the setup and it needs a look', async ({ page }) => {
  await open(page, 'car')
  const v = page.getByTestId('stat-ignition')
  test.skip(!(await v.count()) || (await v.innerText()) !== 'Not set up', 'the ignition is set up (or the modules run older firmware)')
  await expect(page.getByRole('region', { name: 'Needs a look' })).toContainText('Ignition is not set up')
  await page.getByRole('link', { name: /Set up ignition/ }).click()
  await expect(page).toHaveURL(/#\/next\/power\/ignition/)
})

test('modules that differ from the project are listed and Review opens Apply', async ({ page }) => {
  const errors = watchErrors(page)
  const d = await devs()
  test.skip(!d.some((x) => x.configMismatch && x.connected), 'every module matches the project right now')
  await open(page, 'car')
  const item = page.getByRole('region', { name: 'Needs a look' })
  await expect(item).toContainText(/differs? from the project/)
  await item.getByRole('button', { name: 'Review' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

test('On right now lists live outputs and a row opens the output', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'car')
  const sec = page.getByRole('region', { name: 'On right now' })
  const rows = sec.locator('a.row')
  await expect(rows.first()).toBeVisible()
  await expect(rows.first()).toContainText(/\d+\.\d A/)
  await expect(sec.getByRole('link', { name: 'All functions →' })).toHaveAttribute('href', '#/next/functions')
  const more = sec.getByRole('button', { name: /Show all \d+/ })
  if (await more.count()) {
    const n = await rows.count()
    await more.click()
    expect(await rows.count()).toBeGreaterThan(n)
    await sec.getByRole('button', { name: 'Show fewer' }).click()
    expect(await rows.count()).toBe(8)
  }
  await rows.first().click()
  await expect(page).toHaveURL(/#\/next\/hardware\/module\/[0-9a-f-]+\/output\/\d+/)
  expect(errors).toEqual([])
})

test('a module that is not answering and a tripped output need a look', async ({ page }) => {
  const errors = watchErrors(page)
  const d = await devs()
  const p1 = d.find((x) => x.name === 'PDM-01')
  const out = p1.outputs.find((o) => o.enabled !== false)
  await mockTrips(page, p1.guid, [{ output: out.number, state: 'Overcurrent', peakA: 23, limitA: 15, samples: waveform() }])
  await open(page, 'car')
  await inject(page, { devices: { 'PDM-04': { connected: false } }, outputs: { [`PDM-01:${out.number}`]: { state: 'Overcurrent' } } })
  const sec = page.getByRole('region', { name: 'Needs a look' })
  await expect(sec).toContainText('PDM-04 is not answering')
  await expect(sec).toContainText(/tripped/)
  await expect(page.locator('a.pin[data-guid="' + d.find((x) => x.name === 'PDM-04').guid + '"]')).toContainText('not answering')
  await expect(sec).toContainText('23.0 A peak, limit')
  await sec.getByRole('link', { name: 'Why?' }).click()
  await expect(page).toHaveURL(new RegExp(`#/next/live/trips/${p1.guid}/0`))
  expect(errors).toEqual([])
})

test('no modules shows an empty state with a way to connect', async ({ page }) => {
  await open(page, 'car')
  await inject(page, { empty: true })
  await expect(page.getByText('No modules in this project yet')).toBeVisible()
  await page.getByRole('link', { name: 'Connect to the car' }).click()
  await expect(page).toHaveURL(/#\/next\/connect/)
})

test('not connected shows a warning with a Connect link and blank values', async ({ page }) => {
  await open(page, 'car')
  await inject(page, { top: { connected: false } })
  await expect(page.getByText('Not connected to the car.').first()).toBeVisible()
  await expect(page.getByTestId('stat-battery')).toContainText('-')
  await page.getByRole('region', { name: 'Needs a look' }).getByRole('link', { name: 'Connect' }).click()
  await expect(page).toHaveURL(/#\/next\/connect/)
})

test('engine rpm appears on Car home and the dashboard when a CAN input provides it', async ({ page }) => {
  const errors = watchErrors(page)
  const m = (await devs()).find((x) => x.name === 'PDM-04')
  await page.route(`**/api/devices/${m.guid}/signals`, async (r) => {
    const real = await r.fetch()
    const list = await real.json()
    list.push({ kind: 'CAN input', name: 'Engine RPM', value: '850', on: true, enabled: true })
    await r.fulfill({ response: real, json: list })
  })
  // the Ranchero's ECU (DBC) has an engine speed of its own and comes first: hide it, so the CAN input is the source
  for (const e of (await devs()).filter((x) => /dbc/i.test(x.type))) {
    await page.route(`**/api/devices/${e.guid}/signals`, async (r) => {
      const real = await r.fetch()
      await r.fulfill({ response: real, json: (await real.json()).filter((s) => !/rpm|engine.?speed/i.test(s.name)) })
    })
  }
  await open(page, 'car')
  const card = page.locator('.stat', { hasText: 'Engine' })
  await expect(card).toContainText('850', { timeout: 15_000 })
  await expect(card).toContainText('from PDM-04')
  await open(page, 'live')
  await expect(page.getByRole('region', { name: 'Car', exact: true }).getByText('Engine', { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('region', { name: 'Car', exact: true })).toContainText('850')
  expect(errors).toEqual([])
})
