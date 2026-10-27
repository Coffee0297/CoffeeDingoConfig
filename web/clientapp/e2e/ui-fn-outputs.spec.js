// ui-fn: the output page of a spare PDM output (PDM-05 o1, switched off with no input in the Ranchero project) on firmware
// 5.7: currents at 0.1 A, inrush, warn, open load, undercurrent, dead short, wire load, soft start, PWM, wiring and the fuse
// curve; kept, applied through the Apply panel, read back from the module, still there after a reload. Put back in `finally`.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { near, deviceByName } from './api.js'
import { stepper, pickSelect, saveAndWait } from './b-helpers.js'
import { snapshot, restore, applyModule, readModule } from './ui-fn-helpers.js'

// PDM-05 o1 (spare: off, no input). Not PDM-04: a wire time constant adds the wire-load frame past base + 31, which in the
// Ranchero (PDMs 0x20 apart) is the next PDM's id, so Apply refuses it there; PDM-05 has the top base.
const MOD = 'PDM-05', N = 1
test.describe.configure({ timeout: 300_000 })
const o8 = async () => (await deviceByName(MOD)).outputs.find((o) => o.number === N)
const set = async (page, label, v) => { const s = stepper(page, label).input; await s.fill(String(v)); await s.blur() }

test('protection and drive at 0.1 A on 5.7: kept, applied, read back, and shown again after a reload', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(MOD)
  try {
    await open(page, `hardware/module/${snap.guid}/output/${N}`)
    await expect(page.getByTestId('save')).toBeVisible()
    await set(page, 'Trips above', 7.3)
    await expect(page.getByTestId('protection-summary')).toContainText('7.3 A')
    await expect(page.getByTestId('fuse-summary')).toContainText(/7\.3|A/)
    await set(page, 'Inrush allowed', 21.7)
    await set(page, 'Inrush time', 400)
    await set(page, 'Warn at', 6.1)
    await set(page, 'Load missing below', 0.2)
    await set(page, 'Load missing for', 700)
    await set(page, 'Too little current below', 0.4)
    await set(page, 'Too little current for', 1500)
    await pickSelect(page, 'On too little current', 'Switch the output off')
    await expect(page.getByText(/latches Fault: only where losing this load is safe/)).toBeVisible()
    // a dead short at or below the inrush is flagged
    await set(page, 'Dead short above', 20)
    await expect(page.getByText(/at or below the inrush allowed/)).toBeVisible()
    await set(page, 'Dead short above', 60)
    await set(page, 'Wire time constant', 30)
    await page.getByRole('radio', { name: /PWM, fixed duty/ }).click()
    await set(page, 'Duty', 40)
    await set(page, 'Frequency', 200)
    await page.getByRole('switch', { name: /Soft start/ }).click()
    await set(page, 'Ramp time', 300)
    await saveAndWait(page)
    await applyModule(page, MOD)
    await readModule(page, MOD)
    const o = await o8()
    expect([near(o.currentLimit, 7.3), near(o.inrushLimit, 21.7), o.inrushTime, near(o.warnLimit, 6.1), near(o.openLoadLimit, 0.2), o.openLoadTime, near(o.underLimit, 0.4), o.underTime, o.underTrip, near(o.hardShortLimit, 60), o.thermalTau, o.pwmEnabled, o.fixedDuty, o.freq, o.softStart, o.softStartRamp])
      .toEqual([true, true, 400, true, true, 700, true, 1500, true, true, 30, true, 40, 200, true, 300])
    await page.reload()
    await expect(stepper(page, 'Trips above').input).toHaveValue('7.3')
    await expect(stepper(page, 'Load missing below').input).toHaveValue('0.2')
    await expect(page.getByTestId('save-status')).toContainText('No changes')
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('fuse curve follows the limit and the example load; the wiring card shows the voltage drop', async ({ page }) => {
  const errors = watchErrors(page)
  const d = await deviceByName(MOD)
  await open(page, `hardware/module/${d.guid}/output/${N}`)
  const sum = page.getByTestId('fuse-summary')
  await expect(page.getByTestId('fuse-curve')).toBeVisible()
  const before = await sum.innerText()
  await set(page, 'Trips above', 3)
  await expect(sum).not.toHaveText(before)
  await set(page, 'Running current', 2.5)
  await expect(sum).toBeVisible()
  await page.getByTestId('length').locator('input').first().fill('4').catch(async () => { await page.getByLabel('Length, one way').fill('4') })
  await expect(page.getByTestId('vdrop').first()).toBeVisible()
  await page.getByRole('button', { name: 'Revert' }).dispatchEvent('click')
  await expect(page.getByTestId('save-status')).toContainText('No changes')
  expect(errors).toEqual([])
})
