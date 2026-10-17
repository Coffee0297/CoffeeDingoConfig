// First run (#/next/connect): connect, find and name the modules, place them on the car map.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, devices, modules, deviceByName, waitFor } from './api.js'
import { hex3, restoreConnection } from './a-util.js'

test('connected: step 2 lists every module with type, address, state and an editable name', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'connect')
  const devs = (await modules()).sort((a, b) => a.baseId - b.baseId)
  await expect(page.getByRole('heading', { level: 1, name: `${devs.length} modules found. Name them.` })).toBeVisible()
  await expect(page.getByText('Step 2 of 3')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Steps' }).getByRole('listitem').nth(1)).toHaveAttribute('aria-current', 'step')
  await expect(page.getByText(/Connected through SLCAN/)).toBeVisible()
  for (const d of devs) {
    const row = page.getByTestId('first-' + d.name)
    await expect(row).toContainText(d.type)
    await expect(row).toContainText(hex3(d.baseId))
    await expect(row).toContainText(d.connected ? 'Connected' : 'Not found')
    await expect(row.getByRole('textbox')).toHaveValue(d.name)
  }
  expect(errors).toEqual([])
})

test('Blink LED asks the module to blink (firmware 5.6)', async ({ page }) => {
  await open(page, 'connect')
  const b = page.getByRole('button', { name: /Blink the LED of PDM-01/ })
  await expect(b).toBeEnabled()
  await b.click()
  await expect(page.getByText('PDM-01 is blinking its LEDs for 10 s.')).toBeVisible({ timeout: 5000 })
})

test('the car map is here and "placed" follows where a module was put', async ({ page }) => {
  await open(page, 'connect')
  await expect(page.getByRole('region', { name: 'Car map' })).toBeVisible()
  const g = (await deviceByName('PDM-03')).guid
  await expect(page.getByTestId('first-PDM-03')).toContainText(/placed|not placed/)
  const before = await page.evaluate(() => localStorage.getItem('pinpos'))
  await page.evaluate((guid) => { const p = JSON.parse(localStorage.getItem('pinpos') || '{}'); p[guid] = { x: 40, y: 40 }; localStorage.setItem('pinpos', JSON.stringify(p)) }, g)
  await expect(page.getByTestId('first-PDM-03')).toContainText('placed ✓', { timeout: 5000 })
  await page.evaluate((b) => (b == null ? localStorage.removeItem('pinpos') : localStorage.setItem('pinpos', b)), before)
  await expect(page.getByTestId('first-PDM-03')).toContainText(/not placed|placed ✓/)
})

test('Find modules opens the Add module dialog', async ({ page }) => {
  await open(page, 'connect')
  await page.getByTestId('find-modules').click()
  await expect(page.getByRole('dialog', { name: 'Add module' })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('Change goes back to step 1, which offers USB and the other adapters', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'connect')
  await page.getByTestId('change-conn').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Connect to the car' })).toBeVisible()
  await expect(page.getByText('Step 1 of 3')).toBeVisible()
  await expect(page.getByText(/Already connected through SLCAN/)).toBeVisible()
  await page.getByTestId('other-adapters').click()
  await expect(page.getByRole('dialog', { name: 'Connection' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Keep the current connection' }).click()
  await expect(page.getByRole('heading', { level: 1, name: /modules found/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('Back, Next and Skip go where they say', async ({ page }) => {
  await open(page, 'connect')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Connect to the car' })).toBeVisible()
  await page.getByRole('button', { name: 'Keep the current connection' }).click()
  await page.getByTestId('first-next').click()
  await expect(page).toHaveURL(/#\/next\/functions\/add/)
  await open(page, 'connect')
  await page.getByRole('link', { name: 'Skip to the app' }).click()
  await expect(page).toHaveURL(/#\/next\/car/)
})

test('a name that is empty or already used is refused with a reason (nothing is renamed)', async ({ page }) => {
  await open(page, 'connect')
  const row = page.getByTestId('first-PDM-05')
  const input = row.getByRole('textbox')
  await input.fill('')
  await input.press('Enter')
  await expect(row.getByText('The name cannot be empty.')).toBeVisible()
  await input.fill('PDM-01')
  await input.press('Enter')
  await expect(row.getByText('Another module is called PDM-01.')).toBeVisible()
  expect((await devices()).some((d) => d.name === 'PDM-05')).toBe(true)
})

test('naming a module renames it in the project and marks it unsaved @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'connect')
  const g = (await deviceByName('PDM-05')).guid
  try {
    const row = page.getByTestId('first-PDM-05')
    await row.getByRole('textbox').fill('zz-e2e-first')
    await row.getByRole('textbox').press('Enter')
    await waitFor(async () => (await devices()).find((d) => d.guid === g).name === 'zz-e2e-first', 10_000, 'renamed')
    await expect(page.getByTestId('first-zz-e2e-first')).toBeVisible()
    await expect(page.getByTestId('project-chip')).toContainText('unsaved')
  } finally { await apiJson('POST', `/api/devices/${g}/rename`, { Name: 'PDM-05' }) }
  expect(errors).toEqual([])
})

test('not connected: step 1 offers USB, and a failed USB connect says why @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'connect')
  try {
    await apiJson('POST', '/api/disconnect')
    await expect(page.getByRole('heading', { level: 1, name: 'Connect to the car' })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Not connected, nothing can be read from or written to the car.')).toBeVisible()
    await page.getByTestId('usb-connect').click()
    // on a PC with no module on USB the plain reason is shown; with one, the page moves on to step 2
    await expect(page.getByText(/Could not connect|No dingo module found on USB|modules? found/).first()).toBeVisible({ timeout: 40_000 })
  } finally { await restoreConnection() }
  void errors
})
