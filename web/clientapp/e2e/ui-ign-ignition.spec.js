// Ignition page on firmware 5.7 (Ranchero scene: PDM-02 main, sync 0x740, status ids 0x741-0x747).
// Page checks only change the form (nothing saved) unless the test says so; saving tests restore the module.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'

import { appErrors, fn, modParam } from './ui-ign-helpers.js'

test.describe.configure({ mode: 'serial' })

test('ignition page: main, followers and their status words, sync card, status ids, more card', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'power/ignition')
  await expect(page.getByTestId('ignition-banner')).toContainText('PDM-02 runs the ignition')
  await expect(page.getByTestId('ignition-banner')).toContainText(/State: (On|Off|Running|Cranking) · dash \w+/)
  await expect(page.getByTestId('ign-main')).toContainText('PDM-02')
  await expect(page.getByText(/CB-1 \(dash \w+ · [\w ]+ · hears the main\)/)).toBeVisible()
  await expect(page.getByTestId('ign-role')).toContainText('Main: runs the ignition')
  await expect(page.getByTestId('ign-sync-id')).toHaveValue('0x740')
  await expect(page.getByText('Sent on 0x740')).toBeVisible()
  for (const [n, id] of [['PDM-01', '0x741'], ['PDM-02', '0x742'], ['CB-2', '0x747']]) {
    await expect(page.getByTestId(`ign-status-mode-${n}`)).toContainText('A fixed CAN id')
    await expect(page.getByTestId(`ign-status-id-${n}`)).toHaveValue(id)
  }
  await expect(page.getByTestId('ign-stop')).toContainText('— not set')
  await expect(page.getByTestId('ign-btn-id')).toBeDisabled()   // mask 0 = the CAN start button is off
  expect(appErrors(errors)).toEqual([])
})

test('sync card: fixed id vs base offset, own range and other module checks block Save', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'power/ignition')
  const id = page.getByTestId('ign-sync-id'), all = page.getByTestId('ign-sync-all')
  await expect(id).toHaveValue('0x740')
  // offset mode: 48 from PDM-02's 0x6A0 = 0x6D0, a frame of PDM-03 (warning only)
  await page.getByTestId('ign-sync-mode').click()
  await page.getByRole('option', { name: /An offset from PDM-02/ }).click()
  await expect(id).toHaveValue('48')
  await expect(page.getByText(/0x6D0 is one of PDM-03's frames/)).toBeVisible()
  await expect(all).toBeEnabled()
  // inside its own range: an error, Save refuses, the copy button is off
  await id.fill('10')
  await expect(page.getByText(/0x6AA is one of PDM-02's own frames .*Use an offset of \d+ or more/)).toBeVisible()
  await expect(all).toBeDisabled()
  await page.getByTestId('ignition-save').click()
  await expect(page.getByRole('alert').filter({ hasText: /own frames/ })).toBeVisible()
  // above 0x7FF
  await id.fill('2000')
  await expect(page.getByText(/is above 0x7FF/)).toBeVisible()
  // back to a fixed id: bad hex, out of range, own range, then the project's id
  await page.getByTestId('ign-sync-mode').click()
  await page.getByRole('option', { name: 'A fixed CAN id' }).click()
  await expect(id).toHaveValue('0x6F1')
  await id.fill('zz')
  await expect(page.getByText('The sync id must be 0 to 0x7FF.')).toBeVisible()
  await id.fill('0x800')
  await expect(page.getByText('The sync id must be 0 to 0x7FF.')).toBeVisible()
  await id.fill('0x6A5')
  await expect(page.getByText(/0x6A5 is one of PDM-02's own frames/)).toBeVisible()
  await id.fill('0x740')
  await expect(page.getByText('Sent on 0x740')).toBeVisible()
  await expect(all).toBeEnabled()
  // nothing was saved
  expect((await fn('PDM-02')).mainStateId).toBe(0x740)
  expect(appErrors(errors)).toEqual([])
})

test('status ids: default slot vs fixed id, own frame / sync id block Save, another module\'s id warns', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'power/ignition')
  const f3 = page.getByTestId('ign-status-id-PDM-03')
  await expect(f3).toHaveValue('0x743')
  await f3.fill('0x740')
  await expect(page.getByText(/0x740 is the ignition sync id; PDM-03 would send no status/)).toBeVisible()
  await page.getByTestId('ignition-save').click()
  await expect(page.getByRole('alert').filter({ hasText: /ignition sync id/ })).toBeVisible()
  await f3.fill('0x6C5')
  await expect(page.getByText(/0x6C5 is one of PDM-03's own frames/)).toBeVisible()
  await f3.fill('0x742')
  await expect(page.getByText(/0x742 is one of PDM-02's frames/)).toBeVisible()   // PDM-02's status id: a warning
  await f3.fill('0')
  await expect(page.getByText(/the status frame id must be 0x001 to 0x7FF/)).toBeVisible()
  // the default slot: PDM-03 base 0x6C0 + 36 (the field is off, no check)
  await page.getByTestId('ign-status-mode-PDM-03').click()
  await page.getByRole('option', { name: /Default: 0x6E4/ }).click()
  await expect(f3).toBeDisabled()
  await expect(page.getByText(/status frame id must be/)).toHaveCount(0)
  expect((await fn('PDM-03')).statusId).toBe(0x743)
  expect(appErrors(errors)).toEqual([])
})

test('standalone hides the sync card and the followers; the status frame card stays', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'power/ignition')
  await page.getByTestId('ign-role').click()
  await page.getByRole('option', { name: /Standalone/ }).click()
  await expect(page.getByTestId('ign-sync-id')).toHaveCount(0)
  await expect(page.getByTestId('ign-follow')).toBeDisabled()
  await expect(page.getByRole('heading', { name: 'Status frame' })).toBeVisible()
  await expect(page.getByTestId('ign-status-id-PDM-02')).toHaveValue('0x742')
  await expect(page.getByTestId('ign-status-id-PDM-03')).toHaveCount(0)   // followers are not part of a standalone setup
  expect(appErrors(errors)).toEqual([])
})

async function pickOpt(page, testid, name) {
  await page.getByTestId(testid).click()
  await page.getByRole('option', { name, exact: true }).click()
}
async function setStep(page, testid, v) { const i = page.getByTestId(testid); await i.fill(String(v)); await i.press('Tab') }

test('more (firmware 5.7): stop, CAN start button, dash power down, door, sleep delay reach the module and persist', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = watchErrors(page)
  const main = await deviceByName('PDM-02')
  const before = await fn('PDM-02')
  const subs = { stopInput: 13, buttonExtended: 14, buttonId: 15, buttonByte: 16, buttonMask: 17, buttonTimeoutMs: 18, dashOffDelayMs: 19, doorInput: 20, doorOnMs: 21, sleepDelayMs: 22 }
  const want = { stopInput: 11, buttonExtended: 0, buttonId: 0x123, buttonByte: 2, buttonMask: 4, buttonTimeoutMs: 2000, dashOffDelayMs: 5000, doorInput: 17, doorOnMs: 30000, sleepDelayMs: 120000 }
  try {
    await open(page, 'power/ignition')
    await expect(page.getByTestId('ign-sync-id')).toHaveValue('0x740')
    await pickOpt(page, 'ign-stop', 'Showroom')
    await setStep(page, 'ign-btn-mask', 4)
    await expect(page.getByTestId('ign-btn-id')).toBeEnabled()
    await page.getByTestId('ign-btn-id').fill('0x123')
    await setStep(page, 'ign-btn-byte', 2)
    await setStep(page, 'ign-btn-timeout', 2)
    await setStep(page, 'ign-dash-off', 5)
    await pickOpt(page, 'ign-door', 'Hazard')
    await setStep(page, 'ign-door-on', 30)
    await setStep(page, 'ign-sleep', 2)
    // bad values first: a byte mask above 255 is clamped by the stepper, a door on-time of 0 is refused
    await setStep(page, 'ign-door-on', 0)
    await expect(page.getByTestId('ign-door-on')).toHaveValue('1')   // the stepper clamps to its minimum
    await setStep(page, 'ign-door-on', 30)
    await page.getByTestId('ignition-save').click()
    await expect(page.locator('[role=status],[role=alert]').filter({ hasText: /Ignition saved: PDM-02 is the main module, 6 follow it/ }).first()).toBeVisible({ timeout: 60_000 })
    // Save stages the edits: Apply to car writes them (the checks run first and must pass for PDM-02)
    await page.getByTestId('apply-pill').click()
    const panel = page.getByRole('dialog', { name: 'Apply to car' })
    await expect(panel.getByTestId('apply-PDM-02')).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Apply PDM-02' })).toBeEnabled({ timeout: 60_000 })
    await panel.getByRole('button', { name: 'Apply PDM-02' }).click()
    await page.getByTestId('apply-confirm-yes').click()
    await expect(panel.getByTestId('apply-PDM-02')).toContainText('Written, not stored', { timeout: 180_000 })
    await page.keyboard.press('Escape')
    const got = await fn('PDM-02')
    for (const [k, v] of Object.entries(want)) expect(Number(got[k]), k).toBe(v)
    for (const [k, sub] of Object.entries(subs)) expect(await modParam(main.baseId, 0x1E00, sub), `module ${k}`).toBe(want[k])
    // reload: the page shows what the module / project has
    await page.reload()
    await expect(page.getByTestId('ign-stop')).toContainText('Showroom', { timeout: 20_000 })
    await expect(page.getByTestId('ign-door')).toContainText('Hazard')
    await expect(page.getByTestId('ign-btn-id')).toHaveValue('0x123')
    await expect(page.getByTestId('ign-btn-mask')).toHaveValue('4')
    await expect(page.getByTestId('ign-btn-byte')).toHaveValue('2')
    await expect(page.getByTestId('ign-btn-timeout')).toHaveValue('2')
    await expect(page.getByTestId('ign-dash-off')).toHaveValue('5')
    await expect(page.getByTestId('ign-door-on')).toHaveValue('30')
    await expect(page.getByTestId('ign-sleep')).toHaveValue('2')
  } finally {
    // the restore waits for the bus (another module's Apply may still be sending its Lua)
    await waitFor(() => apiJson('POST', `/api/devices/${main.guid}/function/ignition/1`, Object.fromEntries(Object.keys(subs).map((k) => [k, before[k]]))), 120_000, 'restore')
  }
  for (const [k, sub] of Object.entries(subs)) expect(await modParam(main.baseId, 0x1E00, sub), `restored ${k}`).toBe(Number(before[k]))
  expect(appErrors(errors)).toEqual([])
})

test('"Use this sync setting on all followers" copies the id (and an offset\'s base) to every follower; nothing else changes', async ({ page }) => {
  const errors = watchErrors(page)
  const names = ['PDM-01', 'PDM-03', 'PDM-04', 'PDM-05', 'CB-1', 'CB-2']
  const before = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await fn(n)])))
  await open(page, 'power/ignition')
  const id = page.getByTestId('ign-sync-id')
  try {
    await id.fill('0x73F')
    await page.getByTestId('ign-sync-all').click()
    await expect(page.locator('[role=status]').filter({ hasText: /Sync setting copied to .*PDM-01.*Apply to car to store it/ }).first()).toBeVisible({ timeout: 30_000 })
    for (const n of names) {
      const g = await fn(n)
      expect([g.mainStateId, g.syncMode, g.syncBase], n).toEqual([0x73F, 0, 0])
      expect(g.statusId, n).toBe(before[n].statusId)
    }
    expect((await fn('PDM-02')).mainStateId).toBe(0x73F)
    // offset mode copies the main's base id as well
    await page.getByTestId('ign-sync-mode').click()
    await page.getByRole('option', { name: /An offset from PDM-02/ }).click()
    await id.fill('0x90')   // 0x6A0 + 0x90 = 0x730: free (inside nobody's range)
    await expect(page.getByText(/Sent on 0x730/)).toBeVisible()
    await page.getByTestId('ign-sync-all').click()   // the first toast may still show: wait for the module record
    await waitFor(async () => { const cb = await fn('CB-1'); return cb.mainStateId === 0x90 && cb.syncMode === 1 && cb.syncBase === 0x6A0 }, 30_000, 'CB-1 offset sync')
  } finally {
    await page.getByTestId('ign-sync-mode').click()
    await page.getByRole('option', { name: 'A fixed CAN id' }).click()
    await id.fill('0x740')
    await page.getByTestId('ign-sync-all').click()
    await waitFor(async () => (await fn('CB-1')).mainStateId === 0x740, 30_000, 'sync restored')
  }
  for (const n of names) {
    const g = await fn(n)
    expect([g.mainStateId, g.syncMode, g.syncBase], `${n} restored`).toEqual([before[n].mainStateId, before[n].syncMode, before[n].syncBase])
  }
  expect(appErrors(errors)).toEqual([])
})
