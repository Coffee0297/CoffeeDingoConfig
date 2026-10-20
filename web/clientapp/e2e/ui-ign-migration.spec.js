// A 5.6 (fork) project on the 5.7 car: upload it through the Project menu, migrate it on the Modules page, then the
// ignition: PDM-02 stays main on the default sync id 0x6F1, which is inside PDM-04's ids (0x6E0..): the page warns,
// the CAN map and Apply refuse it; moving the sync to 0x740 clears it. Needs E2E_MIG56 (a copy of the operator's
// 5.6 project) and puts the ui-ign project (E2E_PROJECT) back at the end.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { open, watchErrors } from './helpers.js'
import { API, apiJson, waitFor, readUpstream } from './api.js'
import { appErrors, fn } from './ui-ign-helpers.js'

const MIG = process.env.E2E_MIG56
const shot = (page, n) => process.env.E2E_SHOTS && page.screenshot({ path: `${process.env.E2E_SHOTS}/${n}.png` })

test('5.6 project: upload, migrate, ignition sync 0x6F1 clash, moved to 0x740', async ({ page }) => {
  test.skip(!MIG || !fs.existsSync(MIG), 'E2E_MIG56 not set')
  test.setTimeout(600_000)
  const errors = watchErrors(page)
  try {
    await open(page, 'hardware')
    await page.getByTestId('project-chip').click()
    const menu = page.getByRole('dialog', { name: 'Project' })
    await menu.getByTestId('proj-upload-input').setInputFiles(MIG)
    const ask = page.getByRole('alertdialog')
    if (await ask.isVisible().catch(() => false) || await ask.waitFor({ timeout: 3000 }).then(() => true).catch(() => false)) {
      await shot(page, 'mig-01-unsaved-ask')
      await ask.getByTestId('dlg-discard').click()
    }
    await waitFor(async () => (await apiJson('GET', '/api/devices')).some((d) => d.name === 'PDM-02'), 30_000, 'project uploaded')
    await open(page, 'hardware')
    await shot(page, 'mig-02-modules')
    // connected to 5.7 modules, each record converts as soon as its module reports its version; the button does
    // the rest (a module not heard yet)
    const migrated = async () => (await apiJson('GET', '/api/devices')).filter((d) => /pdm|canboard/i.test(d.type)).every((d) => d.family === 'upstream')
    if (!(await waitFor(migrated, 30_000, 'auto migration').catch(() => false))) {
      await page.getByTestId('migrate57').click()
      await shot(page, 'mig-03-confirm')
      await page.getByTestId('migrate57-yes').click()
      await waitFor(migrated, 60_000, 'all migrated')
    }
    await readUpstream()
    // the module page shows its report, with the 0x6F1 warning
    await open(page, 'hardware')
    await page.getByRole('row', { name: /PDM-02/ }).first().click()
    await shot(page, 'mig-04-pdm02')
    const p2 = (await apiJson('GET', '/api/devices')).find((d) => d.name === 'PDM-02')
    // every follower was converted too: no "stays on 5.6" left; the overlap fix names the status id
    expect(p2.migration.filter((n) => /stays on firmware 5\.6/.test(n.text))).toEqual([])
    expect(p2.migration.some((n) => /CAN ids overlap.*give PDM-02's ignition status frame a free CAN id/.test(n.text))).toBe(true)
    // ignition: the sync id is the default 0x6F1, a frame of PDM-04
    await open(page, 'power/ignition')
    await expect(page.getByTestId('ignition-banner')).toContainText('PDM-02 runs the ignition')
    await expect(page.getByTestId('ign-sync-id')).toHaveValue('0x6F1')
    await expect(page.getByText(/0x6F1 is one of PDM-04's frames/)).toBeVisible()
    await shot(page, 'mig-05-ignition')
    const map = await apiJson('GET', '/api/can-id-map')
    expect(map.collisions.some((c) => c.hex === '0x6F1')).toBe(true)
    await page.getByTestId('apply-pill').click()
    await expect(page.getByRole('dialog', { name: 'Apply to car' }).getByTestId('apply-checks')).toContainText('CAN id 0x6F1', { timeout: 60_000 })
    await shot(page, 'mig-06-apply-blocked')
    await page.keyboard.press('Escape')
    // the fix: move the sync to 0x740 and copy it to the followers
    await page.getByTestId('ign-sync-id').fill('0x740')
    await page.getByTestId('ign-sync-all').click()
    await waitFor(async () => (await fn('CB-2')).mainStateId === 0x740 && (await fn('PDM-02')).mainStateId === 0x740, 30_000, 'sync moved')
    const after = await apiJson('GET', '/api/can-id-map')
    expect(after.collisions.some((c) => c.hex === '0x6F1' || c.hex === '0x740')).toBe(false)
    await open(page, 'expert/can')
    await shot(page, 'mig-07-canmap-after')
  } finally {
    // the ui-ign project back, read again
    const r = await fetch(API + '/api/project/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: fs.readFileSync(process.env.E2E_PROJECT, 'utf8') })
    expect(r.ok).toBe(true)
    await waitFor(async () => (await apiJson('GET', '/api/devices')).filter((d) => /pdm|canboard/i.test(d.type)).every((d) => d.connected), 60_000, 'modules back')
    await readUpstream()
  }
  expect(appErrors(errors)).toEqual([])
})
