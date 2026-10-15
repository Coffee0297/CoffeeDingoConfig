// Plot: series, windows, pause/live, cursor, table, PNG export, ?signal= preselect, stopped module.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { inject, devs } from './e-util.js'

const rows = (page) => page.getByTestId('series-row')
const chart = (page) => page.getByRole('img', { name: /^Line graph of the last/ })
const fresh = async (page, path = 'live/plot') => {
  await open(page, path)
  // start every test from the two default series, whatever an earlier test left in memory
  await page.evaluate(() => {})
}

test('default series are drawn from live data and their values match the modules', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/plot')
  await expect(rows(page)).toHaveCount(2)
  await expect(chart(page)).toBeVisible({ timeout: 15_000 })
  const d = await devs()
  const total = d.filter((x) => x.type === 'dingoPDM' && x.connected).reduce((s, x) => s + x.current, 0)
  const v = parseFloat(await rows(page).filter({ hasText: 'Total current' }).locator('.val').innerText())
  expect(Math.abs(v - total)).toBeLessThan(10)
  const batt = Math.max(...d.filter((x) => x.type === 'dingoPDM' && x.connected).map((x) => x.battery))
  const bv = parseFloat(await rows(page).filter({ hasText: 'Battery voltage' }).locator('.val').innerText())
  expect(Math.abs(bv - batt)).toBeLessThan(0.7)
  expect(errors).toEqual([])
})

test('add a signal, hide it, show it, remove it', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/plot')
  await expect(rows(page)).toHaveCount(2)
  await page.getByLabel('Search signals').fill('Headlights')
  const add = page.getByRole('button', { name: /^Add Headlights from CB-1/ }).first()
  await expect(add).toBeVisible()
  await add.click()
  await expect(rows(page)).toHaveCount(3)
  const row = rows(page).filter({ hasText: 'Headlights' })
  await expect(row.locator('.val')).not.toHaveText('waiting…', { timeout: 10_000 })
  await row.getByRole('button', { name: /^Hide Headlights/ }).click()
  await expect(row.locator('.val')).toHaveText('hidden')
  await row.getByRole('button', { name: /^Show Headlights/ }).click()
  await expect(row.locator('.val')).not.toHaveText('hidden')
  await row.getByRole('button', { name: /^Remove Headlights/ }).click()
  await expect(rows(page)).toHaveCount(2)
  expect(errors).toEqual([])
})

test('a graph holds at most six signals', async ({ page }) => {
  await open(page, 'live/plot')
  await page.getByLabel('Search signals').fill('current')
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: /^Add / }).first().click()
  await expect(rows(page)).toHaveCount(6)
  await expect(page.getByText('Six signals is the most one graph can show clearly')).toBeVisible()
  for (const b of await page.locator('button.pick').all()) await expect(b).toBeDisabled()
  // leave the plot with its default series for the other tests
  for (let i = 0; i < 4; i++) await rows(page).last().getByRole('button', { name: /^Remove/ }).click()
  await expect(rows(page)).toHaveCount(2)
})

test('time window buttons change the window', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/plot')
  for (const name of ['10 s', '5 min', '1 min']) {
    await page.getByRole('radio', { name }).click()
    await expect(page.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true')
  }
  await page.getByRole('radio', { name: '10 s' }).click()
  await expect(chart(page)).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(11_000)
  await expect(page.getByText(/Showing the last 10 s/)).toBeVisible()
  await page.getByRole('radio', { name: '1 min' }).click()
  expect(errors).toEqual([])
})

test('pause freezes the graph and Live follows the car again', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/plot')
  await expect(chart(page)).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('pause').click()
  await expect(page.getByTestId('plot-status')).toContainText('Paused at')
  await expect(page.getByTestId('pause')).toHaveAttribute('aria-pressed', 'true')
  await expect(chart(page)).toHaveAttribute('aria-label', /paused/)
  const a = await chart(page).getAttribute('aria-label')
  await page.waitForTimeout(1500)
  expect(await chart(page).getAttribute('aria-label')).toBe(a)
  await page.getByTestId('pause').click()
  await expect(page.getByTestId('plot-status')).toHaveText('Live')
  await expect(chart(page)).toHaveAttribute('aria-label', /live/)
  expect(errors).toEqual([])
})

test('the cursor reads the values at a moment in time', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/plot')
  await expect(chart(page)).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(3000)
  await expect(page.getByTestId('cursor-time')).toContainText('At now')
  await page.getByLabel('Cursor').fill('40')
  await expect(page.getByTestId('cursor-time')).toContainText(/At −/)
  await expect(rows(page).first().locator('.val')).toContainText(/\d/)
  await page.getByLabel('Cursor').fill('100')
  await expect(page.getByTestId('cursor-time')).toContainText('At now')
  expect(errors).toEqual([])
})

test('Show as table lists 13 samples and goes back to the graph', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/plot')
  await expect(chart(page)).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Show as table' }).click()
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByRole('table').locator('tbody tr')).toHaveCount(13)
  await expect(page.getByText(/Same data as the graph, 13 samples/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show as graph' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Show as graph' }).click()
  await expect(chart(page)).toBeVisible()
  expect(errors).toEqual([])
})

test('Export PNG downloads a real PNG image', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live/plot')
  await expect(chart(page)).toBeVisible({ timeout: 15_000 })
  const dl = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export PNG' }).click()
  const file = await dl
  expect(file.suggestedFilename()).toBe('dingo-plot.png')
  const stream = await file.createReadStream()
  const chunks = []
  for await (const c of stream) chunks.push(c)
  const buf = Buffer.concat(chunks)
  expect(buf.length).toBeGreaterThan(5000)
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await expect(page.getByText('Saved dingo-plot.png')).toBeVisible()
  expect(errors).toEqual([])
})

test('?signal= preselects a signal from a module and shows where it came from', async ({ page }) => {
  const errors = watchErrors(page)
  const d = await devs()
  const cb = d.find((x) => x.name === 'CB-1')
  await open(page, `live/plot?signal=${encodeURIComponent(cb.guid + '|Headlights')}`)
  await expect(page.getByText('Opened from Graph it.')).toBeVisible()
  await expect(rows(page).filter({ hasText: 'Headlights' })).toHaveCount(1)
  await expect(rows(page).filter({ hasText: 'Headlights' }).locator('.val')).not.toHaveText('waiting…', { timeout: 10_000 })
  // clean up what this test added to the remembered series
  await rows(page).filter({ hasText: 'Headlights' }).getByRole('button', { name: /^Remove/ }).click()
  expect(errors).toEqual([])
})

test('a module that stops answering is called out and its line is dotted', async ({ page }) => {
  const errors = watchErrors(page)
  const d = await devs()
  const p1 = d.find((x) => x.name === 'PDM-01')
  const o = p1.outputs.find((x) => x.enabled !== false)
  await open(page, `live/plot?signal=${encodeURIComponent(`out:${p1.guid}:${o.number}`)}`)
  await expect(chart(page)).toBeVisible({ timeout: 15_000 })
  await inject(page, { devices: { 'PDM-01': { connected: false } } })
  await expect(page.getByText('PDM-01 stopped answering.')).toBeVisible()
  await expect(page.getByText('▲ module not answering')).toBeVisible()
  expect(errors).toEqual([])
})

test('Learn a switch is disabled and says why', async ({ page }) => {
  await open(page, 'live/plot')
  await expect(page.getByRole('button', { name: 'Learn a switch' })).toBeDisabled()
  await expect(page.getByText(/needs a CAN frame history from the backend/)).toBeVisible()
})

test('nothing to graph shows an empty state', async ({ page }) => {
  await open(page, 'live/plot')
  for (const b of await rows(page).getByRole('button', { name: /^Remove/ }).all().then((l) => l.reverse())) await b.click()
  await expect(page.getByText('No signals yet')).toBeVisible()
  // put the defaults back
  await page.getByLabel('Search signals').fill('Total current')
  await page.getByRole('button', { name: /^Add Total current/ }).click()
  await page.getByLabel('Search signals').fill('Battery voltage')
  await page.getByRole('button', { name: /^Add Battery voltage from highest PDM/ }).click()
  await expect(rows(page)).toHaveCount(2)
})
