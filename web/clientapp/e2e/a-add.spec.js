// Add module dialog: Find on CAN, From USB, By hand.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, devices, waitFor } from './api.js'
import { hex3, forceRestoreProject } from './a-util.js'

const dlg = (page) => page.getByRole('dialog', { name: 'Add module' })

async function openAdd(page, tab) {
  await page.getByTestId('add-module').click()
  await expect(dlg(page)).toBeVisible()
  if (tab) await dlg(page).getByRole('tab', { name: tab }).click()
}

test('Find on CAN lists what answers and marks modules already in the project', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await page.getByTestId('find-modules').click()
  const d = dlg(page)
  await expect(d.getByText(/Scan finished/)).toBeVisible({ timeout: 25_000 })
  const devs = await devices()
  const table = d.getByRole('table', { name: 'Modules found' })
  if (await table.count()) {
    const rows = table.locator('tbody tr')
    const n = await rows.count()
    expect(n).toBeGreaterThan(0)
    let fresh = 0
    for (let i = 0; i < n; i++) {
      const cells = await rows.nth(i).locator('td').allInnerTexts()
      const base = parseInt(cells[2].trim(), 16)
      const known = devs.find((x) => x.baseId === base)
      if (known) expect(cells[4]).toContain('In project as ' + known.name)
      else { fresh++; expect(cells[4]).toContain('New: not in the project') }
      // the scan reads the firmware from the Version reply (G8); a known module's matches its telemetry
      expect(cells[3].trim()).toMatch(/^\d+\.\d+\.\d+$/)
      if (known?.version) expect(cells[3].trim()).toBe(known.version.replace(/^v/, ''))
    }
    await expect(d.getByRole('checkbox')).toHaveCount(fresh)
    await expect(d.getByTestId('add-primary')).toBeDisabled()
  } else {
    // a busy bus can hide modules: then the dialog must say so and give the checklist
    await expect(d.getByText('No module answered in 10 s')).toBeVisible()
  }
  await d.getByTestId('scan-again').click()
  await expect(d.getByText(/Scan finished/)).toBeVisible({ timeout: 25_000 })
  expect(errors).toEqual([])
})

test('Find on CAN shows the flooded-bus warning exactly when the frame rate is high', async ({ page }) => {
  await open(page, 'hardware')
  await page.getByTestId('find-modules').click()
  await expect(dlg(page).getByText(/Scan finished/)).toBeVisible({ timeout: 25_000 })
  const rate = await page.evaluate(() => { let v = 0; window.__telemetry?.subscribe((x) => (v = x.canRate))(); return v })
  const banner = dlg(page).getByText(/The bus is flooded: about/)
  if (rate > 2000) await expect(banner).toBeVisible()
  else await expect(banner).toHaveCount(0)
})

test('By hand: every check is explained and Add stays off until it passes', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const bus = page.waitForResponse((r) => r.url().includes('/api/canlog'))
  await openAdd(page, 'By hand')
  await bus
  const d = dlg(page)
  const name = d.getByRole('textbox', { name: 'Name' })
  const base = d.getByRole('textbox', { name: 'Base CAN ID' })
  const add = d.getByTestId('add-primary')
  const devs = await devices()
  const pdm1 = devs.find((x) => x.name === 'PDM-01')

  // a fresh dialog starts valid: a free ID and the next default name
  await expect(add).toBeEnabled()
  await expect(d.getByText(/is free\. No other module or bus traffic uses it\./)).toBeVisible()
  // name checks
  await name.fill('')
  await expect(d.getByText('Give the module a name.')).toBeVisible()
  await expect(add).toBeDisabled()
  await name.fill('PDM-01')
  await expect(d.getByText('A module named PDM-01 is already in the project.')).toBeVisible()
  await name.fill('zz-e2e-new')
  // ID checks
  await base.fill('nope')
  await expect(d.getByText('Use a hex ID from 0x001 to 0x7FF, like 0x720.')).toBeVisible()
  await expect(add).toBeDisabled()
  await base.fill(hex3(pdm1.baseId))
  await expect(d.getByText(/overlaps PDM-01/)).toBeVisible()
  await expect(add).toBeDisabled()
  await base.fill('0x7E0')
  await expect(d.getByText(/is in the OBD-II range\. Turn the reserve off to use it\./)).toBeVisible()
  await d.getByRole('switch', { name: 'Keep the OBD-II range free' }).click()
  await expect(d.getByText(/is in the OBD-II range/)).toBeHidden()
  await d.getByRole('switch', { name: 'Keep the OBD-II range free' }).click()
  // free-ID suggestions fill the field
  const sugg = d.getByRole('button', { name: /^0x[0-9A-F]{3}$/ }).first()
  const t = await sugg.innerText()
  await sugg.click()
  await expect(base).toHaveValue(t)
  await expect(add).toBeEnabled()
  // board cards: CANBoard changes the default name and the span
  await name.fill('')
  await d.getByRole('radio', { name: /CANBoard/ }).check()
  await expect(d.getByRole('radio', { name: /CANBoard/ })).toBeChecked()
  await d.getByRole('radio', { name: /dingoPDM-Max/ }).check()
  await expect(d.getByRole('radio', { name: /dingoPDM-Max/ })).toBeChecked()
  // nothing was added
  expect((await devices()).length).toBe(devs.length)
  await d.getByRole('button', { name: 'Cancel' }).click()
  await expect(d).toHaveCount(0)
  expect(errors).toEqual([])
})

test('From USB looks at the module on USB and knows it is already in the project', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await openAdd(page, 'From USB')
  const d = dlg(page)
  await d.getByTestId('usb-look').click()
  const r = await apiJson('POST', '/api/usb/identify')
  if (r.gatewayBaseId == null) {
    await expect(d.getByText('No module answered on USB.')).toBeVisible({ timeout: 25_000 })
    await expect(d.getByTestId('add-primary')).toBeDisabled()
  } else {
    await expect(d.getByText(`base ID ${hex3(r.gatewayBaseId)}`)).toBeVisible({ timeout: 25_000 })
    const known = (await devices()).find((x) => x.baseId === r.gatewayBaseId)
    if (known) {
      await expect(d.getByText(`In project as ${known.name}`)).toBeVisible()
      await expect(d.getByText('This module is already in the project, so there is nothing to add.')).toBeVisible()
      await expect(d.getByTestId('add-primary')).toBeDisabled()
    } else {
      await expect(d.getByText('New: not in the project')).toBeVisible()
      await expect(d.getByRole('checkbox', { name: 'Read its settings into the project' })).toBeChecked()
    }
  }
  expect(errors).toEqual([])
})

test('Cancel, the close button and Escape close the dialog without adding', async ({ page }) => {
  await open(page, 'hardware')
  const n = (await devices()).length
  await openAdd(page)
  await dlg(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(dlg(page)).toHaveCount(0)
  await openAdd(page)
  await dlg(page).getByRole('button', { name: 'Close' }).click()
  await expect(dlg(page)).toHaveCount(0)
  await openAdd(page)
  await page.keyboard.press('Escape')
  await expect(dlg(page)).toHaveCount(0)
  expect((await devices()).length).toBe(n)
})

// ----- change the project: run alone -----------------------------------------------------------

test('By hand adds a module that shows as Not found, and Add like this copies a board kind @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const clean = async () => { for (const d of (await devices()).filter((x) => x.name.startsWith('zz-e2e-'))) await apiJson('POST', `/api/devices/${d.guid}/remove`) }
  try {
    const bus = page.waitForResponse((r) => r.url().includes("/api/canlog"))
    await openAdd(page, 'By hand')
    await bus
    const d = dlg(page)
    await d.getByRole('textbox', { name: 'Name' }).fill('zz-e2e-hand')
    const sugg = d.getByRole('button', { name: /^0x[0-9A-F]{3}$/ }).first()
    const base = await sugg.innerText()
    await sugg.click()
    await d.getByTestId('add-primary').click()
    await expect(dlg(page)).toHaveCount(0)
    const made = (await devices()).find((x) => x.name === 'zz-e2e-hand')
    expect(made.baseId).toBe(parseInt(base, 16))
    expect(made.type).toBe('dingoPDM')
    expect(made.connected).toBe(false)
    await expect(page.getByTestId('project-chip')).toContainText('unsaved')
    // Add one like this (PDM-02)
    await page.getByTestId('row-PDM-02').locator('td').first().click()
    await page.getByRole('complementary', { name: 'Module settings' }).getByTestId('add-like').click()
    const d2 = dlg(page)
    await d2.getByRole('textbox', { name: 'Name' }).fill('zz-e2e-like')
    await d2.getByTestId('add-primary').click()
    await expect(dlg(page)).toHaveCount(0)
    const like = await waitFor(async () => (await devices()).find((x) => x.name === 'zz-e2e-like'), 10_000, 'copy exists')
    expect(like.type).toBe('dingoPDM')
    expect(like.baseId).not.toBe(made.baseId)
  } finally { await clean() }
  expect(errors).toEqual([])
})

test('Find on CAN adds a module that answers but is not in the project @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  // take one real module out of the project, add it back through the scan, then put the fixture project back
  const victim = (await devices()).find((x) => x.name === 'PDM-05')
  try {
    await apiJson('POST', '/api/devices/' + victim.guid + '/remove')
    await page.getByTestId('find-modules').click()
    const d = dlg(page)
    await expect(d.getByText(/Scan finished/)).toBeVisible({ timeout: 25_000 })
    await expect(d.getByText('New: not in the project')).toBeVisible()
    await d.getByTestId('add-primary').click()
    await waitFor(async () => (await devices()).some((x) => x.baseId === victim.baseId), 10_000, 'module added from the scan')
    expect((await devices()).find((x) => x.baseId === victim.baseId).name).toMatch(/^PDM-\d+$/)
  } finally { await forceRestoreProject() }
  expect(errors).toEqual([])
})
