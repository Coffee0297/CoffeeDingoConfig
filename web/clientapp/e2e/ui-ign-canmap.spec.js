// Ignition CAN ids on the CAN map and in the Apply checks (Ranchero: sync 0x740 from PDM-02, status ids 0x741-0x747).
// Each case is saved on the Ignition page (staged, never applied) and put back the same way.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'
import { appErrors, fn } from './ui-ign-helpers.js'

test.describe.configure({ mode: 'serial' })

/** Save, then wait until the record has it (`done`): an earlier save's toast may still be showing. */
async function saveIgnition(page, done) {
  await page.getByTestId('ignition-save').click()
  await waitFor(done, 60_000, 'ignition saved')
  await expect(page.getByTestId('ignition-save')).toBeEnabled({ timeout: 60_000 })   // every module written
}
async function canMap(page, clash) {
  await open(page, 'expert/can')
  await expect(page.getByTestId('can-clash-count')).toContainText(clash ? /\d+ clash/ : 'No clashes', { timeout: 20_000 })
}
/** The Apply panel lists the check and refuses Apply for each named module. */
async function applyBlocked(page, title, names) {
  await page.getByTestId('apply-pill').click()
  const panel = page.getByRole('dialog', { name: 'Apply to car' })
  await expect(panel.getByTestId('apply-checks')).toContainText(title, { timeout: 60_000 })
  for (const n of names) {
    if (!(await panel.getByTestId('apply-' + n).count())) await panel.getByTestId('apply-quiet').click()
    await expect(panel.getByRole('button', { name: 'Apply ' + n })).toBeDisabled()
  }
  await page.keyboard.press('Escape')
}

test('the project as it is: the sync and the status ids are on the map, no clash', async ({ page }) => {
  const errors = watchErrors(page)
  await canMap(page, false)
  const map = await apiJson('GET', '/api/can-id-map')
  expect(map.claimed['740']).toEqual(['PDM-02: ignition sync'])
  for (const [id, n] of [['741', 'PDM-01'], ['742', 'PDM-02'], ['747', 'CB-2']]) expect(map.claimed[id]).toEqual([`${n}: ignition status`])
  await page.getByTestId('can-filter-mod').click()
  await expect(page.getByTestId('can-table').locator('tr', { hasText: 'PDM-02: ignition sync' })).toContainText('0x740')
  expect(appErrors(errors)).toEqual([])
})

test('two modules on one status id: a clash on the map and Apply refused for both', async ({ page }) => {
  const errors = watchErrors(page)
  try {
    await open(page, 'power/ignition')
    await page.getByTestId('ign-status-id-PDM-03').fill('0x744')
    await expect(page.getByText(/0x744 is one of PDM-04's frames/)).toBeVisible()   // a warning only on this page
    await saveIgnition(page, async () => (await fn('PDM-03')).statusId === 0x744)
    await canMap(page, true)
    await page.getByTestId('can-filter-clash').click()
    await expect(page.getByTestId('can-table').locator('tr[data-status=clash]', { hasText: '0x744' })).toContainText('PDM-03: ignition status')
    await applyBlocked(page, 'CAN id 0x744', ['PDM-03', 'PDM-04'])
  } finally {
    await open(page, 'power/ignition')
    await page.getByTestId('ign-status-id-PDM-03').fill('0x743')
    await saveIgnition(page, async () => (await fn('PDM-03')).statusId === 0x743)
  }
  await canMap(page, false)
  expect(appErrors(errors)).toEqual([])
})

test('PDM-02 back on its status slot 0x6C4 (the parity default) overlaps PDM-03: map and Apply say so', async ({ page }) => {
  const errors = watchErrors(page)
  try {
    await open(page, 'power/ignition')
    await page.getByTestId('ign-status-mode-PDM-02').click()
    await page.getByRole('option', { name: 'Default: 0x6C4' }).click()
    await saveIgnition(page, async () => (await fn('PDM-02')).statusId === 0)
    await canMap(page, true)
    await page.getByTestId('can-filter-clash').click()
    await expect(page.getByTestId('can-table').locator('tr[data-status=clash]').filter({ hasText: 'PDM-02: ignition status' })).toHaveCount(1)
    // the blocks overlap (PDM-02 now reaches +36): PDM-03's own config ids 0x6C0 / 0x6C1 are in the clash too
    await expect(page.getByTestId('can-table').locator('tr[data-status=clash]').filter({ hasText: 'PDM-02: module block' }).first()).toContainText('0x6C0')
    await applyBlocked(page, /overlap|CAN id 0x6C4/, ['PDM-02', 'PDM-03'])
    // the module's own settings say which ids overlap (the 5.7 span, not the 5.6 one that would not overlap)
    await open(page, 'hardware')
    await page.getByRole('row', { name: /PDM-02/ }).first().click()
    await expect(page.getByText(/0x6A0 to 0x6C4 overlaps PDM-03 \(0x6C0 to /).first()).toBeVisible()
  } finally {
    await open(page, 'power/ignition')
    await page.getByTestId('ign-status-mode-PDM-02').click()
    await page.getByRole('option', { name: 'A fixed CAN id' }).click()
    await page.getByTestId('ign-status-id-PDM-02').fill('0x742')
    await saveIgnition(page, async () => (await fn('PDM-02')).statusId === 0x742)
  }
  expect((await fn('PDM-02')).statusId).toBe(0x742)
  await canMap(page, false)
  expect(appErrors(errors)).toEqual([])
})

test('a sync id on another module\'s frame is a warning on the page and a clash for Apply', async ({ page }) => {
  const errors = watchErrors(page)
  try {
    await open(page, 'power/ignition')
    await page.getByTestId('ign-sync-id').fill('0x6D0')
    await expect(page.getByText(/0x6D0 is one of PDM-03's frames/)).toBeVisible()
    await saveIgnition(page, async () => (await fn('CB-2')).mainStateId === 0x6D0)
    await canMap(page, true)
    await applyBlocked(page, 'CAN id 0x6D0', ['PDM-02', 'PDM-03'])
  } finally {
    await open(page, 'power/ignition')
    await page.getByTestId('ign-sync-id').fill('0x740')
    await saveIgnition(page, async () => (await fn('CB-2')).mainStateId === 0x740)
  }
  for (const n of ['PDM-02', 'PDM-03', 'CB-1']) expect((await fn(n)).mainStateId, n).toBe(0x740)
  await canMap(page, false)
  expect(appErrors(errors)).toEqual([])
})
