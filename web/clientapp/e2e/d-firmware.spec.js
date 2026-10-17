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
  // every module's version known first: an unknown one counts as "needs the update" until it answers
  await page.getByTestId('fw-read-versions').click()
  await waitFor(async () => (await apiJson('GET', '/api/devices')).filter((x) => !/dbc/i.test(x.type)).every((d) => d.version), 30_000, 'every version known')
  await page.getByTestId('fw-files').setInputFiles(names.map((n) => path.join(dir, n)))
  const btn = page.getByTestId('fw-update-all')
  // the files are read and checked first: wait until every CAN module has a verdict, then look at the button
  await expect(page.locator('[data-testid^="fw-status-"]').filter({ hasText: 'Choose release files first' })).toHaveCount(0, { timeout: 15_000 })
  if (await btn.isEnabled()) {
    await btn.click()
    await page.getByTestId('confirm-go').click()
    await expect(page.getByTestId('fw-pause')).toBeVisible()
    await page.getByTestId('fw-pause').click()
    await expect(page.getByTestId('fw-pause')).toContainText('Will pause after this module')
    await expect(page.getByTestId('fw-pause')).toHaveCount(0, { timeout: 600_000 })
    // the updated module runs the new firmware: it reports the files' version (asked again until it does: a module
    // reboots after an update, the Sim restarts its emulation for it)
    const done = (await page.locator('[data-testid^="fw-status-"]').filter({ hasText: 'Done' }).first().getAttribute('data-testid')).replace('fw-status-', '')
    const want = 'v' + names[0].match(/v(\d+)-(\d+)-(\d+)\./).slice(1).join('.')
    await waitFor(async () => {
      const d = await deviceByName(done)
      if (d.connected) await apiJson('POST', `/api/devices/${d.guid}/version`).catch(() => {})
      await new Promise((r) => setTimeout(r, 3000))
      return (await deviceByName(done)).version === want
    }, 300_000, `${done} reports ${want}`)
  }
  // every module answers again (one may still be rebooting from the test before)
  await waitFor(async () => (await apiJson('GET', '/api/devices')).filter((x) => !/dbc/i.test(x.type)).every((d) => d.connected), 240_000, 'every module answering')   // the Sim restarts to boot updated firmware
})

test('firmware: the release list loads a release\'s files through the backend and checks each image (G7)', async ({ page }) => {
  test.setTimeout(180_000)
  const errors = watchErrors(page)
  const r = await fetch('http://127.0.0.1:5000/api/firmware/releases').then((x) => x.json()).catch(() => null)
  test.skip(!r?.releases?.length, 'no release list: GitHub not reachable and none saved')
  // the page picks the newest proper release by version number
  const num = (v) => v.split('.').map(Number)
  const newer = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false }
  const rel = r.releases.filter((x) => !x.prerelease).reduce((best, x) => (!best || newer(x.version, best.version) ? x : best), null) ?? r.releases[0]
  await open(page, 'hardware/firmware')
  await expect(page.getByTestId('fw-release')).toBeVisible()
  await page.getByText(`What is new in ${rel.version}`).click()
  await expect(page.getByTestId('fw-notes')).toContainText(rel.notes.trim().split('\n')[0].trim().slice(0, 30))
  await expect(page.getByTestId('fw-release')).toContainText(rel.version)
  const use = page.getByTestId('fw-use-release')
  // older than what the modules run: the button says Downgrade and asks first (it only loads the files)
  const down = /^Downgrade/.test((await use.innerText()).trim())
  await use.click()
  if (down) {
    const dlg = page.getByRole('dialog', { name: /^Downgrade to/ })
    await expect(dlg).toContainText('older')
    await dlg.getByTestId('confirm-go').click()
  }
  const list = page.getByTestId('fw-file-list')
  await expect(list).toBeVisible({ timeout: 120_000 })
  // a .srec per board kind in the project, and the .bin for the PDMs
  const devs = await apiJson('GET', '/api/devices')
  const kinds = new Set(devs.map((d) => (/canboard/i.test(d.type) ? 'CANBoard' : /max/i.test(d.type) ? 'dingoPDM-Max' : 'dingoPDM')))
  const want = rel.images.filter((i) => kinds.has(i.board) && (i.kind === 'srec' || i.board !== 'CANBoard'))
  await expect(list.locator('li')).toHaveCount(want.length)
  // each image was checked: the PDM .srec fits the dingoPDMs of the project
  const pdmSrec = want.find((i) => i.board === 'dingoPDM' && i.kind === 'srec')
  if (pdmSrec) await expect(list.locator('li').filter({ hasText: pdmSrec.name })).toContainText(devs.find((d) => d.type === 'dingoPDM').name)
  await expect(page.getByTestId('fw-check-problem')).toHaveCount(0)
  // the images are kept on this PC now
  const again = await apiJson('GET', '/api/firmware/releases')
  expect(again.releases.find((x) => x.tag === rel.tag).images.filter((i) => want.some((w) => w.name === i.name)).every((i) => i.cached)).toBe(true)
  expect(errors).toEqual([])
})

test('firmware: the image check names an image without a board marker (G7)', async () => {
  const body = 'S00F000068656C6C6F202020202000003C\nS1130000000102030405060708090A0B0C0D0E0F74\nS9030000FC\n'
  const c = await fetch('http://127.0.0.1:5000/api/firmware/check?name=dingopdm_v7_FW_v5-5-112.srec', { method: 'POST', body }).then((x) => x.json())
  expect(c.board).toBe('dingoPDM'); expect(c.version).toBe('5.5.112'); expect(c.kind).toBe('srec')
  expect(c.problems.join(' ')).toMatch(/no board marker/)
  expect(c.modules.length).toBeGreaterThan(0)
})

// Sim module reset through the Sim's MCP endpoint (cleanup only)
async function simReset(module) {
  await fetch('http://127.0.0.1:8787/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'sim_renode', arguments: { cmd: 'reset', module } } }) }).catch(() => {})
}

test('firmware: a module waiting in its bootloader is found, shown and restarted (G9) @exclusive', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = watchErrors(page)
  const cb = await deviceByName('CB-1')
  try {
    await apiJson('POST', `/api/devices/${cb.guid}/bootloader?can=true`)   // the CAN-update entry: OpenBLT waits for a tool
    // the Sim plays OpenBLT (its server/vblt.js): the module is held there until the tool restarts it
    const stays = await waitFor(async () => !(await deviceByName('CB-1')).connected, 8_000, 'CB-1 left its firmware').then(() => true, () => false)
    test.skip(!stays, 'the Sim does not keep a module in its OpenBLT bootloader')
    await open(page, 'hardware/firmware')
    await page.getByTestId('fw-bl-scan').click()
    await expect(page.getByTestId('fw-bl-result')).toContainText('In the bootloader: CB-1', { timeout: 30_000 })
    await expect(page.getByTestId('fw-version-CB-1')).toHaveText('in bootloader')
    expect((await deviceByName('CB-1')).inBootloader).toBe(true)
    await page.getByTestId('fw-restart-CB-1').click()
    await waitFor(async () => (await deviceByName('CB-1')).connected, 30_000, 'CB-1 runs its firmware again')
    await expect(page.getByTestId('fw-version-CB-1')).not.toHaveText('in bootloader')
    expect((await deviceByName('CB-1')).inBootloader).toBe(false)
  } finally {
    if (!(await deviceByName('CB-1')).connected) { await simReset('CB-1'); await waitFor(async () => (await deviceByName('CB-1')).connected, 60_000, 'CB-1 back after a Sim reset') }
  }
  expect(errors).toEqual([])
})

test('firmware: the bootloader scan asks only silent modules and says what it found (G9)', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware/firmware')
  await page.getByTestId('fw-bl-scan').click()
  const devs = await apiJson('GET', '/api/devices')
  const silent = devs.filter((d) => !d.connected && d.canBootloader)
  await expect(page.getByTestId('fw-bl-result')).toHaveText(silent.length ? /none in the bootloader|In the bootloader/ : 'Every module is answering. None is in its bootloader.', { timeout: 30_000 })
  // nothing that answers is called a bootloader
  expect(devs.filter((d) => d.connected && d.inBootloader)).toEqual([])
  expect(errors).toEqual([])
})
