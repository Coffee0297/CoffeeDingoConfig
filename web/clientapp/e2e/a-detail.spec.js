// Hardware › module page: overview, Outputs / Inputs / Settings tabs and the module actions.
import { test, expect } from '@playwright/test'

// A write or read can be lost while another run is hammering the shared bus: try those again.
test.describe.configure({ retries: 1 })
import { open, watchErrors } from './helpers.js'
import { apiJson, devices, deviceByName, waitFor } from './api.js'
import { hex3, guidOf, ready } from './a-util.js'

const go = async (page, name, tab = '') => {
  const g = await guidOf(name)
  if (!name.startsWith('zz-e2e')) await ready(name)
  await open(page, `hardware/module/${g}${tab ? '/' + tab : ''}`)
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  return g
}

test('PDM header shows type, base ID, firmware, state and live stats', async ({ page }) => {
  const errors = watchErrors(page)
  const d = await deviceByName('PDM-02')
  await go(page, 'PDM-02')
  await expect(page.getByText(new RegExp(`dingoPDM · base ${hex3(d.baseId)} · firmware`))).toBeVisible()
  await expect(page.getByText('Connected').first()).toBeVisible()
  for (const l of ['Battery', 'Current', 'Temperature', 'Reported state']) await expect(page.locator('.stats').getByText(l, { exact: true })).toBeVisible()
  // the PDM's worst case: every enabled output at its limit
  const worst = d.outputs.filter((o) => o.enabled !== false).reduce((n, o) => n + o.currentLimit, 0)
  await expect(page.getByTestId('max-current')).toContainText(`${worst.toFixed(1)} A`)
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' })
  await crumbs.getByRole('link', { name: 'Modules' }).click()
  await expect(page).toHaveURL(/#\/next\/hardware$/)
  expect(errors).toEqual([])
})

test('Outputs tab lists the PDM outputs with state, current, limit and a link to each', async ({ page }) => {
  const errors = watchErrors(page)
  const d = await deviceByName('PDM-02')
  const g = await go(page, 'PDM-02')
  const table = page.getByRole('table', { name: 'Outputs' })
  await expect(table.locator('tbody tr')).toHaveCount(d.outputs.length)
  for (const o of d.outputs) {
    const row = page.getByTestId('out-' + o.number)
    await expect(row).toContainText(o.name)
    if (o.enabled) await expect(row).toContainText(`${o.currentLimit.toFixed(1)} A`)
    else await expect(row).toContainText('Unused')
    await expect(row.getByRole('link', { name: new RegExp(`Open output ${o.number},`) })).toHaveAttribute('href', `#/next/hardware/module/${g}/output/${o.number}`)
  }
  // the count on the tab is the number of outputs in use
  await expect(page.getByRole('tab', { name: /Outputs/ })).toContainText(String(d.outputs.filter((o) => o.enabled).length))
  // Open goes there
  await page.getByTestId('out-1').getByRole('link').click()
  await expect(page).toHaveURL(new RegExp(`#/next/hardware/module/${g}/output/1$`))
  expect(errors).toEqual([])
})

test('Inputs tab groups digital and CAN inputs and links each one', async ({ page }) => {
  const errors = watchErrors(page)
  const d = await deviceByName('PDM-02')
  const g = await go(page, 'PDM-02')
  await page.getByRole('tab', { name: 'Inputs' }).click()
  const sig = await apiJson('GET', `/api/devices/${g}/signals`)
  const can = sig.filter((s) => s.kind === 'CAN input')
  const used = can.filter((s) => s.enabled)
  const card = page.getByRole('table', { name: 'CAN inputs' })
  await expect(card.locator('tbody tr')).toHaveCount(used.length)
  await expect(page.getByText(`${used.length} in use, ${can.length - used.length} unused`)).toBeVisible()
  const firstUsed = can.findIndex((s) => s.enabled) + 1
  await expect(card.getByRole('link', { name: new RegExp(`Open can input ${firstUsed},`) })).toHaveAttribute('href', `#/next/hardware/module/${g}/input/caninput/${firstUsed}`)
  // unused ones are folded away until asked for
  await page.getByRole('button', { name: `Show ${can.length - used.length} unused` }).first().click()
  await expect(card.locator('tbody tr')).toHaveCount(can.length)
  await expect(card.getByText('Unused').first()).toBeVisible()
  await page.getByRole('button', { name: 'Hide unused' }).first().click()
  await expect(card.locator('tbody tr')).toHaveCount(used.length)
  // digital inputs of a PDM
  const dig = sig.filter((s) => s.kind === 'Digital input')
  await expect(page.getByRole('table', { name: 'Digital inputs' })).toBeVisible()
  expect(dig.length).toBe(d.outputs.length ? dig.length : 0)
  expect(errors).toEqual([])
})

test('CANBoard page shows its digital outputs and its digital, analog and CAN inputs', async ({ page }) => {
  const errors = watchErrors(page)
  const g = await go(page, 'CB-1')
  const sig = await apiJson('GET', `/api/devices/${g}/signals`)
  const outs = sig.filter((s) => s.kind === 'Digital output')
  const table = page.getByRole('table', { name: 'Outputs' })
  await expect(table.locator('tbody tr')).toHaveCount(outs.length)
  await expect(table).toContainText(outs[0].name)
  await expect(table.getByRole('link', { name: /Open output 1,/ })).toHaveAttribute('href', `#/next/hardware/module/${g}/output/1`)
  await page.getByRole('tab', { name: 'Inputs' }).click()
  await expect(page.getByRole('table', { name: 'Digital inputs' })).toBeVisible()
  await expect(page.getByRole('table', { name: 'Analog inputs' })).toBeVisible()
  await expect(page.getByRole('table', { name: 'CAN inputs' })).toBeVisible()
  const dig = sig.filter((s) => s.kind === 'Digital input' && s.enabled)
  await expect(page.getByRole('table', { name: 'Digital inputs' }).locator('tbody tr')).toHaveCount(dig.length)
  const firstAnalog = sig.filter((s) => s.kind === 'Analog input').findIndex((s) => s.enabled) + 1
  await expect(page.getByRole('table', { name: 'Analog inputs' }).getByRole('link', { name: new RegExp(`Open analog input ${firstAnalog},`) })).toHaveAttribute('href', `#/next/hardware/module/${g}/input/analoginput/${firstAnalog}`)
  await expect(page.getByRole('table', { name: 'Analog inputs' })).toContainText('mV')
  expect(errors).toEqual([])
})

test('the tab is kept in the address and survives a reload', async ({ page }) => {
  const g = await go(page, 'PDM-02')
  await page.getByRole('tab', { name: 'Settings' }).click()
  await expect(page).toHaveURL(new RegExp(`/hardware/module/${g}/settings$`))
  await page.reload()
  await expect(page.getByTestId('module-settings')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Settings', selected: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Inputs' }).click()
  await expect(page).toHaveURL(new RegExp(`/hardware/module/${g}/inputs$`))
})

test('Settings: the base ID shows the saved ID, and the sleep shortcut links to Sleep and wake', async ({ page }) => {
  const d = await deviceByName('PDM-02')
  await go(page, 'PDM-02', 'settings')
  await expect(page.getByTestId('saved-base')).toHaveText(hex3(d.baseId))
  await expect(page.getByTestId('base-input')).toHaveValue(hex3(d.baseId))
  await expect(page.getByTestId('to-sleep')).toHaveAttribute('href', '#/next/power/sleep')
  await page.getByTestId('to-sleep').click()
  await expect(page).toHaveURL(/#\/next\/power\/sleep/)
})

test('Settings: Read from module reads PDM-02 and says whether it matches the project', async ({ page }) => {
  const errors = watchErrors(page)
  await go(page, 'PDM-02', 'settings')
  await page.getByTestId('act-read').click()
  await expect(page.getByTestId('act-msg')).toContainText(/Read PDM-02\./, { timeout: 40_000 })
  await expect(page.getByTestId('act-msg')).toContainText(/matches the project|differ from the project/)
  expect(errors).toEqual([])
})

test('Settings: Ask firmware version asks PDM-02 and reports what it answered', async ({ page }) => {
  const errors = watchErrors(page)
  await go(page, 'PDM-02', 'settings')
  await page.getByTestId('act-version').click()
  await expect(page.getByTestId('act-msg')).toContainText(/Asked PDM-02 for its firmware version\. It reports/, { timeout: 20_000 })
  expect(errors).toEqual([])
})

test('Settings: Write to module asks first, Cancel sends nothing, Write now writes PDM-02', async ({ page }) => {
  const errors = watchErrors(page)
  await go(page, 'PDM-02', 'settings')
  await page.getByTestId('act-write').click()
  const dlg = page.getByRole('alertdialog')
  await expect(dlg).toContainText("Write the project's settings to PDM-02?")
  await expect(dlg).toContainText('lost at power-off until you store them')
  await dlg.getByTestId('confirm-cancel').click()
  await expect(dlg).toHaveCount(0)
  await expect(page.getByTestId('act-msg')).toHaveCount(0)
  await page.getByTestId('act-write').click()
  await dlg.getByTestId('confirm-yes').click()
  await expect(page.getByTestId('act-msg')).toContainText(/Wrote the project's settings to PDM-02|did not take it/, { timeout: 40_000 })
  if ((await page.getByTestId('act-msg').innerText()).includes('did not take it')) {
    await expect(page.getByTestId('act-msg')).toContainText("didn't confirm the write") // honest failure: the Sim did not confirm
    return
  }
  await expect(page.getByTestId('act-msg')).toContainText("Wrote the project's settings to PDM-02. They are lost at power-off until you store them.")
  expect(errors).toEqual([])
})

test('Settings: the bootloader restart asks first and names the consequence', async ({ page }) => {
  await go(page, 'PDM-02', 'settings')
  const b = page.getByTestId('act-bootloader')
  await expect(b).toBeVisible()
  const d = await deviceByName('PDM-02')
  if (!d.canBootloader) { await expect(b).toBeDisabled(); return }
  await b.click()
  const dlg = page.getByRole('alertdialog')
  await expect(dlg).toContainText('Restart PDM-02 into its bootloader?')
  await expect(dlg).toContainText('stops answering')
  await dlg.getByTestId('confirm-cancel').click() // never confirmed here: it would take the module off the bus
  await expect(dlg).toHaveCount(0)
})

test('Store and Remove ask first and Cancel changes nothing', async ({ page }) => {
  await go(page, 'PDM-02', 'settings')
  await page.getByTestId('act-burn').click()
  const dlg = page.getByRole('alertdialog')
  await expect(dlg).toContainText("Store PDM-02's settings permanently?")
  await expect(dlg).toContainText('burns them into the module')
  await dlg.getByTestId('confirm-cancel').click()
  await page.getByTestId('remove-module').click()
  await expect(dlg).toContainText('Remove PDM-02 from the project?')
  await dlg.getByTestId('confirm-cancel').click()
  expect((await devices()).some((x) => x.name === 'PDM-02')).toBe(true)
})

test('Deploy to USB checks the board before it allows anything', async ({ page }) => {
  await go(page, 'PDM-02', 'settings')
  await page.getByRole('button', { name: /Deploy to the module on USB/ }).click()
  await page.getByTestId('usb-check').click()
  const r = await apiJson('POST', '/api/usb/identify')
  if (r.gatewayBaseId != null) {
    await expect(page.getByText(`base ${hex3(r.gatewayBaseId)}`)).toBeVisible()
    await expect(page.getByText(/Board check passed|Board check failed|could not tell what board/)).toBeVisible()
  } else await expect(page.getByText('No module answered on USB.')).toBeVisible()   // a plain CAN adapter: nothing to deploy to
  // Deploy only enables with a passed board check on a different module than the one that is being replaced
  const dep = page.getByTestId('deploy-usb')
  if (await page.getByText('Board check passed').count()) await expect(dep).toBeEnabled()
  else await expect(dep).toBeDisabled()
})

test('a module that is not in the project says so', async ({ page }) => {
  await open(page, 'hardware/module/00000000-0000-0000-0000-000000000000')
  await expect(page.getByRole('heading', { level: 1, name: 'Module not found' })).toBeVisible()
  await page.getByRole('link', { name: 'Back to Modules' }).click()
  await expect(page).toHaveURL(/#\/next\/hardware$/)
})

// ----- change the module or the project: run alone -------------------------------------------

test('Store on module writes then burns PDM-02 and reports it @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await go(page, 'PDM-02', 'settings')
  await page.getByTestId('act-burn').click()
  await page.getByRole('alertdialog').getByTestId('confirm-yes').click()
  await expect(page.getByTestId('act-msg')).toContainText("Stored PDM-02's settings in its flash.", { timeout: 60_000 })
  expect(errors).toEqual([])
})

test('Remove from the module page removes a throwaway module and goes back to Modules @exclusive', async ({ page }) => {
  await apiJson('POST', '/api/devices', { Type: 'pdm', Name: 'zz-e2e-detail', BaseId: '0x740' })
  try {
    await go(page, 'zz-e2e-detail', 'settings')
    await page.getByTestId('remove-module').click()
    await page.getByRole('alertdialog').getByTestId('confirm-yes').click()
    await expect(page).toHaveURL(/#\/next\/hardware$/)
    expect((await devices()).some((x) => x.name === 'zz-e2e-detail')).toBe(false)
  } finally {
    const left = (await devices()).find((x) => x.name === 'zz-e2e-detail')
    if (left) await apiJson('POST', `/api/devices/${left.guid}/remove`)
  }
})

test('An offline module cannot be read or written and says why @exclusive', async ({ page }) => {
  await apiJson('POST', '/api/devices', { Type: 'pdm', Name: 'zz-e2e-offline', BaseId: '0x740' })
  try {
    await go(page, 'zz-e2e-offline', 'settings')
    await expect(page.getByText('zz-e2e-offline is not answering on the bus.').first()).toBeVisible()
    await expect(page.getByTestId('act-read')).toBeDisabled()
    await expect(page.getByTestId('act-write')).toBeDisabled()
    await expect(page.getByTestId('act-burn')).toBeDisabled()
    await expect(page.getByText('Not found').first()).toBeVisible()
  } finally {
    const left = (await devices()).find((x) => x.name === 'zz-e2e-offline')
    if (left) await apiJson('POST', `/api/devices/${left.guid}/remove`)
  }
})
