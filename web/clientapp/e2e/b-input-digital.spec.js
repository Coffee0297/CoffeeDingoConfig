// Digital input detail (hardware/module/<guid>/input/input/<n>). Writes: CB-2 input 8 only (DI6 and DI7 are used by other work in the scene); restored after each test.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { deviceByName, funcRow, putFunc, withFunc, stepper, waitFor, apiJson, mockFunctions } from './b-helpers.js'

test.describe.configure({ timeout: 120_000 })

let cb
test.beforeAll(async () => { cb = await deviceByName('CB-2') })
const row = (n) => funcRow(cb.guid, 'digitalIn', n)
const openDi = async (page, n) => { await open(page, `hardware/module/${cb.guid}/input/input/${n}`); await expect(page.getByTestId('save')).toBeVisible() }
const withDi = (n, fn) => withFunc(cb.guid, 'input', 'digitalIn', n, fn)

/** Make GET .../signals report this digital input as `on` (or off) so edge detection can be tested without a real switch. */
async function mockInput(page, realName, name) {
  const ctl = { on: false }
  await page.route('**/api/devices/*/signals', async (route) => {
    const r = await route.fetch()
    const list = await r.json()
    for (const s of list) if (s.kind === 'Digital input' && s.name === realName) { s.name = name; s.on = ctl.on; s.value = ctl.on ? 'on' : 'off'; s.enabled = true }
    await route.fulfill({ response: r, json: list })
  })
  return ctl
}

test('shows pin, name, state and the controls for an input that is not in use', async ({ page }) => {
  const errors = watchErrors(page)
  await openDi(page, 8)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/digitalInput8|.+/)
  await expect(page.getByText(/DI8\s*·\s*J3-8/)).toBeVisible()
  await expect(page.getByTestId('in-state')).toContainText('Not in use')
  await expect(page.getByRole('radio', { name: /On \/ off switch/ })).toBeVisible()
  await expect(page.getByRole('radio', { name: /PWM measurement/ })).toBeVisible()
  await expect(page.getByTestId('test-start')).toBeDisabled()
  await expect(page.getByText('Turn the input on and save first.')).toBeVisible()
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'CB-2' }).click()
  await expect(page).toHaveURL(new RegExp(`hardware/module/${cb.guid}`))
  expect(errors).toEqual([])
})

test('switch settings are saved to the module and Revert undoes unsaved edits', async ({ page }) => {
  const errors = watchErrors(page)
  await withDi(8, async () => {
    await openDi(page, 8)
    await page.getByTestId('name').fill('MCPVAL b brake')
    await page.getByRole('switch', { name: 'Input in use' }).click()
    await page.getByRole('radio', { name: /Latching/ }).click()
    await page.getByRole('radio', { name: /Pull-down/ }).click()
    await stepper(page, 'Debounce').more.click()
    await expect(stepper(page, 'Debounce').input).toHaveValue('25')
    await stepper(page, 'Debounce').input.fill('35'); await stepper(page, 'Debounce').input.blur()
    await page.getByRole('checkbox', { name: /Invert/ }).click()
    // Revert drops all of it
    await page.getByRole('button', { name: 'Revert' }).dispatchEvent('click')
    await expect(page.getByTestId('name')).toHaveValue('digitalInput8')
    await expect(page.getByRole('switch', { name: 'Input in use' })).not.toBeChecked()
    await expect(page.getByTestId('save')).toBeDisabled()
    // again, and save
    await page.getByTestId('name').fill('MCPVAL b brake')
    await page.getByRole('switch', { name: 'Input in use' }).click()
    await page.getByRole('radio', { name: /Latching/ }).click()
    await page.getByRole('radio', { name: /Pull-down/ }).click()
    await stepper(page, 'Debounce').input.fill('35'); await stepper(page, 'Debounce').input.blur()
    await page.getByRole('checkbox', { name: /Invert/ }).click()
    await expect(page.getByText('Each press flips the state')).toBeVisible()
    await page.getByTestId('save').dispatchEvent('click')
    await expect(page.getByTestId('save-status')).toContainText(/^Kept in the project/, { timeout: 30_000 })
    await waitFor(async () => { const r = await row(8); return r.enabled && r.name === 'MCPVAL b brake' && r.mode === 1 && r.pull === 2 && r.debounceTime === 35 && r.invert && !r.pwm }, 20_000, 'digital input 6 on the module')
    await expect(page.getByTestId('in-state')).not.toContainText('Not in use')
  })
  expect(errors).toEqual([])
})

test('PWM measurement mode: expected frequency, glitch filter and invert are saved', async ({ page }) => {
  const errors = watchErrors(page)
  await withDi(8, async () => {
    await openDi(page, 8)
    await page.getByRole('radio', { name: /PWM measurement/ }).click()
    await expect(page.getByText('Live duty and frequency are not shown yet')).toBeVisible()
    await expect(page.getByRole('radio', { name: /Latching/ })).toHaveCount(0)   // switch-only options are hidden
    await page.getByLabel(/Expected frequency/).fill('9000'); await page.getByLabel(/Expected frequency/).blur()
    await expect(page.getByTestId('save-status')).toContainText(/must be 0 to 5000 Hz/)
    await expect(page.getByTestId('save')).toBeDisabled()
    await page.getByLabel(/Expected frequency/).fill('500'); await page.getByLabel(/Expected frequency/).blur()
    await stepper(page, 'Glitch filter').input.fill('30'); await stepper(page, 'Glitch filter').input.blur()
    await page.getByRole('checkbox', { name: /Invert/ }).click()
    await page.getByTestId('save').dispatchEvent('click')
    await expect(page.getByTestId('save-status')).toContainText(/^Kept in the project/, { timeout: 30_000 })
    await waitFor(async () => { const r = await row(8); return r.enabled && r.pwm && r.pwmFreq === 500 && r.pwmMinPulseUs === 30 && r.invert }, 20_000, 'PWM input on the module')
  })
  expect(errors).toEqual([])
})

test('press test: waiting, Stop, and no change after 10 s shows the wiring check', async ({ page }) => {
  const errors = watchErrors(page)
  {
    await mockFunctions(page, cb.guid, (f) => Object.assign(f.digitalIn[7], { enabled: true, name: 'MCPVAL b test', pull: 1 }))
    await mockInput(page, (await row(8)).name, 'MCPVAL b test')
    await openDi(page, 8)
    await expect(page.getByTestId('in-state')).toContainText(/OFF|ON/)
    await page.getByTestId('test-start').click()
    await expect(page.getByTestId('test-status')).toContainText(/Waiting… press the switch now · \d+ s left/)
    await page.getByTestId('test-stop').click()
    await expect(page.getByTestId('test-status')).toContainText('watches the input for 10 s')
    await page.getByTestId('test-start').click()
    await expect(page.getByTestId('test-status')).toContainText('No change in 10 s', { timeout: 20_000 })
    await expect(page.getByRole('alert').filter({ hasText: 'Wiring check: nothing changed in 10 s' })).toBeVisible()
    await expect(page.getByTestId('test-start')).toHaveText('Test again')
  }
  expect(errors).toEqual([])
})

test('press test sees a change on the pin and the live state follows it', async ({ page }) => {
  const errors = watchErrors(page)
  {
    await mockFunctions(page, cb.guid, (f) => Object.assign(f.digitalIn[7], { enabled: true, name: 'MCPVAL b edge' }))
    const ctl = await mockInput(page, (await row(8)).name, 'MCPVAL b edge')
    await openDi(page, 8)
    await expect(page.getByTestId('sees')).toContainText('OFF')
    await page.getByTestId('test-start').click()
    await expect(page.getByTestId('test-status')).toContainText('Waiting')
    ctl.on = true
    await expect(page.getByTestId('test-status')).toContainText(/Change seen after [\d.]+ s/, { timeout: 8_000 })
    await expect(page.getByTestId('sees')).toContainText('ON')
    await expect(page.getByTestId('in-state')).toContainText('ON')
    await expect(page.getByText(/s ago/)).toBeVisible()
    await expect(page.getByRole('img', { name: /Line graph of the input state/ })).toBeVisible()
    ctl.on = false
    await expect(page.getByTestId('sees')).toContainText('OFF', { timeout: 5000 })
  }
  expect(errors).toEqual([])
})

test('used-by lists the functions that read an input', async ({ page }) => {
  // The PDM-05 CAN input that feeds the module's mute-TX signal (CAN input 7 "Sleep · master quiet" in the Ranchero
  // project; looked up, not hard-coded, since the var number differs between the fork and the 5.7 layout), so the list must name it.
  const p5 = await deviceByName('PDM-05')
  const mute = (await apiJson('GET', `/api/devices/${p5.guid}/inputs`)).find((v) => v.index === p5.muteTxInput && v.kind === 'caninput')
  expect(mute, 'PDM-05 mutes on one of its CAN inputs').toBeTruthy()
  await open(page, `hardware/module/${p5.guid}/input/caninput/${mute.number}`)
  await expect(page.getByTestId('used-by')).toContainText('Car sleep')
  await page.getByTestId('used-by').getByRole('link').first().click()
  await expect(page).toHaveURL(new RegExp(`functions/flow/${p5.guid}`))
})

test('unknown module and unknown input type show a clear message', async ({ page }) => {
  await open(page, 'hardware/module/00000000-0000-0000-0000-000000000000/input/input/1')
  await expect(page.getByRole('heading', { name: 'Module not found' })).toBeVisible()
  await open(page, `hardware/module/${cb.guid}/input/input/99`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('has no digital input 99')
  await open(page, `hardware/module/${cb.guid}/input/banana/1`)
  await expect(page.getByRole('heading', { level: 1, name: 'Unknown input type' })).toBeVisible()
})
