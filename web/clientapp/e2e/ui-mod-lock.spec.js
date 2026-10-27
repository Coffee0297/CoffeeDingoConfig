// ui-mod: configuration lock on a 5.7 CANBoard (CB-2) through its Settings tab: lock, a locked module refuses Apply
// with a clear reason, a wrong password is refused, the right one unlocks, the password is removed again.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'

const PW = '24680'
const lockBox = (page) => page.getByTestId('module-lock')

test('lock CB-2, Apply is refused while locked, a wrong password is refused, unlock, remove the password @exclusive', async ({ page }) => {
  test.setTimeout(900_000)
  const errors = watchErrors(page)
  const cb = await deviceByName('CB-2')
  try {
    await open(page, `hardware/module/${cb.guid}/settings`)
    await expect(lockBox(page).getByTestId('lock-state')).toContainText('Not locked')
    await lockBox(page).getByTestId('lock-contact').fill('ui-mod test 555 0100')
    await lockBox(page).getByTestId('lock-pw').fill(PW)
    await lockBox(page).getByTestId('lock-pw2').fill('13579')
    await expect(lockBox(page).getByText('The two passwords differ.')).toBeVisible()
    await expect(lockBox(page).getByTestId('lock-set')).toBeDisabled()
    await lockBox(page).getByTestId('lock-pw2').fill(PW)
    await lockBox(page).getByTestId('lock-set').click()
    await expect(lockBox(page).getByTestId('lock-msg')).toContainText('it is locked now', { timeout: 300_000 })
    await expect(lockBox(page).getByTestId('lock-state')).toContainText('CB-2 is locked by its installer', { timeout: 60_000 })
    await expect(lockBox(page).getByTestId('lock-state')).toContainText('ui-mod test 555 0100')

    // a locked module refuses a write: the reason says so, nothing is changed
    const w = await fetch(`${process.env.E2E_API}/api/devices/${cb.guid}/write`, { method: 'POST' })
    expect(w.status).toBe(409)
    expect((await w.json()).error).toContain('locked by its installer')

    // wrong password, then the right one
    await lockBox(page).getByTestId('lock-unlock').click()
    await page.getByTestId('unlock-pw').fill('11111')
    await page.getByTestId('unlock-yes').click()
    const dlg = page.getByRole('alertdialog', { name: 'Unlock CB-2' })
    await expect(dlg).toContainText('Not unlocked: wrong password')   // said in the dialog, not behind it
    await page.waitForTimeout(6000)   // the firmware ignores a try within 1 s of a wrong one (1 s of module time: the Sim runs slower)
    await page.getByTestId('unlock-pw').fill(PW)
    await page.getByTestId('unlock-yes').click()
    await expect(lockBox(page).getByTestId('lock-msg')).toContainText('CB-2 is unlocked until it restarts', { timeout: 60_000 })
    await expect(lockBox(page).getByTestId('lock-state')).not.toContainText('locked by its installer', { timeout: 30_000 })
  } finally {
    // remove the password (unlocked now, or unlock first through the API)
    const d = await deviceByName('CB-2')
    if (d.lock?.locked) await apiJson('POST', `/api/devices/${cb.guid}/unlock`, { Password: Number(PW) }).catch(() => null)
    await page.reload()
    await expect(lockBox(page).getByTestId('lock-clear')).toBeVisible({ timeout: 30_000 })
    await lockBox(page).getByTestId('lock-clear').click()
    await expect(lockBox(page).getByTestId('lock-msg')).toContainText('has no password any more', { timeout: 300_000 })
  }
  await waitFor(async () => !(await deviceByName('CB-2')).lock?.passwordSet && !(await deviceByName('CB-2')).lock?.locked, 60_000, 'CB-2 without a password')
  expect(errors.filter((e) => !/40[09]/.test(e))).toEqual([])
})
