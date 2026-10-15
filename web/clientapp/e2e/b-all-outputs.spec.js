// Every output on the car (hardware/outputs). Read-only: no module is written.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { devices } from './api.js'
import { pickSelect } from './b-helpers.js'

test('lists every enabled output of every module and CANBoard output', async ({ page }) => {
  const errors = watchErrors(page)
  const devs = await devices()
  const pdmEnabled = devs.flatMap((d) => (d.outputs ?? []).filter((o) => o.enabled)).length
  await open(page, 'hardware/outputs')
  await expect(page.getByRole('heading', { level: 1, name: 'Every output on the car' })).toBeVisible()
  await expect(page.getByTestId('out-row').first()).toBeVisible()
  const total = await page.getByTestId('out-row').count()
  expect(total).toBeGreaterThanOrEqual(pdmEnabled)
  // every module is a group, first column names it once
  for (const d of devs.filter((x) => (x.outputs ?? []).some((o) => o.enabled))) await expect(page.getByRole('cell', { name: d.name, exact: true })).toHaveCount(1)
  // columns
  for (const h of ['Module', 'Out', 'Pin', 'Load', 'Limit', 'Driven by', 'Now']) await expect(page.getByRole('columnheader', { name: h, exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('module name appears in module order and states use words', async ({ page }) => {
  await open(page, 'hardware/outputs')
  const names = await page.locator('tr.first td:first-child').allTextContents()
  expect(names.length).toBeGreaterThan(3)
  expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
  await expect(page.getByTestId('outputs-table')).toContainText(/On|Off/)
})

test('show spare outputs adds rows and group by state / load name regroups', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware/outputs')
  const base = await page.getByTestId('out-row').count()
  await page.getByRole('checkbox', { name: /show spare outputs/i }).click()
  await expect.poll(() => page.getByTestId('out-row').count()).toBeGreaterThan(base)
  await pickSelect(page, 'Group by', 'State')
  await expect(page.locator('tr.grp th').first()).toContainText(/·/)
  await pickSelect(page, 'Group by', 'Load name')
  await expect(page.locator('tr.grp')).toHaveCount(0)
  const loads = (await page.locator('[data-testid=out-row] td:nth-child(4)').allTextContents()).map((s) => s.trim().toLowerCase())
  const named = loads.filter((s) => !/^spare/.test(s))
  expect(named).toEqual([...named].sort((a, b) => a.localeCompare(b)))
  await pickSelect(page, 'Group by', 'Module')
  await expect(page.getByTestId('outputs-table')).toBeVisible()
  expect(errors).toEqual([])
})

test('clicking a row or its link opens that output', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware/outputs')
  await expect(page.locator('tr[data-testid=out-row]', { hasText: 'low-side' }).first()).toBeVisible()
  const first = page.getByTestId('out-row').first()
  const name = (await first.getByTestId('out-link').innerText()).split('\n')[0].trim()
  await first.getByTestId('out-link').click()
  await expect(page).toHaveURL(/#\/next\/hardware\/module\/[^/]+\/output\/\d+$/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(name)
  await page.goBack()
  await expect(page.getByTestId('out-row').first()).toBeVisible()
  await page.getByTestId('out-row').nth(2).locator('td').nth(2).click()   // click the row itself
  await expect(page).toHaveURL(/#\/next\/hardware\/module\/[^/]+\/output\/\d+$/)
  expect(errors).toEqual([])
})

test('CANBoard outputs are listed and open', async ({ page }) => {
  await open(page, 'hardware/outputs')
  const cb = page.locator('tr[data-testid=out-row]', { hasText: 'low-side' }).first()
  await expect(cb).toBeVisible()
  await expect(cb).toContainText('DO')
  await cb.getByTestId('out-link').click()
  await expect(page).toHaveURL(/output\/\d+$/)
  await expect(page.getByText('cannot measure or limit current')).toBeVisible()
})

test('print wiring list opens a printable page with every shown row', async ({ page, context }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware/outputs')
  const rows = await page.getByTestId('out-row').count()
  const [popup] = await Promise.all([context.waitForEvent('page'), page.getByTestId('print').click()])
  await popup.waitForLoadState()
  await expect(popup.getByRole('heading', { name: 'Wiring list' })).toBeVisible()
  await expect(popup.locator('tbody tr')).toHaveCount(rows)
  await expect(popup.getByRole('columnheader', { name: 'Wire colour' })).toBeVisible()
  await popup.close()
  expect(errors).toEqual([])
})
