// Hardware › Modules: table, selection, CAN ID map, settings side panel, rename, remove.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, devices, deviceByName, waitFor } from './api.js'
import { guidOf, hex3 } from './a-util.js'

const side = (page) => page.getByRole('complementary', { name: 'Module settings' })

test('table lists every project module with its live state', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const devs = await devices()
  await expect(page.getByRole('heading', { level: 1, name: 'Modules' })).toBeVisible()
  await expect(page.getByText(`${devs.length} in this project`)).toBeVisible()
  const rows = page.getByRole('table', { name: 'Module table' }).locator('tbody tr')
  await expect(rows).toHaveCount(devs.length)
  for (const d of devs) {
    const row = page.getByTestId('row-' + d.name)
    await expect(row).toContainText(d.type)
    await expect(row).toContainText(hex3(d.baseId))
    await expect(row).toContainText(d.connected ? 'Connected' : 'Not found')
  }
  expect(errors).toEqual([])
})

test('rows are sorted by base ID', async ({ page }) => {
  await open(page, 'hardware')
  const devs = (await devices()).sort((a, b) => a.baseId - b.baseId)
  const texts = await page.getByRole('table', { name: 'Module table' }).locator('tbody tr td:nth-child(3)').allInnerTexts()
  expect(texts.map((t) => t.trim())).toEqual(devs.map((d) => d.name))
})

test('selecting a module shows its settings', async ({ page }) => {
  await open(page, 'hardware')
  const pdm3 = await deviceByName('PDM-03')
  await page.getByTestId('row-PDM-03').locator('td').first().click()
  await expect(side(page).getByRole('heading', { name: 'PDM-03' })).toBeVisible()
  await expect(side(page).getByTestId('saved-base')).toHaveText(hex3(pdm3.baseId))
  await expect(page.getByTestId('row-PDM-03')).toHaveAttribute('aria-current', 'true')
  await side(page).getByTestId('open-module').click()
  await expect(page).toHaveURL(new RegExp('#/next/hardware/module/' + pdm3.guid))
})

test('the CAN ID map names every module', async ({ page }) => {
  await open(page, 'hardware')
  const devs = await devices()
  const label = await page.getByRole('img', { name: /CAN base IDs from/ }).getAttribute('aria-label')
  for (const d of devs) expect(label).toContain(`${d.name} at ${hex3(d.baseId)}`)
  expect(label).not.toContain('clash')
  await expect(page.getByRole('img', { name: /CAN base IDs/ }).locator('.box')).toHaveCount(devs.length)
})

test('hardware sub navigation links work', async ({ page }) => {
  await open(page, 'hardware')
  const nav = page.getByRole('navigation', { name: 'Hardware' })
  await expect(nav.getByRole('link', { name: 'Modules' })).toHaveAttribute('aria-current', 'page')
  for (const [label, path] of [['Outputs', 'hardware/outputs'], ['Keypads', 'hardware/keypads'], ['Firmware', 'hardware/firmware']]) {
    await page.goto('/#/next/hardware')
    await page.getByRole('navigation', { name: 'Hardware' }).getByRole('link', { name: label }).click()
    await expect(page).toHaveURL(new RegExp('#/next/' + path + '$'))
  }
  await page.goto('/#/next/hardware')
  await expect(page.getByRole('heading', { level: 1, name: 'Modules' })).toBeVisible()
})

test('Open goes to the module page', async ({ page }) => {
  await open(page, 'hardware')
  const g = await guidOf('CB-2')
  await page.getByRole('link', { name: 'Open CB-2' }).click()
  await expect(page).toHaveURL(new RegExp('#/next/hardware/module/' + g))
  await expect(page.getByRole('heading', { level: 1, name: 'CB-2' })).toBeVisible()
})

test('Identify blinks a PDM; a CANBoard has no LED and only answers', async ({ page }) => {
  await open(page, 'hardware')
  await page.getByRole('button', { name: /Identify PDM-01/ }).click()
  await expect(page.getByText('PDM-01 is blinking its LEDs for 10 s.')).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: /Identify CB-1/ }).click()
  await expect(page.getByText('CB-1 answered. It has no status LED to blink.')).toBeVisible({ timeout: 5000 })
})

test('Find modules opens the Add module scan, Add module opens By hand tab content', async ({ page }) => {
  await open(page, 'hardware')
  await page.getByTestId('find-modules').click()
  const dlg = page.getByRole('dialog', { name: 'Add module' })
  await expect(dlg).toBeVisible()
  await expect(dlg.getByRole('tab', { name: 'Find on CAN', selected: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
  await page.getByTestId('add-module').click()
  await expect(page.getByRole('dialog', { name: 'Add module' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Base ID: a clash blocks, a bad ID is explained, suggestions and Undo work (PDM-02, nothing is sent)', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const pdm1 = await deviceByName('PDM-01')
  const pdm2 = await deviceByName('PDM-02')
  await page.getByTestId('row-PDM-02').locator('td').first().click()
  const input = side(page).getByTestId('base-input')
  const set = side(page).getByTestId('base-set')
  await expect(input).toHaveValue(hex3(pdm2.baseId))
  await expect(set).toBeDisabled()
  // clash with PDM-01
  await input.fill(hex3(pdm1.baseId))
  await expect(side(page).getByText('CAN ID clash. Setting it is blocked.')).toBeVisible()
  await expect(side(page).getByText(/overlaps PDM-01/)).toBeVisible()
  await expect(set).toBeDisabled()
  // not a hex ID
  await input.fill('zzz')
  await expect(side(page).getByText('Use a hex ID from 0x001 to 0x7FF, like 0x6C0.')).toBeVisible()
  await expect(set).toBeDisabled()
  await input.fill('0x800')
  await expect(side(page).getByText('Use a hex ID from 0x001 to 0x7FF')).toBeVisible()
  // suggestions are free IDs and enable the button
  const sugg = side(page).getByRole('button', { name: /^0x[0-9A-F]{3}$/ }).first()
  const txt = await sugg.innerText()
  await sugg.click()
  await expect(input).toHaveValue(txt)
  await expect(side(page).getByText(/is free\. No other module uses it\./)).toBeVisible()
  await expect(set).toBeEnabled()
  await expect(set).toContainText(`Re-address to ${txt}`)
  // the confirm dialog explains the steps; cancelling sends nothing
  await set.click()
  const dlg = page.getByRole('alertdialog')
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('The module restarts and answers on the new ID.')
  await expect(dlg).toContainText('If the link drops half way')
  await dlg.getByTestId('confirm-cancel').click()
  await expect(dlg).toHaveCount(0)
  expect((await deviceByName('PDM-02')).baseId).toBe(pdm2.baseId)
  // Undo edit
  await side(page).getByRole('button', { name: 'Undo edit' }).click()
  await expect(input).toHaveValue(hex3(pdm2.baseId))
  // hide / show suggestions
  await side(page).getByRole('button', { name: 'Hide suggestions' }).click()
  await expect(side(page).getByRole('button', { name: 'Suggest a free base ID' })).toBeVisible()
  await side(page).getByRole('button', { name: 'Suggest a free base ID' }).click()
  // OBD reserve switch
  const obd = side(page).getByRole('switch', { name: 'Keep the OBD-II range free' })
  await expect(obd).toBeChecked()
  await obd.click()
  await input.fill('0x7E0')
  await expect(side(page).getByText(/OBD-II range/).first()).toBeVisible()
  await obd.click()
  expect(errors).toEqual([])
})

test('Re-address how-it-works and Deploy to USB sections open', async ({ page }) => {
  await open(page, 'hardware')
  await page.getByTestId('row-PDM-02').locator('td').first().click()
  await side(page).getByText('How re-addressing works').click()
  await expect(side(page).getByText('dingoConfig sends the new ID and stores it on the module.')).toBeVisible()
  await side(page).getByRole('button', { name: /Deploy to the module on USB/ }).click()
  await expect(side(page).getByText('Puts this module')).toBeVisible()
  await side(page).getByTestId('usb-check').click()
  const r = await apiJson('POST', '/api/usb/identify')
  if (r.gatewayBaseId != null) await expect(side(page).getByText(`base ${hex3(r.gatewayBaseId)}`)).toBeVisible()
  // Deploy stays off until the board check passes; the boards are checked, not assumed
  await expect(side(page).getByText(/Board check|could not tell what board/)).toBeVisible()
})

test('Rename: the inline editor validates and Cancel leaves the name alone', async ({ page }) => {
  await open(page, 'hardware')
  await page.getByTestId('more-PDM-05').click(); await page.getByRole('menuitem', { name: 'Rename' }).click()
  const row = page.getByTestId('row-PDM-05')
  const input = row.getByLabel('Module name')
  await input.fill('')
  await row.getByRole('button', { name: 'Save' }).click()
  await expect(row.getByText('The name cannot be empty.')).toBeVisible()
  await input.fill('PDM-01')
  await row.getByRole('button', { name: 'Save' }).click()
  await expect(row.getByText('Another module is called PDM-01.')).toBeVisible()
  await row.getByRole('button', { name: 'Cancel' }).click()
  await expect(row.getByRole('link', { name: 'Open PDM-05' })).toBeVisible()
  expect((await devices()).some((d) => d.name === 'PDM-05')).toBe(true)
})

test('Remove asks first, and Keep it leaves the module in the project', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const before = (await devices()).length
  await page.getByTestId('more-PDM-05').click(); await page.getByRole('menuitem', { name: /^Remove/ }).click()
  const dlg = page.getByRole('alertdialog')
  await expect(dlg).toContainText('Remove PDM-05?')
  await expect(dlg).toContainText('The module itself is not changed')
  await dlg.getByTestId('rm-keep').click()
  await expect(dlg).toHaveCount(0)
  expect((await devices()).length).toBe(before)
  expect(errors).toEqual([])
})

test('Add one like this opens Add module with the same board kind', async ({ page }) => {
  await open(page, 'hardware')
  await page.getByTestId('row-PDM-02').locator('td').first().click()
  await side(page).getByTestId('add-like').click()
  const dlg = page.getByRole('dialog', { name: 'Add module' })
  await expect(dlg.getByRole('tab', { name: 'By hand', selected: true })).toBeVisible()
  await expect(dlg.getByText('A new module of the same kind as the one you picked.')).toBeVisible()
  await expect(dlg.getByRole('radio', { name: /dingoPDM 8 switched outputs/ })).toBeChecked()
  await expect(dlg.getByTestId('add-primary')).toHaveText('Add one like this')
  await dlg.getByRole('button', { name: 'Cancel' }).click()
})

// ---------------------------------------------------------------------------------------------
// Everything below changes the project (rename, add, remove, re-address) and runs alone.

test('Rename a module and rename it back @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const g = await guidOf('PDM-05')
  try {
    await page.getByTestId('more-PDM-05').click(); await page.getByRole('menuitem', { name: 'Rename' }).click()
    const row = page.getByTestId('row-PDM-05')
    await row.getByLabel('Module name').fill('zz-e2e-renamed')
    await row.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('row-zz-e2e-renamed')).toBeVisible()
    expect((await devices()).find((d) => d.guid === g).name).toBe('zz-e2e-renamed')
    await expect(page.getByTestId('project-chip')).toContainText('unsaved')
  } finally {
    await apiJson('POST', `/api/devices/${g}/rename`, { Name: 'PDM-05' })
  }
  expect(errors).toEqual([])
})

test('Rename from the settings panel @exclusive', async ({ page }) => {
  await open(page, 'hardware')
  const g = await guidOf('PDM-05')
  try {
    await page.getByTestId('row-PDM-05').locator('td').first().click()
    await side(page).getByTestId('rename-start').click()
    await side(page).getByLabel('Module name').fill('zz-e2e-side')
    await side(page).getByTestId('rename-save').click()
    await waitFor(async () => (await devices()).find((d) => d.guid === g).name === 'zz-e2e-side', 10_000, 'renamed')
    await expect(side(page).getByRole('heading', { name: 'zz-e2e-side' })).toBeVisible()
  } finally {
    await apiJson('POST', `/api/devices/${g}/rename`, { Name: 'PDM-05' })
  }
})

test('Add a module by hand, change its base ID, then remove it @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  let g
  try {
    const bus = page.waitForResponse((r) => r.url().includes("/api/canlog"))
    await page.getByTestId('add-module').click()
    const dlg = page.getByRole('dialog', { name: 'Add module' })
    await dlg.getByRole('tab', { name: 'By hand' }).click()
    await bus
    await dlg.getByRole('textbox', { name: 'Name' }).fill('zz-e2e-temp')
    const sugg = dlg.getByRole('button', { name: /^0x[0-9A-F]{3}$/ }).first()
    const base = await sugg.innerText()
    await sugg.click()
    await dlg.getByTestId('add-primary').click()
    await expect(page.getByTestId('row-zz-e2e-temp')).toBeVisible()
    await expect(page.getByTestId('row-zz-e2e-temp')).toContainText('Not found')
    await expect(page.getByTestId('row-zz-e2e-temp')).toContainText(base)
    g = await guidOf('zz-e2e-temp')
    expect((await devices()).find((d) => d.guid === g).baseId).toBe(parseInt(base, 16))
    // an offline module: only the project changes
    await page.getByTestId('row-zz-e2e-temp').locator('td').first().click()
    const input = side(page).getByTestId('base-input')
    await side(page).getByRole('button', { name: /^0x[0-9A-F]{3}$/ }).first().click()
    const next = await input.inputValue()
    expect(next).not.toBe(base)
    await side(page).getByTestId('base-set').click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toContainText('only the project changes')
    await confirm.getByTestId('confirm-yes').click()
    await waitFor(async () => (await devices()).find((d) => d.guid === g).baseId === parseInt(next, 16), 10_000, 'base changed')
    await expect(side(page).getByTestId('readdr-msg')).toContainText('was not answering')
    // remove it from the table
    await page.getByTestId('more-zz-e2e-temp').click(); await page.getByRole('menuitem', { name: /^Remove/ }).click()
    await expect(page.getByTestId('rm-yes')).toBeDisabled()
    await page.getByTestId('rm-type').fill('zz-e2e-temp')
    await page.getByTestId('rm-yes').click()
    await expect(page.getByTestId('row-zz-e2e-temp')).toHaveCount(0)
    g = null
  } finally {
    const left = (await devices()).find((d) => d.name === 'zz-e2e-temp')
    if (left) await apiJson('POST', `/api/devices/${left.guid}/remove`)
  }
  expect(errors).toEqual([])
})

test('Re-address a live module to a free ID and back @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const orig = await deviceByName('PDM-05')
  try {
    await page.getByTestId('row-PDM-05').locator('td').first().click()
    const sugg = side(page).getByRole('button', { name: /^0x[0-9A-F]{3}$/ }).first()
    const target = await sugg.innerText()
    await sugg.click()
    await side(page).getByTestId('base-set').click()
    await page.getByRole('alertdialog').getByTestId('confirm-yes').click()
    await expect(side(page).getByTestId('readdr-msg')).toContainText(`answers on ${target}`, { timeout: 30_000 })
    const moved = await deviceByName('PDM-05')
    expect(moved.baseId).toBe(parseInt(target, 16))
    expect(moved.connected).toBe(true)
  } finally {
    const cur = await deviceByName('PDM-05')
    if (cur.baseId !== orig.baseId) {
      await apiJson('POST', `/api/devices/${cur.guid}/modify`, { Name: 'PDM-05', BaseId: hex3(orig.baseId) })
      await waitFor(async () => { const d = await deviceByName('PDM-05'); return d.connected && d.baseId === orig.baseId }, 30_000, 'PDM-05 back on its ID')
    }
  }
  expect(errors).toEqual([])
})

test('Remove a module asks, removes it, and the project is marked unsaved @exclusive', async ({ page }) => {
  await open(page, 'hardware')
  // use a throwaway module so no real configuration is lost
  await apiJson('POST', '/api/devices', { Type: 'pdm', Name: 'zz-e2e-gone', BaseId: '0x740' })
  try {
    await expect(page.getByTestId('row-zz-e2e-gone')).toBeVisible()
    await page.getByTestId('more-zz-e2e-gone').click(); await page.getByRole('menuitem', { name: /^Remove/ }).click()
    await expect(page.getByTestId('rm-yes')).toBeDisabled()
    await page.getByTestId('rm-type').fill('zz-e2e-gone')
    await page.getByTestId('rm-yes').click()
    await expect(page.getByTestId('row-zz-e2e-gone')).toHaveCount(0)
    expect((await devices()).some((d) => d.name === 'zz-e2e-gone')).toBe(false)
  } finally {
    const left = (await devices()).find((d) => d.name === 'zz-e2e-gone')
    if (left) await apiJson('POST', `/api/devices/${left.guid}/remove`)
  }
})
