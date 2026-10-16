// Live dashboard: tiles, Show hidden, module filter, links, sparklines, view tabs, stale and tripped states.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson } from './api.js'
import { inject, devs } from './e-util.js'

const countText = (page) => page.getByTestId('live-count')
const nums = async (page) => {
  const t = await countText(page).innerText()
  const m = /Showing (\d+) enabled · (\d+) hidden/.exec(t)
  return { shown: Number(m[1]), hidden: Number(m[2]) }
}

test('dashboard shows car, output and signal tiles from live data', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live')
  const car = page.getByRole('region', { name: 'Car', exact: true })
  for (const n of ['Battery', 'Total current', 'Hottest module']) await expect(car.getByRole('link', { name: n, exact: true })).toBeVisible()
  await expect(car.getByText('Ignition', { exact: true })).toBeVisible()   // firmware 5.6: a real tile
  // one temperature tile per module that answers
  await expect.poll(async () => (await page.getByRole('region', { name: 'Modules', exact: true }).getByTestId('tile').count()) - (await devs()).filter((m) => m.connected).length).toBeLessThanOrEqual(1)
  await expect(page.getByRole('region', { name: 'Modules', exact: true }).getByTestId('tile').filter({ hasText: 'PDM-01' })).toContainText('°C')
  // the same enabled signals the API reports (non-output kinds) are on the dashboard
  const d = await devs()
  let enabled = 0
  for (const m of d) enabled += (await apiJson('GET', `/api/devices/${m.guid}/signals`)).filter((s) => s.enabled !== false && s.kind !== 'Output').length
  await expect(page.getByRole('region', { name: 'Switches and signals' }).getByTestId('tile')).toHaveCount(enabled, { timeout: 10_000 })
  // outputs that are on
  const on = d.filter((m) => m.connected).flatMap((m) => m.outputs).filter((o) => o.enabled !== false && (o.state === 'On' || o.current > 0.05)).length
  const shownOutputs = await page.getByRole('region', { name: 'Outputs' }).getByTestId('tile').count()
  expect(Math.abs(shownOutputs - on)).toBeLessThanOrEqual(2)
  // every tile has a sparkline (a line graph) once its history has two samples
  await expect.poll(() => page.getByRole('region', { name: 'Outputs' }).locator('[data-testid=tile] svg').count(), { timeout: 10_000 }).toBeGreaterThan(5)
  expect(errors).toEqual([])
})

test('Show hidden reveals the unused outputs and signals and the counts agree', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live')
  const before = await nums(page)
  expect(before.hidden).toBeGreaterThan(0)
  const tilesBefore = await page.getByTestId('tile').count()
  await page.getByRole('checkbox', { name: 'Show hidden' }).click()
  await expect.poll(async () => page.getByTestId('tile').count()).toBeGreaterThan(tilesBefore + before.hidden - 3)
  expect(await page.getByTestId('tile').count()).toBeLessThanOrEqual(tilesBefore + before.hidden + 3)
  await page.getByRole('checkbox', { name: 'Show hidden' }).click()
  await expect.poll(async () => page.getByTestId('tile').count()).toBeLessThan(tilesBefore + 5)
  expect(errors).toEqual([])
})

test('module filter narrows every tile to one module', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live')
  const all = await page.getByTestId('tile').count()
  await page.getByRole('button', { name: 'Module', exact: true }).click()
  await page.getByRole('option', { name: 'PDM-05' }).click()
  await expect.poll(() => page.getByTestId('tile').count()).toBeLessThan(all)
  const mods = await page.getByTestId('tile').locator('.mod').allInnerTexts()
  expect(mods.length).toBeGreaterThan(0)
  expect(new Set(mods.map((m) => m.trim()))).toEqual(new Set(['PDM-05']))
  await page.getByRole('button', { name: 'Module', exact: true }).click()
  await page.getByRole('option', { name: 'All modules' }).click()
  await expect.poll(async () => Math.abs((await page.getByTestId('tile').count()) - all)).toBeLessThanOrEqual(4)
  expect(errors).toEqual([])
})

test('an output tile opens its output and Graph it opens the Plot with that signal', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live')
  const tile = page.getByRole('region', { name: 'Outputs' }).getByTestId('tile').first()
  const name = (await tile.locator('.nm').innerText()).trim()
  await tile.getByRole('link', { name: /Graph/ }).click()
  await expect(page).toHaveURL(/#\/next\/live\/plot\?signal=out/)
  await expect(page.getByText('Opened from Graph it.')).toBeVisible()
  await expect(page.getByTestId('series-row').filter({ hasText: name })).toHaveCount(1)
  await page.goBack()
  await expect(page.getByRole('link', { name: name }).first()).toBeVisible()
  await page.getByRole('region', { name: 'Outputs' }).getByTestId('tile').first().locator('a.nm').click()
  await expect(page).toHaveURL(/#\/next\/hardware\/module\/[0-9a-f-]+\/output\/\d+/)
  expect(errors).toEqual([])
})

test('a signal tile links to its module and the view tabs open Plot, Trips and Logs', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live')
  const sig = page.getByRole('region', { name: 'Switches and signals' }).getByTestId('tile').first()
  await expect(sig.locator('a.nm')).toHaveAttribute('href', /#\/next\/hardware\/module\//)
  const tabs = page.getByRole('navigation', { name: 'Live views' })
  for (const [name, re] of [['Plot', /live\/plot/], ['Trips', /live\/trips/], ['Logs', /live\/logs/], ['Dashboard', /#\/next\/live$/]]) {
    await tabs.getByRole('link', { name }).click()
    await expect(page).toHaveURL(re)
    await expect(tabs.getByRole('link', { name })).toHaveAttribute('aria-current', 'page')
  }
  expect(errors).toEqual([])
})

test('a tripped output shows as a fault tile with its state in words', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'live')
  const m = (await devs()).find((x) => x.name === 'PDM-01')
  const o = m.outputs.find((x) => x.enabled !== false)
  await inject(page, { outputs: { [`PDM-01:${o.number}`]: { state: 'Overcurrent', current: 23 } } })
  const tile = page.getByTestId('tile').filter({ has: page.locator('.mod', { hasText: 'PDM-01' }) }).filter({ hasText: 'Overcurrent' })
  await expect(tile.first()).toBeVisible()
  await expect(tile.first()).toHaveAttribute('data-tone', 'fault')
  await expect(page.getByText('Live values are not updating.')).toBeVisible()
  expect(errors).toEqual([])
})

test('not connected shows a warning instead of stale numbers', async ({ page }) => {
  await open(page, 'live')
  await inject(page, { top: { connected: false } })
  await expect(page.getByText(/Live values are not updating|Not connected to the car/).first()).toBeVisible()
})

test('no modules shows an empty state', async ({ page }) => {
  await open(page, 'live')
  await inject(page, { empty: true })
  await expect(page.getByText('No modules in this project')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Connect to the car' })).toHaveAttribute('href', '#/next/connect')
})
