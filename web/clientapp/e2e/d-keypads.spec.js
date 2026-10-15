// Keypads screen. Safe target: PDM-03 keypad slot 2 (and its button 1). Everything is restored in `finally`.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'

// A keypad write waits for the module's confirm (up to ~10 s when the Sim stays silent): give controls time to come back.
test.use({ actionTimeout: 45_000 })

export async function pick(page, testid, label) {
  await page.getByTestId(testid).click()
  await page.getByRole('option', { name: label }).first().click()
}

async function slot2(pdm) {
  const f = await apiJson('GET', `/api/devices/${pdm.guid}/functions`)
  return f.keypads.find((k) => k.number === 2)
}
const BTN1 = (kp) => kp.buttons.find((b) => b.number === 1)

async function restore(pdm) {
  await apiJson('POST', `/api/devices/${pdm.guid}/function/keypadbutton/33`, { enabled: false, name: 'button1', mode: 0, valColors: [0, 0, 0, 0], valVars: [0, 0, 0, 0], valBlink: [false, false, false, false], blinkColors: [0, 0, 0, 0], faultColor: 0, faultVar: 0, faultBlink: false, faultBlinkColor: 0 }).catch(() => {})
  await apiJson('POST', `/api/devices/${pdm.guid}/function/keypad/2`, { enabled: false, id: 0, model: 6, backlightBrightness: 63, dimmingVar: 0 }).catch(() => {})
  // slot 1 is only touched by the "node already used" test
  await apiJson('POST', `/api/devices/${pdm.guid}/function/keypad/1`, { enabled: false, id: 0, model: 6 }).catch(() => {})
}

test('keypads: add on PDM-03 slot 2, map a button, LEDs, backlight, dim, expert SDO (cancelled), remove', async ({ page }) => {
  test.setTimeout(600_000)
  const errors = watchErrors(page)
  const pdm = await deviceByName('PDM-03')
  await restore(pdm)
  try {
    await open(page, 'hardware/keypads')
    await expect(page.getByTestId('no-keypads')).toBeVisible()

    // Add: validation first, then the real add
    await pick(page, 'add-keypad-pdm', 'PDM-03 · keypad 2')
    await page.getByTestId('add-keypad-node').fill('200')
    await page.getByTestId('add-keypad').click()
    await expect(page.getByText('The node ID must be a whole number from 1 to 127.')).toBeVisible()
    await page.getByTestId('add-keypad-node').fill('21')
    await pick(page, 'add-keypad-model', 'Blink Marine 8-key')
    await page.getByTestId('add-keypad').click()
    await expect(page.getByTestId('keypad-PDM-03-2')).toBeVisible()
    await waitFor(async () => (await slot2(pdm)).enabled, 25_000, 'keypad enabled')
    const kp = await slot2(pdm)
    expect(kp.id).toBe(21)
    expect(kp.model).toBe(4)
    await expect(page.getByTestId('keypad-face').locator('button.key')).toHaveCount(8)

    // No keypad on the Sim bus: it must say so, and keep the settings
    await expect(page.getByTestId('keypad-down')).toContainText(/not answering on node 0x015/i)
    await expect(page.getByTestId('keypad-PDM-03-2')).toContainText('Not answering')
    await page.getByRole('button', { name: 'Try again' }).click()

    // Map button 1
    await page.getByTestId('key-1').click()
    await page.getByTestId('btn-enabled').click()
    await waitFor(async () => BTN1(await slot2(pdm)).enabled, 25_000, 'button enabled')
    await page.getByTestId('btn-name').fill('MCPVAL horn')
    await page.getByTestId('btn-name').blur()
    await waitFor(async () => BTN1(await slot2(pdm)).name === 'MCPVAL horn', 25_000, 'button name')
    await expect(page.getByTestId('key-1')).toContainText('MCPVAL horn')
    await page.getByTestId('btn-action').getByRole('radio', { name: /Toggle/ }).click()
    await waitFor(async () => BTN1(await slot2(pdm)).mode === 1, 25_000, 'toggle mode')

    // LED state 1: colour, signal, blink
    await pick(page, 'led-1-color', 'Green')
    await waitFor(async () => BTN1(await slot2(pdm)).valColors[1] === 2, 25_000, 'LED colour')
    await page.getByTestId('led-1-signal').click()
    const opts = page.getByRole('option')
    expect(await opts.count()).toBeGreaterThan(1)
    await opts.nth(1).click()
    await waitFor(async () => BTN1(await slot2(pdm)).valVars[1] !== 0, 25_000, 'LED signal')
    await page.getByTestId('led-1-blink').click()
    await waitFor(async () => BTN1(await slot2(pdm)).valBlink[1] === true, 25_000, 'LED blink')
    await pick(page, 'led-fault-color', 'Red')
    await waitFor(async () => BTN1(await slot2(pdm)).faultColor === 1, 25_000, 'fault colour')
    await page.getByTestId('led-fault-blink').click()
    await waitFor(async () => BTN1(await slot2(pdm)).faultBlink === true, 25_000, 'fault blink')
    await expect(page.getByTestId('key-1')).toContainText('Off') // state 0 colour is still Off

    // Backlight + dim signal
    await page.getByTestId('backlight').fill('32')
    await waitFor(async () => (await slot2(pdm)).backlightBrightness === 32, 25_000, 'backlight')
    await expect(page.getByTestId('backlight-pct')).toHaveText('51 %')
    await page.getByTestId('dim-signal').click()
    await page.getByRole('option').nth(1).click()
    await waitFor(async () => (await slot2(pdm)).dimmingVar !== 0, 25_000, 'dim signal')
    await pick(page, 'dim-signal', 'Never dim')
    await waitFor(async () => (await slot2(pdm)).dimmingVar === 0, 25_000, 'dim cleared')

    // Expert SDO: read is harmless; write and store stop at the confirmation
    await page.getByTestId('sdo-toggle').click()
    await expect(page.getByTestId('sdo-toggle')).toHaveAttribute('aria-expanded', 'true')
    await page.getByTestId('sdo-read').click()
    await expect(page.getByTestId('sdo-log').locator('li').first()).toContainText(/read 0x1017/, { timeout: 15_000 })
    await page.getByTestId('sdo-value').fill('70000')
    await page.getByTestId('sdo-write').click()
    await expect(page.getByTestId('sdo-log')).toContainText('does not fit in 2 bytes')
    await page.getByTestId('sdo-value').fill('1000')
    await page.getByTestId('sdo-write').click()
    await expect(page.getByRole('dialog')).toContainText('Write 1000')
    await page.getByTestId('confirm-cancel').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByTestId('sdo-store').click()
    await expect(page.getByRole('dialog')).toContainText(/Store the keypad/)
    await page.getByTestId('confirm-cancel').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // Remove (cancel first, then confirm)
    await page.getByTestId('remove-keypad').click()
    await page.getByTestId('confirm-cancel').click()
    expect((await slot2(pdm)).enabled).toBe(true)
    await page.getByTestId('remove-keypad').click()
    await page.getByTestId('confirm-go').click()
    await waitFor(async () => !(await slot2(pdm)).enabled, 25_000, 'keypad removed')
    await expect(page.getByTestId('no-keypads')).toBeVisible()
  } finally {
    await restore(pdm)
  }
  expect(errors).toEqual([])
})

test('keypads: the used node ID is refused', async ({ page }) => {
  test.setTimeout(180_000)
  const pdm = await deviceByName('PDM-03')
  await restore(pdm)
  try {
    await open(page, 'hardware/keypads')
    await pick(page, 'add-keypad-pdm', 'PDM-03 · keypad 2')
    await page.getByTestId('add-keypad').click()
    await expect(page.getByTestId('keypad-PDM-03-2')).toBeVisible()
    // slot 1 of PDM-03 is free: try the same node again
    await pick(page, 'add-keypad-pdm', 'PDM-03 · keypad 1')
    await page.getByTestId('add-keypad').click()
    await expect(page.getByText('Node 21 is already used by another keypad.')).toBeVisible()
    expect((await apiJson('GET', `/api/devices/${pdm.guid}/functions`)).keypads[0].enabled).toBe(false)
  } finally { await restore(pdm) }
})

test('keypads: SDO write and store reach the keypad node @exclusive', async ({ page }) => {
  const pdm = await deviceByName('PDM-03')
  try {
    await open(page, 'hardware/keypads')
    await pick(page, 'add-keypad-pdm', 'PDM-03 · keypad 2')
    await page.getByTestId('add-keypad').click()
    await page.getByTestId('sdo-toggle').click()
    await page.getByTestId('sdo-value').fill('1000')
    await page.getByTestId('sdo-write').click()
    await page.getByTestId('confirm-go').click()
    await expect(page.getByTestId('sdo-log').locator('li').first()).toContainText(/write 0x1017/, { timeout: 15_000 })
    await page.getByTestId('sdo-store').click()
    await page.getByTestId('confirm-go').click()
    await expect(page.getByTestId('sdo-log').locator('li').first()).toContainText(/store in keypad memory|store refused/, { timeout: 15_000 })
  } finally { await restore(pdm) }
})
