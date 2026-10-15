// Firmware screen. Real flashing is destructive: the non-exclusive tests go as far as the confirmation dialog and press Cancel.
// Tests that really flash are tagged @exclusive (the lead runs them alone, with release files in E2E_SREC_DIR).
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'

const srec = (name) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from('S00F000068656C6C6F202020202000003C\nS9030000FC\n') })
const idle = async () => {
  const [a, b] = [await apiJson('GET', '/api/flash-can/status'), await apiJson('GET', '/api/flash/status')]
  return !a.busy && !b.busy
}

test('firmware: lists every module with board, version and path; read versions', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware/firmware')
  const table = page.getByTestId('fw-table')
  for (const n of ['PDM-01', 'PDM-02', 'PDM-03', 'PDM-04', 'PDM-05', 'CB-1', 'CB-2']) await expect(table.locator(`tr[data-module="${n}"]`)).toBeVisible()
  await expect(table.locator('tr[data-module="CB-2"]')).toContainText('CANBoard')
  await expect(table.locator('tr[data-module="CB-2"]')).toContainText('CAN')
  const gw = (await apiJson('GET', '/api/devices')).find((d) => d.isGateway)
  if (gw) await expect(table.locator(`tr[data-module="${gw.name}"]`)).toContainText('USB (link module)')
  await expect(page.getByTestId('fw-version-CB-2')).toHaveText(/^\d+\.\d+\.\d+$/)
  await page.getByTestId('fw-read-versions').click()
  await expect(page.locator('[role=status],[role=alert]').filter({ hasText: /Asked \d+ modules? for the version/ }).first()).toBeVisible()
  expect(await idle()).toBe(true)
  expect(errors).toEqual([])
})

test('firmware: files are matched to boards by name; update buttons stay off until a file fits', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware/firmware')
  await expect(page.getByTestId('fw-update-CB-2')).toBeDisabled()
  await expect(page.getByTestId('fw-status-CB-2')).toHaveText('Choose release files first')
  // only a CANBoard file: PDMs have nothing that fits
  await page.getByTestId('fw-files').setInputFiles([srec('canboard-v5-9-0.srec')])
  await expect(page.getByTestId('fw-file-list')).toContainText('canboard-v5-9-0.srec')
  await expect(page.getByTestId('fw-status-CB-2')).toHaveText('Ready: canboard-v5-9-0.srec')
  await expect(page.getByTestId('fw-update-CB-2')).toBeEnabled()
  await expect(page.getByTestId('fw-status-PDM-02')).toContainText('No .srec file for a dingoPDM')
  await expect(page.getByTestId('fw-update-PDM-02')).toBeDisabled()
  // a PDM file at the version the PDMs already run: skipped
  const v = (await deviceByName('PDM-02')).version.replace(/^v/, '').replaceAll('.', '-')
  await page.getByTestId('fw-files').setInputFiles([srec('canboard-v5-9-0.srec'), srec(`dingopdm_v7-v${v}.srec`)])
  await expect(page.getByTestId('fw-status-PDM-02')).toContainText('Already up to date')
  await expect(page.getByTestId('fw-update-PDM-02')).toBeDisabled()
  expect(await idle()).toBe(true)
  expect(errors).toEqual([])
})

test('firmware: update one and update all stop at the confirmation (cancelled, nothing flashed)', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware/firmware')
  await page.getByTestId('fw-files').setInputFiles([srec('canboard-v5-9-0.srec'), srec('dingopdm_v7-v5-9-0.srec')])
  await expect(page.getByTestId('fw-update-all')).toBeEnabled()
  // one module
  await page.getByTestId('fw-update-CB-2').click()
  const dlg = page.getByRole('dialog')
  await expect(dlg).toContainText('Update CB-2?')
  await expect(dlg).toContainText('canboard-v5-9-0.srec')
  await expect(dlg).toContainText('If it goes wrong')
  await expect(dlg).toContainText('bootloader and is safe')
  await page.getByTestId('confirm-cancel').click()
  await expect(dlg).toHaveCount(0)
  // all
  await page.getByTestId('fw-update-all').click()
  await expect(dlg).toContainText(/Update \d+ modules over CAN\?/)
  const list = page.getByTestId('fw-all-list')
  await expect(list).toContainText('CB-1')
  await expect(list).toContainText('CB-2')
  await expect(dlg).toContainText('link module')
  await page.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
  // nothing started
  await expect(page.getByTestId('fw-pause')).toHaveCount(0)
  await expect(page.getByTestId('fw-status-CB-2')).toHaveText('Ready: canboard-v5-9-0.srec')
  expect(await idle()).toBe(true)
  expect(errors).toEqual([])
})

test('firmware: flash a new board dialog scans for DFU and gates the flash button', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware/firmware')
  await page.getByTestId('fw-new-board').click()
  const dlg = page.getByRole('dialog')
  await expect(dlg).toContainText('Flash a new board')
  await expect(page.getByTestId('newboard-flash')).toBeDisabled()
  await page.getByTestId('dfu-scan').click()
  await expect(page.getByTestId('dfu-result')).toContainText(/board.* in DFU|No board in DFU|dfu-util not found/, { timeout: 30_000 })
  await expect(page.getByTestId('dfu-raw')).toContainText('dfu-util')
  await page.getByTestId('newboard-file').setInputFiles({ name: 'new-board.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(64) })
  await expect(dlg).toContainText('new-board.bin')
  await expect(page.getByTestId('newboard-flash')).toBeDisabled() // still needs the tick
  await page.getByTestId('newboard-sure').click()
  await expect(page.getByTestId('newboard-flash')).toBeEnabled()
  await page.getByTestId('newboard-close').click() // stop here: no flash
  await expect(dlg).toHaveCount(0)
  expect(await idle()).toBe(true)
  expect(errors).toEqual([])
})

test('firmware: a refused image shows the failure and that the module is safe @exclusive', async ({ page }) => {
  test.setTimeout(240_000)
  await open(page, 'hardware/firmware')
  // A file that is not a real image: the module or the service must refuse it.
  await page.getByTestId('fw-files').setInputFiles([srec('canboard-v5-9-0.srec')])
  await page.getByTestId('fw-update-CB-2').click()
  await page.getByTestId('confirm-go').click()
  await expect(page.getByTestId('fw-status-CB-2')).toContainText(/Failed|Link lost/, { timeout: 180_000 })
  await expect(page.getByTestId('fw-status-CB-2')).toContainText('stays in its bootloader and is safe')
  // the module must come back
  await waitFor(async () => (await deviceByName('CB-2')).connected, 120_000, 'CB-2 back on the bus')
})

test('firmware: update all over CAN with real release files @exclusive', async ({ page }) => {
  test.setTimeout(900_000)
  const dir = process.env.E2E_SREC_DIR
  test.skip(!dir, 'set E2E_SREC_DIR to a folder with the release .srec files')
  const fs = await import('node:fs'), path = await import('node:path')
  const names = fs.readdirSync(dir).filter((n) => /\.srec$/i.test(n))
  await open(page, 'hardware/firmware')
  await page.getByTestId('fw-files').setInputFiles(names.map((n) => path.join(dir, n)))
  const btn = page.getByTestId('fw-update-all')
  if (await btn.isEnabled()) {
    await btn.click()
    await page.getByTestId('confirm-go').click()
    await expect(page.getByTestId('fw-pause')).toBeVisible()
    await page.getByTestId('fw-pause').click()
    await expect(page.getByTestId('fw-pause')).toContainText('Will pause after this module')
    await expect(page.getByTestId('fw-pause')).toHaveCount(0, { timeout: 600_000 })
  }
  for (const d of await apiJson('GET', '/api/devices')) expect(d.connected).toBe(true)
})
