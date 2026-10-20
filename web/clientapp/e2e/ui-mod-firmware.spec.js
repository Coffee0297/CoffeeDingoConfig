// ui-mod: Firmware page on the 5.7 line — the image's own board marker decides, a refused file says nothing was sent,
// an update keeps running across a page reload (and blocks a second one), a cut update is found in the bootloader and redone.
// Real updates need E2E_SREC_DIR (a canboard_v2.srec at another version than the modules run) and are @exclusive.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'
import { SIM_PORT } from './a-util.js'

// an S-record image at the 5.7 CANBoard app start 0x08002000 carrying the firmware's markers
function marked(board, version, pad = 1200) {
  const data = [...Buffer.from(`DINGO_FW=${version}\0DINGO_BOARD=${board}\0`), ...Array(pad).fill(0)]
  const rec = (addr, bytes) => {
    const b = [bytes.length + 5, (addr >>> 24) & 255, (addr >>> 16) & 255, (addr >>> 8) & 255, addr & 255, ...bytes]
    return 'S3' + [...b, ~b.reduce((a, x) => a + x, 0) & 255].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('')
  }
  const lines = []
  for (let o = 0; o < data.length; o += 16) lines.push(rec(0x08002000 + o, data.slice(o, o + 16)))
  return Buffer.from(lines.join('\n') + '\nS70508002000D2\n')
}
const SREC_DIR = process.env.E2E_SREC_DIR
const cbImage = SREC_DIR && fs.existsSync(`${SREC_DIR}/canboard_v2.srec`) ? `${SREC_DIR}/canboard_v2.srec` : null
const idle = async () => !(await apiJson('GET', '/api/flash-can/status')).busy

test('a CANBoard image named like a PDM file is offered to the CANBoards only, and the 5.7 PDMs have no bootloader tick box', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware/firmware')
  await expect(page.getByTestId('fw-openblt-PDM-02')).toHaveCount(0)   // the 5.7 line is always behind OpenBLT
  await page.getByTestId('fw-files').setInputFiles([{ name: 'dingopdm_v7.srec', mimeType: 'application/octet-stream', buffer: marked('Dingo Electronics CANBoard v2', '5.7.9') }])
  await expect(page.getByTestId('fw-file-list')).toContainText('fits CB-1, CB-2')
  await expect(page.getByTestId('fw-status-PDM-02')).toContainText(/No \.srec (or \.hex )?file for a dingoPDM/)
  await expect(page.getByTestId('fw-update-PDM-02')).toBeDisabled()
  await expect(page.getByTestId('fw-status-CB-2')).toHaveText('Ready: dingopdm_v7.srec')
  await expect(page.getByTestId('fw-update-CB-2')).toBeEnabled()
  expect(await idle()).toBe(true)
  expect(errors).toEqual([])
})

test('a file the app refuses before starting says nothing was sent, and the module keeps running @exclusive', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, 'hardware/firmware')
  // the markers and the address fit a CANBoard, but under 1 KB is no firmware: refused by its size before the module is touched
  const tiny = marked('Dingo Electronics CANBoard v2', '5.7.9', 0)
  await page.getByTestId('fw-files').setInputFiles([{ name: 'canboard_v2.srec', mimeType: 'application/octet-stream', buffer: tiny }])
  await page.getByTestId('fw-update-CB-2').click()
  await page.getByTestId('confirm-go').click()
  await expect(page.getByTestId('fw-status-CB-2')).toContainText('Nothing was sent: the module runs its firmware as before.', { timeout: 60_000 })
  expect((await deviceByName('CB-2')).connected).toBe(true)
})

test('an update keeps running when the page is reloaded, and the page then says so and offers no second one @exclusive', async ({ page }) => {
  test.skip(!cbImage, 'needs E2E_SREC_DIR with canboard_v2.srec')
  test.setTimeout(300_000)
  await open(page, 'hardware/firmware')
  await page.getByTestId('fw-files').setInputFiles([cbImage])
  await page.getByTestId('fw-update-CB-2').click()
  await page.getByTestId('confirm-go').click()
  await expect(page.getByTestId('fw-status-CB-2')).toContainText(/Writing · [1-9]/, { timeout: 60_000 })
  await page.reload()
  await expect(page.getByTestId('fw-blocked')).toContainText('An update over CAN is already running', { timeout: 15_000 })
  await expect(page.getByTestId('fw-update-all')).toBeDisabled()
  await waitFor(idle, 240_000, 'the update finished on the backend')
  await expect(page.getByTestId('fw-blocked')).toHaveCount(0, { timeout: 10_000 })
  await waitFor(async () => (await deviceByName('CB-2')).connected, 60_000, 'CB-2 back')
})

test('a cut update: the module waits in its bootloader, the scan finds it, and the update runs again from there @exclusive', async ({ page }) => {
  test.skip(!cbImage, 'needs E2E_SREC_DIR with canboard_v2.srec')
  test.setTimeout(420_000)
  await open(page, 'hardware/firmware')
  await page.getByTestId('fw-files').setInputFiles([cbImage])
  await page.getByTestId('fw-update-CB-2').click()
  await page.getByTestId('confirm-go').click()
  await expect(page.getByTestId('fw-status-CB-2')).toContainText(/Writing · [1-9]/, { timeout: 60_000 })
  try {
    await apiJson('POST', '/api/disconnect')   // the link drops mid-write
    await expect(page.getByTestId('fw-status-CB-2')).toContainText('stays in its bootloader and is safe', { timeout: 120_000 })
  } finally { await apiJson('POST', '/api/connect', { Adapter: 'SLCAN', Port: SIM_PORT, Bitrate: '500K' }) }
  await waitFor(async () => !(await deviceByName('CB-2')).connected, 30_000, 'CB-2 silent (in its bootloader)')
  await page.getByTestId('fw-bl-scan').click()
  await expect(page.getByTestId('fw-version-CB-2')).toHaveText('in bootloader', { timeout: 90_000 })
  await expect(page.getByTestId('fw-restart-CB-2')).toBeVisible()
  await page.getByTestId('fw-update-CB-2').click()
  await page.getByTestId('confirm-go').click()
  await expect(page.getByTestId('fw-status-CB-2')).toContainText('Done ✓', { timeout: 240_000 })
  await waitFor(async () => (await deviceByName('CB-2')).connected, 60_000, 'CB-2 runs its firmware again')
})
