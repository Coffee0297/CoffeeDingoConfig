// ui-mod: Lua editor at the 5.7 size limit (4,095 B). Writes PDM-05 only and puts its script back.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { API, apiJson } from './api.js'
import { safeGuid, backupLua, restoreLua, storedLua } from './f-helpers.js'

const sized = (n) => ('-- ui-mod size test ' + 'x'.repeat(n)).slice(0, n - 1) + '\n'
const pill = (page) => page.getByTestId('lua-pill')

test('a script over 4,095 B: Upload is off, and the backend refuses it without putting it in the project; 4,095 B uploads and reads back', async ({ page }) => {
  test.setTimeout(900_000)
  const errors = watchErrors(page)
  const g = await safeGuid()
  const original = await backupLua(g)
  try {
    await open(page, 'expert/lua/' + g)
    await page.getByTestId('lua-text').fill(sized(4096))
    await expect(page.getByText('Too big.')).toBeVisible()
    await expect(page.getByText('Upload is off until it fits.')).toBeVisible()
    await expect(page.getByTestId('lua-upload')).toBeDisabled()
    // a script or an assistant that posts it anyway: refused, and the project keeps the old one
    const r = await fetch(`${API}/api/devices/${g}/lua`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Source: sized(4096) }) })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toContain('stores at most 4,095. Nothing was saved or sent.')
    expect(await storedLua(g)).toBe(original)

    await page.getByTestId('lua-text').fill(sized(4095))
    await expect(page.getByText('Too big.')).toHaveCount(0)
    await expect(page.getByRole('meter')).toHaveAttribute('aria-valuenow', '4095')
    for (let i = 0; i < 3; i++) {   // the busy Sim bus can miss a chunk; the screen offers the upload again
      await page.getByTestId('lua-upload').click()
      await expect(pill(page)).toContainText(/Verified|Runtime error|Read-back mismatch|Upload failed/, { timeout: 300_000 })
      if (/Verified|Runtime error/.test((await pill(page).textContent()) ?? '')) break
    }
    await expect(pill(page)).toContainText(/Verified|Runtime error/)
    const live = await apiJson('GET', `/api/devices/${g}/lua`, undefined, 200_000)
    expect(live.live).toBe(true)
    expect(live.source).toBe(sized(4095))
  } finally { await restoreLua(g, original) }
  expect(errors).toEqual([])
})
