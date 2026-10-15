// Expert > Lua scripts. Uploads go to PDM-05 only and PDM-05's own script is put back at the end.
// PDM-01 and PDM-02 (the car's showroom script) are never written.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, devices } from './api.js'
import { safeGuid, backupLua, restoreLua, storedLua, fakeTelemetry, mockJson } from './f-helpers.js'

const norm = (s) => s.replace(/\r\n/g, '\n')
// A script stored with CRLF keeps CRLF when it is uploaded from the editor (a textarea only holds LF).
const crlf = (s) => s.replace(/\n/g, '\r\n')
const TINY = '-- MCPVAL f test\nfunction onTick() end\nsetTickRate(50)\n'
const BAD_RUNTIME = 'function onTick()\n  local t = nil\n  t.x = 1\nend\nsetTickRate(50)\n'
const pill = (page) => page.getByTestId('lua-pill')
const text = (page) => page.getByTestId('lua-text')

// On the busy shared bus an upload sometimes does not verify the first time (the screen says so and offers
// "Upload again"); an operator would press it again, so the test does too.
async function uploadUntil(page, ok, timeout = 240_000) {
  for (let i = 0; i < 4; i++) {
    await page.getByTestId('lua-upload').dispatchEvent('click')
    await expect(pill(page)).toContainText(new RegExp(ok.source + '|Read-back mismatch|Upload failed'), { timeout })
    if (ok.test((await pill(page).textContent()) ?? '')) return
  }
  await expect(pill(page)).toContainText(ok)
}

test('lists every module with its script size and opens one', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'expert/lua')
  const list = page.getByTestId('lua-modules')
  const all = await devices()
  const pdms = all.filter((d) => /pdm/i.test(d.type))
  for (const d of pdms) {
    const src = await storedLua(d.guid)
    const row = list.getByRole('link', { name: new RegExp('^' + d.name) })
    await expect(row).toBeVisible()
    await expect(row).toContainText(src.trim() ? `${Buffer.byteLength(src).toLocaleString('en-US')} of 4,096 B` : 'No script')
  }
  await expect(page.getByText(/have no Lua|has no Lua/)).toContainText('CB-1')
  const pdm3 = pdms.find((d) => d.name === 'PDM-03')
  await list.getByRole('link', { name: /^PDM-03/ }).click()
  await expect(page).toHaveURL(new RegExp('#/next/expert/lua/' + pdm3.guid))
  const src = await storedLua(pdm3.guid)
  await expect(text(page)).toHaveValue(norm(src))
  await expect(page.getByRole('heading', { name: 'PDM-03' })).toBeVisible()
  await expect(page.getByRole('meter')).toHaveAttribute('aria-valuenow', String(Buffer.byteLength(src)))
  await expect(pill(page)).toContainText('Same as the project')
  // an unknown module id is explained, not a blank page
  await page.goto('/#/next/expert/lua/00000000-0000-0000-0000-000000000000')
  await expect(page.getByText('That module is not in this project')).toBeVisible()
  expect(errors).toEqual([])
})

test('check syntax marks the broken line; upload of a broken script asks first', async ({ page }) => {
  const errors = watchErrors(page)
  const g = await safeGuid()
  const before = await storedLua(g)
  await open(page, 'expert/lua/' + g)
  await expect(text(page)).toHaveValue(norm(before))
  await text(page).fill('local a = 1\nlocal x = = 2\n')
  await expect(pill(page)).toContainText('Edited, not on the module')
  await expect(page.getByTestId('lua-syntax')).toContainText('Line 2')
  await expect(page.locator('.ln[data-tone="fault"]')).toHaveCount(1)
  await page.getByTestId('lua-check').click()
  await expect(page.locator('[role=status],[role=alert]').filter({ hasText: /Line 2:/ }).first()).toBeVisible()
  await page.getByTestId('lua-upload').dispatchEvent('click')
  const dlg = page.getByRole('dialog')
  await expect(dlg).toContainText('The browser check found a mistake')
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(dlg).toHaveCount(0)
  expect(await storedLua(g)).toBe(before) // nothing was sent
  // a clean edit clears the mark
  await text(page).fill('local a = 1\n')
  await expect(page.getByTestId('lua-syntax')).toContainText('Syntax looks fine')
  await expect(page.locator('.ln[data-tone="fault"]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('uploading an empty script asks before removing the script', async ({ page }) => {
  const errors = watchErrors(page)
  const g = await safeGuid()
  const before = await storedLua(g)
  await open(page, 'expert/lua/' + g)
  await expect(text(page)).toHaveValue(norm(before))
  await text(page).fill('')
  await page.getByTestId('lua-upload').dispatchEvent('click')
  const dlg = page.getByRole('dialog')
  await expect(dlg).toContainText('Remove the script from PDM-05?')
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  expect(await storedLua(g)).toBe(before)
  expect(errors).toEqual([])
})

test('the module that does not verify is reported with a way to see the difference (mocked reply)', async ({ page }) => {
  const errors = watchErrors(page)
  const g = await safeGuid()
  const eol = (await storedLua(g)).includes('\r\n') ? '\r\n' : '\n'
  await open(page, 'expert/lua/' + g)
  await page.route(`**/api/devices/${g}/lua`, async (route) => {
    const r = route.request()
    if (r.method() === 'POST') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, written: false, error: "Lua upload didn't verify on the module (see Logs) — it keeps its previous program" }) })
    // live read: the module returns the script cut short after line 1
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'local a = 1' + eol, live: true }) })
  })
  await text(page).fill('local a = 1\nlocal b = 2\nlocal c = 3\n')
  await page.getByTestId('lua-upload').dispatchEvent('click')
  await expect(pill(page)).toContainText('Read-back mismatch')
  const steps = page.getByTestId('lua-steps')
  await expect(steps).toContainText('did not match')
  await expect(page.getByText('The module returned something different.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Upload again' })).toBeVisible()
  await page.getByTestId('lua-diff').click()
  await expect(page.getByText(/first difference is on line 2/i)).toBeVisible()
  await expect(page.locator('.ln[data-tone="warn"]')).toHaveCount(1)
  expect(errors).toEqual([])
})

test('an upload the backend refuses is reported as failed (mocked reply)', async ({ page }) => {
  const errors = watchErrors(page)
  const g = await safeGuid()
  await open(page, 'expert/lua/' + g)
  await page.route(`**/api/devices/${g}/lua`, (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'upload rejected (too big, or not a Lua-capable PDM)' }) })
    : route.fallback())
  await text(page).fill('local a = 1\n')
  await page.getByTestId('lua-upload').dispatchEvent('click')
  await expect(pill(page)).toContainText('Upload failed')
  await expect(page.getByText('The upload did not finish.')).toBeVisible()
  await expect(page.getByText('upload rejected (too big')).toBeVisible()
  expect(errors).toEqual([])
})

test('Sim adapter and a missing connection switch Upload off and say why (injected telemetry)', async ({ page }) => {
  const errors = watchErrors(page)
  const g = await safeGuid()
  await open(page, 'expert/lua/' + g)
  await expect(page.getByTestId('lua-upload')).toBeEnabled()
  await fakeTelemetry(page, { adapter: 'Sim' })
  await expect(pill(page)).toContainText('Sim adapter')
  await expect(page.getByTestId('lua-upload')).toBeDisabled()
  await expect(page.getByTestId('lua-upload')).toHaveAttribute('title', /Sim adapter/)
  await expect(page.getByText('Programming is disabled while the Sim adapter is active.')).toBeVisible()
  await page.getByRole('button', { name: 'Open Connect' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await fakeTelemetry(page, { adapter: null, connected: false })
  await expect(pill(page)).toContainText('Module not found')
  await expect(page.getByTestId('lua-upload')).toBeDisabled()
  await expect(page.getByTestId('lua-read')).toBeDisabled()
  await expect(page.getByText('did not answer.')).toBeVisible()
  expect(errors).toEqual([])
})

test('upload verifies on PDM-05, shows the module runtime error, reads back and restores the script', async ({ page }) => {
  test.setTimeout(900_000)
  const errors = watchErrors(page)
  const g = await safeGuid()
  const original = await backupLua(g)
  let restored = false
  const asStored = (s) => (original.includes('\r\n') ? crlf(s) : s)
  try {
    await open(page, 'expert/lua/' + g)
    await expect(text(page)).toHaveValue(norm(original))

    // 1. a script with a runtime fault: uploads and verifies, then the module reports the error
    await text(page).fill(BAD_RUNTIME)
    await expect(pill(page)).toContainText('Edited, not on the module')
    await uploadUntil(page, /Verified|Runtime error/)
    expect(await storedLua(g)).toBe(asStored(BAD_RUNTIME))
    await expect(pill(page)).toContainText('Runtime error', { timeout: 40_000 })
    await expect(page.getByTestId('lua-error')).toContainText('attempt to index a nil value')
    await expect(page.locator('.ln[data-tone="fault"]')).toHaveCount(1)
    await page.getByRole('button', { name: 'Go to line 3' }).click()
    const sel = await text(page).evaluate((t) => t.value.slice(t.selectionStart, t.selectionEnd))
    expect(sel).toBe('  t.x = 1')
    // the module really holds it
    const live = await apiJson('GET', `/api/devices/${g}/lua`, undefined, 150_000)
    expect(live.live).toBe(true)
    expect(live.source).toBe(asStored(BAD_RUNTIME))

    // 2. a good script: verified, the error goes away
    await text(page).fill(TINY)
    await uploadUntil(page, /Verified/)
    await expect(page.getByTestId('lua-steps')).toContainText('identical')
    await expect(page.getByText('Verified. The module has exactly this script.')).toBeVisible()
    expect(await storedLua(g)).toBe(asStored(TINY))
    await expect(page.getByRole('meter')).toHaveAttribute('aria-valuenow', String(Buffer.byteLength(asStored(TINY))))

    // 3. read from module: with edits in the editor it asks first
    await text(page).fill(TINY + '-- unsent edit\n')
    await page.getByTestId('lua-read').dispatchEvent('click')
    await expect(page.getByRole('dialog')).toContainText('Replace your edits?')
    await page.getByTestId('lua-confirm').dispatchEvent('click')
    await expect(page.locator('[role=status],[role=alert]').filter({ hasText: new RegExp(`Read ${Buffer.byteLength(asStored(TINY))} bytes from PDM-05`) }).first()).toBeVisible({ timeout: 150_000 })
    await expect(text(page)).toHaveValue(TINY)

    // 4. put the original back through the UI
    await text(page).fill(norm(original))
    // A full-size script on the busy shared bus sometimes does not verify the first time (the screen says so and offers
    // "Upload again"); an operator would press it, so the test does too.
    await uploadUntil(page, /Verified/)
    restored = (await storedLua(g)) === original // exact bytes; otherwise the API restore below puts them back
  } finally {
    if (!restored) await restoreLua(g, original)
    else expect(await storedLua(g)).toBe(original)
  }
  expect(errors).toEqual([])
})
