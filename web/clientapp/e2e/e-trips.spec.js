// Trips: list across modules, detail with the waveform, reasons and fixes, Clear trip log (PDM-05 only).
// The Sim has no trips to show, so GET /overloads is answered with fixed events (a mock of the READ only).
// Clear trip log is sent to the real module PDM-05.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson } from './api.js'
import { mockTrips, waveform, devs } from './e-util.js'

const steadyEvent = (output) => ({ output, state: 'Overcurrent', peakA: 23, limitA: 15, samples: waveform(23, 17) })

async function target(page) {
  const d = await devs()
  const p1 = d.find((x) => x.name === 'PDM-01')
  const outs = p1.outputs.filter((o) => o.enabled !== false)
  return { d, p1, outs, p5: d.find((x) => x.name === 'PDM-05') }
}

test('with no trips logged the page says so and Read again asks every module', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/trips')
  await expect(page.getByText('No trips are logged on the modules')).toBeVisible()
  const reqs = []
  page.on('request', (r) => { if (/\/overloads$/.test(r.url()) && r.method() === 'GET') reqs.push(r.url()) })
  await page.getByRole('button', { name: 'Read trip logs again' }).click()
  const withLogs = (await devs()).filter((m) => m.connected && (m.outputs ?? []).length).length
  await expect.poll(() => reqs.length).toBeGreaterThanOrEqual(Math.max(1, withLogs - 1))
  await page.getByRole('link', { name: 'Back to the dashboard' }).click()
  await expect(page).toHaveURL(/#\/next\/live$/)
  expect(errors).toEqual([])
})

test('trips are listed per module and picking one shows its waveform, reason and fixes', async ({ page }) => {
  const errors = watchErrors(page)
  const { p1, outs } = await target(page)
  await mockTrips(page, p1.guid, [steadyEvent(outs[0].number), { ...steadyEvent(outs[1].number), state: 'Fault', peakA: 41, limitA: 15 }])
  await open(page, 'live/trips')
  const rows = page.getByTestId('trip-row')
  await expect(rows).toHaveCount(2)
  await expect(page.getByText('PDM-01').first()).toBeVisible()
  await expect(page.getByText(/do not record when a trip happened/)).toBeVisible()
  // detail of the newest (last in the log)
  await expect(page.getByTestId('trip-title')).toContainText('faulted: 41.0 A')
  const chart = page.getByRole('img', { name: /Current around the trip: peak 41\.0 A/ })
  await expect(chart).toBeVisible()
  // picking the other trip
  await rows.nth(1).click()
  await expect(page.getByTestId('trip-title')).toContainText('tripped: 23.0 A')
  await expect(page).toHaveURL(new RegExp(`#/next/live/trips/${p1.guid}/0`))
  await expect(page.getByText(/Overcurrent .* after turn-on: 23\.0 A peak/)).toBeVisible()
  // reason and fixes in plain words
  await expect(page.getByText('MOST LIKELY')).toBeVisible()
  await expect(page.getByText('THEN')).toBeVisible()
  expect(errors).toEqual([])
})

test('zoom switches between the whole recording and the moment of the trip', async ({ page }) => {
  const errors = watchErrors(page)
  const { p1, outs } = await target(page)
  await mockTrips(page, p1.guid, [steadyEvent(outs[0].number)])
  await open(page, 'live/trips')
  await expect(page.getByRole('radio', { name: 'Whole recording' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('−10 s', { exact: true })).toBeVisible()
  await expect(page.getByText('+3 s', { exact: true })).toBeVisible()
  await expect(page.getByText('trip', { exact: true }).first()).toBeVisible()
  await page.getByRole('radio', { name: 'Zoom on the trip' }).click()
  await expect(page.getByRole('radio', { name: 'Zoom on the trip' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('+0.6 s', { exact: true })).toBeVisible()
  await expect(page.getByText('−10 s', { exact: true })).toHaveCount(0)
  await expect(page.getByText('switched on')).toBeVisible()
  expect(errors).toEqual([])
})

test('the fix buttons open the output page', async ({ page }) => {
  const errors = watchErrors(page)
  const { p1, outs } = await target(page)
  await mockTrips(page, p1.guid, [steadyEvent(outs[0].number)])
  await open(page, 'live/trips')
  const fixes = page.getByRole('region', { name: 'What to do' })
  const links = fixes.getByRole('link')
  expect(await links.count()).toBeGreaterThanOrEqual(2)
  for (const l of await links.all()) await expect(l).toHaveAttribute('href', new RegExp(`#/next/hardware/module/${p1.guid}/output/${outs[0].number}$`))
  await links.first().click()
  await expect(page).toHaveURL(new RegExp(`#/next/hardware/module/${p1.guid}/output/${outs[0].number}`))
  expect(errors).toEqual([])
})

test('a deep link opens the chosen trip', async ({ page }) => {
  const errors = watchErrors(page)
  const { p1, outs } = await target(page)
  await mockTrips(page, p1.guid, [steadyEvent(outs[0].number), { ...steadyEvent(outs[1].number), peakA: 31 }])
  await open(page, `live/trips/${p1.guid}/0`)
  await expect(page.getByTestId('trip-title')).toContainText('23.0 A')
  await open(page, `live/trips/${p1.guid}/1`)
  await expect(page.getByTestId('trip-title')).toContainText('31.0 A')
  expect(errors).toEqual([])
})

test('a module that cannot be read is reported', async ({ page }) => {
  const errors = watchErrors(page)
  const { d } = await target(page)
  for (const m of d.filter((x) => x.type === 'dingoPDM')) await page.route(`**/api/devices/${m.guid}/overloads`, (r) => r.fulfill({ status: 400, body: 'Module is not responding' }))
  await open(page, 'live/trips')
  await expect(page.getByText(/Could not read the trip log of PDM-0\d\./).first()).toBeVisible()
  expect(errors.filter((e) => !/400/.test(e))).toEqual([])
})

test('Clear trip log asks first, Cancel changes nothing, Clear empties PDM-05 on the module', async ({ page }) => {
  const errors = watchErrors(page)
  const { p5 } = await target(page)
  test.skip(!p5.connected, 'PDM-05 is not answering right now')
  let events = [steadyEvent(p5.outputs.find((o) => o.enabled !== false).number)]
  await mockTrips(page, p5.guid, () => events)
  const posts = []
  await page.route(`**/api/devices/${p5.guid}/overloads/clear`, async (r) => {
    posts.push(r.request().url())
    const real = await r.fetch()   // the real module is cleared
    if (real.ok()) events = []
    await r.fulfill({ response: real })
  })
  await open(page, 'live/trips')
  await expect(page.getByTestId('trip-row')).toHaveCount(1)
  await page.getByRole('button', { name: 'Clear trip log on PDM-05' }).click()
  const dlg = page.getByRole('dialog')
  await expect(dlg).toContainText('Clearing it cannot be undone')
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(dlg).toHaveCount(0)
  expect(posts).toHaveLength(0)
  await expect(page.getByTestId('trip-row')).toHaveCount(1)
  await page.getByRole('button', { name: 'Clear trip log on PDM-05' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Clear trip log' }).click()
  await expect.poll(() => posts.length).toBe(1)
  await expect(page.getByText('No trips are logged on the modules')).toBeVisible()
  // the module's own log is empty
  const real = await apiJson('GET', `/api/devices/${p5.guid}/overloads`)
  expect(real.events).toEqual([])
  expect(errors).toEqual([])
})

test('not connected shows a warning', async ({ page }) => {
  const { inject } = await import('./e-util.js')
  await open(page, 'live/trips')
  await inject(page, { top: { connected: false } })
  await expect(page.getByText('Not connected to the car.')).toBeVisible()
})
