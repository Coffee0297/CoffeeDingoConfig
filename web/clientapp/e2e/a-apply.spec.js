// Apply panel (apply pill): which modules differ, Read, Apply to car (write), Store on modules (burn).
// Non-exclusive tests write only PDM-02, and never burn.
import { test, expect } from '@playwright/test'

// A write or read can be lost while another run is hammering the shared bus: try those again.
test.describe.configure({ retries: 1 })
import { open, watchErrors } from './helpers.js'
import { apiJson, devices, deviceByName, waitFor } from './api.js'
import { restoreConnection, ready } from './a-util.js'

const panel = (page) => page.getByRole('dialog', { name: 'Apply to car' })
async function openPanel(page) {
  await page.getByTestId('apply-pill').click()
  await expect(panel(page)).toBeVisible()
}
/** Make a module's controls visible: pending ones are cards, the others sit in the folded "no changes" list. */
async function reveal(page, name) {
  if (await panel(page).getByTestId('apply-' + name).count()) return panel(page).getByTestId('apply-' + name)
  await panel(page).getByTestId('apply-quiet').click()
  return panel(page).getByTestId('apply-quiet-' + name)
}

test('the pill and the panel list exactly the connected modules that differ', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  const devs = await devices()
  const pending = devs.filter((d) => d.connected && d.configMismatch)
  // written elsewhere and not stored (G3) is listed too: it still needs Store
  const unstored = devs.filter((d) => d.connected && d.storedOnModule === false)
  const listed = devs.filter((d) => pending.includes(d) || unstored.includes(d))
  const pill = page.getByTestId('apply-pill')
  // G2: saved edits held for Apply are counted first
  const waiting = devs.reduce((n, d) => n + (d.connected ? d.pendingEdits ?? 0 : 0), 0)
  if (waiting) await expect(pill).toContainText(`${waiting} change${waiting === 1 ? '' : 's'} waiting`)
  else if (pending.length) await expect(pill).toContainText(`${pending.length} module${pending.length === 1 ? '' : 's'} differ`)
  else if (unstored.length) await expect(pill).toContainText(`${unstored.length} not stored`)
  else await expect(pill).toContainText('Nothing to apply')
  await openPanel(page)
  for (const d of listed) await expect(panel(page).getByTestId('apply-' + d.name)).toBeVisible()
  const quiet = devs.filter((d) => d.connected && !listed.includes(d))
  if (quiet.length) await expect(panel(page).getByTestId('apply-quiet')).toContainText(listed.length ? `${quiet.length} more module` : quiet.length === 1 ? 'The module matches' : `All ${quiet.length} modules match`)
  else await expect(panel(page).getByTestId('apply-quiet')).toHaveCount(0)
  const unstoredNow = listed.filter((d) => d.storedOnModule === false)
  if (unstoredNow.length) await expect(panel(page).getByText(new RegExp(`${unstoredNow.length} modules? (is|are) written but not stored`)).first()).toBeVisible()
  else if (listed.length) await expect(panel(page).getByText(new RegExp(`${listed.length} modules? (may differ|is|are)`)).first()).toBeVisible()
  else await expect(panel(page).getByText('Nothing to apply.')).toBeVisible()
  // the three steps are named
  for (const s of ['Apply to car', 'Store on modules', 'Check']) await expect(panel(page).getByRole('list', { name: 'Steps' })).toContainText(s)
  expect(errors).toEqual([])
})

test('a module that differs shows its Read-found differences or says it has not been compared @exclusive', async ({ page }) => {
  await open(page, 'hardware')
  const pending = (await devices()).filter((d) => d.connected && d.configMismatch)
  test.skip(!pending.length, 'no module is flagged as differing right now')
  await openPanel(page)
  for (const d of pending) {
    const card = panel(page).getByTestId('apply-' + d.name)
    // written earlier but not stored: this session already sent it, so it has no diff to show
    if (d.pendingEdits === 0 && /Written, not stored/.test(await card.innerText())) continue
    await expect(card).toContainText(d.pendingEdits > 0 ? `${d.pendingEdits} change` : 'Not sent')
    if (d.pendingEdits > 0) {
      // G2: each saved edit is listed with what it was, what it is now, and an undo
      const rows = await apiJson('GET', `/api/devices/${d.guid}/pending`)
      await expect(card.getByTestId('apply-edit')).toHaveCount(rows.length)
    } else if (d.configDiffCount > 0) {
      const diff = await apiJson('GET', `/api/devices/${d.guid}/config-diff`)
      await expect(card.locator('.df')).toHaveCount(Math.min(6, diff.length))
    } else {
      await expect(card).toContainText('Not compared with the module yet.')
    }
    await expect(card).toContainText('○ Written')
    await expect(card).toContainText('○ Stored on module')
    await expect(card).toContainText('○ Not checked yet')
  }
})

test('Apply asks first, names the consequence, and Cancel sends nothing', async ({ page }) => {
  await ready('PDM-02')
  const errors = watchErrors(page)
  const before = (await deviceByName('PDM-02')).storedOnModule
  await open(page, 'hardware')
  await openPanel(page)
  const row = await reveal(page, 'PDM-02')
  await row.getByRole('button', { name: 'Apply PDM-02' }).click()
  const ask = panel(page).getByTestId('apply-confirm')
  await expect(ask).toContainText("Write the project's settings to 1 module now?")
  await expect(ask).toContainText('lost at power-off until you store them')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  // Store asks too, with a different warning
  await row.getByRole('button', { name: 'Store PDM-02' }).click()
  await expect(ask).toContainText("Store the current settings permanently in the flash of 1 module?")
  await ask.getByRole('button', { name: 'Cancel' }).click()
  // nothing was sent: PDM-02 is as it was (it may still be written from an earlier test, G3)
  await expect(panel(page).getByTestId('apply-PDM-02').getByText('Written, not stored')).toHaveCount(before === false ? 1 : 0)
  expect((await deviceByName('PDM-02')).storedOnModule).toBe(before)
  expect(errors).toEqual([])
})

test('Apply to car writes PDM-02 and then offers Store (nothing is stored)', async ({ page }) => {
  await ready('PDM-02')
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await openPanel(page)
  const row = await reveal(page, 'PDM-02')
  await row.getByRole('button', { name: 'Apply PDM-02' }).click()
  await panel(page).getByTestId('apply-confirm-yes').click()
  const card = panel(page).getByTestId('apply-PDM-02')
  await expect(card).toContainText(/Written, not stored|Refused|Failed/, { timeout: 60_000 })
  if ((await card.innerText()).includes('Failed')) {
    // the Sim sometimes never confirms a write: the panel must say so plainly and keep the module out of the "written" state
    await expect(card).toContainText("The module didn't confirm the write")
    await expect(card).toContainText('○ Written')
    await expect(panel(page).getByTestId('apply-store')).toHaveCount(0)
    return
  }
  await expect(card).toContainText('Written, not stored')
  await expect(card).toContainText('✓ Written')
  await expect(card).toContainText('○ Stored on module')
  // other modules written earlier and not stored are named alongside it
  await expect(panel(page).getByText(/PDM-02.* loses? these changes at power-off\./)).toBeVisible()
  // the second step is now the one to take
  await expect(panel(page).getByTestId('apply-store')).toContainText(/Store on modules \(\d+\)/)
  // the backend knows it too (G3): closing and reopening the panel, or another page, still shows it
  await waitFor(async () => (await deviceByName('PDM-02')).storedOnModule === false, 10_000, 'PDM-02 written, not stored')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('apply-pill')).toContainText(/differ|not stored/)
  await openPanel(page)
  await expect(panel(page).getByTestId('apply-PDM-02')).toContainText('Written, not stored')
  // step 1 is done once nothing else waits to be written; other modules may still differ
  await expect(panel(page).getByRole('list', { name: 'Steps' }).locator('li').first()).toHaveClass(/done|on/)
  expect(errors).toEqual([])
})

test('Read from one module reads it and reports whether it matches the project', async ({ page }) => {
  await ready('PDM-02')
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await openPanel(page)
  const row = await reveal(page, 'PDM-02')
  await row.getByRole('button', { name: 'Read PDM-02' }).click()
  await expect(panel(page).getByText(/Read 1 module\./)).toBeVisible({ timeout: 40_000 })
  await waitFor(async () => !(await deviceByName('PDM-02')).configMismatch, 15_000, 'read cleared the flag')
  expect(errors).toEqual([])
})

test('Done closes the panel when nothing differs', async ({ page }) => {
  await open(page, 'hardware')
  const pending = (await devices()).filter((d) => d.connected && (d.configMismatch || d.storedOnModule === false))
  test.skip(pending.length !== 0, 'something differs or is not stored; storing every module runs in the exclusive test')
  await openPanel(page)
  await expect(panel(page).getByText('Nothing to apply.')).toBeVisible()
  await panel(page).getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Close and Escape close the panel', async ({ page }) => {
  await open(page, 'hardware')
  await openPanel(page)
  await panel(page).getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await openPanel(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

// ----- whole-bus actions and burning: run alone ------------------------------------------------------

test('Apply to car for every module, then Store on modules, then the read-back check @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await openPanel(page)
  const pending = (await devices()).filter((d) => d.connected && d.configMismatch)
  test.skip(!pending.length, 'nothing differs, so there is no batch to apply')
  // a module an earlier test wrote but did not store has nothing left to write: only Store is offered for it
  if (await panel(page).getByTestId('apply-go').count() && await panel(page).getByTestId('apply-go').isEnabled()) {
    await panel(page).getByTestId('apply-go').click()
    await panel(page).getByTestId('apply-confirm-yes').click()
  }
  await expect(panel(page).getByTestId('apply-store').or(panel(page).getByRole('button', { name: 'Done' }))).toBeVisible({ timeout: 180_000 })
  for (const d of pending) await expect(panel(page).getByTestId('apply-' + d.name)).toContainText(/Written, not stored|Refused|Failed/)
  // Store the ones that were written
  if (await panel(page).getByTestId('apply-store').count()) {
    await panel(page).getByTestId('apply-store').click()
    await panel(page).getByTestId('apply-confirm-yes').click()
    await expect(panel(page).getByText(/stored and read back|Written, not stored/).first()).toBeVisible({ timeout: 240_000 })
    for (const d of pending) {
      const card = panel(page).getByTestId('apply-' + d.name)
      if ((await card.innerText()).includes('Refused')) continue
      await expect(card).toContainText('Stored', { timeout: 120_000 })
      await expect(card).toContainText('Read back')
      expect((await deviceByName(d.name)).storedOnModule).toBe(true)
    }
  }
  expect(errors).toEqual([])
})

test('Read from modules reads every listed module @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'hardware')
  await openPanel(page)
  await panel(page).getByTestId('apply-read').click()
  await expect(panel(page).getByText(/Read \d+ module/)).toBeVisible({ timeout: 180_000 })
  await waitFor(async () => (await devices()).every((d) => !d.connected || !d.configMismatch), 30_000, 'every module compared')
  expect(errors).toEqual([])
})

test('Stop after this module leaves the rest unchanged @exclusive', async ({ page }) => {
  await open(page, 'hardware')
  await openPanel(page)
  const pending = (await devices()).filter((d) => d.connected && d.configMismatch)
  test.skip(pending.length < 2, 'needs at least two modules that differ')
  await panel(page).getByTestId('apply-go').click()
  await panel(page).getByTestId('apply-confirm-yes').click()
  await panel(page).getByTestId('apply-stop').click()
  await expect(panel(page).getByText('Stopped. Modules not reached yet are unchanged.')).toBeVisible({ timeout: 120_000 })
})

test('With no connection the panel says programming is off and disables Apply @exclusive', async ({ page }) => {
  await open(page, 'hardware')
  try {
    await apiJson('POST', '/api/disconnect')
    await expect(page.getByTestId('connection-pill')).toContainText('Not connected', { timeout: 15_000 })
    await openPanel(page)
    await expect(panel(page).getByText('Programming is off')).toBeVisible()
    await expect(panel(page).getByText('Not connected. Connect first.')).toBeVisible()
    await expect(panel(page).getByRole('button', { name: /^Apply to car/ })).toBeDisabled()
  } finally { await restoreConnection() }
})

test('a saved edit in the redesign waits for Apply to car: counted, shown, and written by Apply (G2) @exclusive', async ({ page }) => {
  await ready('PDM-05')
  const errors = watchErrors(page)
  const d = await deviceByName('PDM-05')
  const out = d.outputs.find((o) => o.number === 1)
  const staged = (body) => fetch(`http://127.0.0.1:5000/api/devices/${d.guid}/outputconfig`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dingo-Stage': '1' }, body: JSON.stringify(body) }).then((r) => r.json())
  const limit = out.currentLimit === 7 ? 6 : 7
  try {
    const r = await staged({ Number: 1, CurrentLimit: limit })
    expect(r).toMatchObject({ ok: true, written: false, staged: true })
    // in the project, not on the module: counted as waiting
    await waitFor(async () => (await deviceByName('PDM-05')).pendingEdits >= 1, 5000, 'PDM-05 has a change waiting')
    expect((await deviceByName('PDM-05')).outputs.find((o) => o.number === 1).currentLimit).toBe(limit)
    await open(page, 'hardware')
    await expect(page.getByTestId('apply-pill')).toContainText(/change(s)? waiting/)
    await openPanel(page)
    const row = await reveal(page, 'PDM-05')
    await expect(panel(page).getByTestId('apply-PDM-05')).toContainText(/change(s)? waiting/)
    // item 7: the change itself is listed, old → new, and where it came from
    await expect(panel(page).getByTestId('apply-PDM-05')).toContainText(`Trips above`)
    await expect(panel(page).getByTestId('apply-PDM-05')).toContainText(`${limit} A`)
    await expect(panel(page).getByTestId('apply-PDM-05')).toContainText('this browser')
    // Read would replace it: asks first
    await row.getByRole('button', { name: 'Read PDM-05' }).click()
    await expect(panel(page).getByTestId('apply-confirm')).toContainText('replaced by what the modules have')
    await panel(page).getByTestId('apply-confirm').getByRole('button', { name: 'Cancel' }).click()
    // Apply writes it: nothing waits any more
    await row.getByRole('button', { name: 'Apply PDM-05' }).click()
    await panel(page).getByTestId('apply-confirm-yes').click()
    await waitFor(async () => (await deviceByName('PDM-05')).pendingEdits === 0, 60_000, 'PDM-05 written')
  } finally {
    await apiJson('POST', `/api/devices/${d.guid}/outputconfig`, { Number: 1, CurrentLimit: out.currentLimit })
  }
  expect(errors).toEqual([])
})
