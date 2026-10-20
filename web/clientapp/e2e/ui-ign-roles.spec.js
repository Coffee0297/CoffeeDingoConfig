// Output roles on firmware 5.7 PDMs: Ignition / Accessory / Dash / Starter are the module's own roles (0x1E00 sub 0x30 + n).
// Uses PDM-05 o1 (spare, not enabled in the Ranchero); everything is put back.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'
import { appErrors, fn, modParam } from './ui-ign-helpers.js'

test('a 5.7 role is the module\'s own: Dash, then Starter (one starter is flagged with two), then None; applied and read from the module', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  const pdm = await deviceByName('PDM-05')
  const o1 = pdm.outputs.find((o) => o.number === 1)
  const roles0 = (await fn('PDM-05')).outputRoles
  const sel = page.getByTestId('role-PDM-05-o1'), row = page.getByTestId('roles-PDM-05').locator('li[data-output="1"]')
  try {
    await open(page, 'power/roles')
    await expect(sel).toBeEnabled({ timeout: 20_000 })
    await expect(row).toContainText('no input')
    await sel.selectOption('Dash')
    await waitFor(async () => (await fn('PDM-05')).outputRoles[0] === 3, 20_000, 'Dash role on PDM-05 o1')
    await expect(row).toContainText('follows the ignition')
    await expect(sel).toHaveValue('Dash')
    expect((await deviceByName('PDM-05')).outputs.find((o) => o.number === 1).enabled).toBe(true)   // a role turns the output on
    // Starter: a second starter output is a conflict
    await sel.selectOption('Starter')
    await waitFor(async () => (await fn('PDM-05')).outputRoles[0] === 4, 20_000, 'Starter role')
    await expect(page.getByTestId('roles-conflicts')).toContainText('2 outputs have the role Starter: PDM-05 o1, PDM-02 o8')   // the Ranchero's starter relay
    // Apply PDM-05 and read the role back from the module
    await page.getByTestId('apply-pill').click()
    const panel = page.getByRole('dialog', { name: 'Apply to car' })
    await expect(panel.getByRole('button', { name: 'Apply PDM-05' })).toBeEnabled({ timeout: 60_000 })
    await panel.getByRole('button', { name: 'Apply PDM-05' }).click()
    await page.getByTestId('apply-confirm-yes').click()
    await expect(panel.getByTestId('apply-PDM-05')).toContainText('Written, not stored', { timeout: 180_000 })
    expect(await modParam(pdm.baseId, 0x1E00, 0x30)).toBe(4)
    await page.keyboard.press('Escape')
    // reload: the role is read back from the record
    await page.reload()
    await expect(page.getByTestId('role-PDM-05-o1')).toHaveValue('Starter', { timeout: 20_000 })
    // None clears the module's role and the input
    await page.getByTestId('role-PDM-05-o1').selectOption('none')
    await waitFor(async () => (await fn('PDM-05')).outputRoles[0] === 0, 20_000, 'role cleared')
    await expect(page.getByTestId('roles-PDM-05').locator('li[data-output="1"]')).toContainText('no input')
  } finally {
    await apiJson('POST', `/api/devices/${pdm.guid}/function/ignition/1`, { outputRoles: roles0 })
    await apiJson('POST', `/api/devices/${pdm.guid}/outputconfig`, { Number: 1, Enabled: o1.enabled, Input: o1.inputVal ?? 0 })
  }
  await waitFor(async () => (await modParam(pdm.baseId, 0x1E00, 0x30)) === roles0[0], 30_000, 'module role restored')
  expect(appErrors(errors)).toEqual([])
})
