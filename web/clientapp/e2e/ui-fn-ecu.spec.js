// ui-fn: the shipped ECU templates (Expert › CAN › DBC devices › "Add an ECU from the library") make CAN inputs on a module
// that decode the ECU's frames the way its DBC says (byte order, sign); then the dashboard's "Force a CAN input" sends a
// value in that frame and the module (the Sim) reads exactly that value back. Uses free CAN input slots of PDM-04; every
// test removes the ECU device and puts PDM-04 back.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'
import { fns, snapshot, restore } from './ui-fn-helpers.js'

const MOD = 'PDM-04'
// [template name in the picker, RPM frame id, byte order (1 = big endian), signed]
const ECUS = [
  ['Haltech Elite / Nexus', 0x360, 1, false],
  ['rusEFI (verbose broadcast)', 0x201, 0, false],
  ['ECUMaster EMU Black', 0x600, 0, false],
  ['MaxxECU', 0x520, 0, true],
]
test.describe.configure({ timeout: 300_000 })

for (const [name, rpmId, order, signed] of ECUS) {
  test(`${name}: library adds RPM / coolant / oil inputs, a forced RPM is decoded by the module`, async ({ page }) => {
    const errors = watchErrors(page)
    const snap = await snapshot(MOD)
    const dbcBefore = new Set((await apiJson('GET', '/api/devices')).filter((d) => /dbc/i.test(d.type)).map((d) => d.guid))
    const before = new Set(snap.f.canInputs.filter((x) => x.enabled).map((x) => x.number))
    try {
      await open(page, 'expert/can?tab=dbc')
      await page.getByTestId('ecu-lib').click()
      const dlg = page.getByRole('dialog', { name: 'Add an ECU from the library' })
      await dlg.getByTestId('ecu-lib-pick').click()
      await page.getByRole('option', { name, exact: true }).click()
      await expect(dlg.getByTestId('ecu-lib-note')).not.toBeEmpty()
      await dlg.getByTestId('ecu-lib-target').click()
      await page.getByRole('option', { name: MOD, exact: true }).click()
      await dlg.getByTestId('ecu-lib-go').click()
      await expect(dlg).toHaveCount(0, { timeout: 30_000 })
      await expect(page.locator('[role=status],[role=alert]').filter({ hasText: `Added ${name} and on ${MOD}` }).first()).toBeVisible()
      const made = (await fns(snap.guid)).canInputs.filter((x) => x.enabled && !before.has(x.number))
      expect(made.length).toBe(3)
      const rpm = made.find((x) => x.id === rpmId)
      expect(rpm, 'an RPM input on ' + rpmId.toString(16)).toBeTruthy()
      expect([rpm.bitLength, rpm.byteOrder ?? 0, !!rpm.signed]).toEqual([16, order, signed])
      await apiJson('POST', `/api/devices/${snap.guid}/writeall`, undefined, 90_000)

      // force 3000 rpm from the dashboard; the module decodes it from the frame the app sends
      await open(page, 'live')
      const r = page.getByTestId('force-row').filter({ hasText: rpm.name }).filter({ hasText: MOD }).first()
      await r.getByRole('button', { name: 'Force…' }).click()
      const fd = page.getByRole('dialog', { name: `Force ${rpm.name}?` })
      await fd.getByLabel('Value').fill('3000')
      await fd.getByLabel('Stop by itself after').fill('31')
      await expect(fd.getByTestId('force-confirm')).toBeDisabled()
      await fd.getByLabel('Stop by itself after').fill('20')
      await fd.getByTestId('force-confirm').click()
      await expect(page.getByTestId('forced')).toBeVisible()
      await expect(page.getByTestId('forced-value')).toHaveText('3000')
      await waitFor(async () => (await apiJson('GET', `/api/devices/${snap.guid}/signals`)).find((s) => s.kind === 'CAN input' && s.n === rpm.number)?.value === '3000', 20_000, 'PDM-04 reads 3000 rpm')
      await expect(r.locator('td').nth(3)).toHaveText('3000', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Step up' }).click()
      await waitFor(async () => (await apiJson('GET', `/api/devices/${snap.guid}/signals`)).find((s) => s.kind === 'CAN input' && s.n === rpm.number)?.value === '3001', 20_000, 'step up reaches the module')
      await page.getByTestId('force-stop').click()
      await expect(page.getByTestId('forced')).toHaveCount(0)
    } finally {
      await apiJson('POST', '/api/can/force/stop').catch(() => {})
      for (const d of (await apiJson('GET', '/api/devices')).filter((d) => /dbc/i.test(d.type) && !dbcBefore.has(d.guid))) await apiJson('POST', `/api/devices/${d.guid}/remove`).catch(() => {})
      await restore(snap)
    }
    expect(errors).toEqual([])
  })
}
