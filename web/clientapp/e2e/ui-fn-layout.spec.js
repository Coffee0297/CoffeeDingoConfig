// ui-fn: the function-block screens at phone width (390x844) and desktop (1440x900), light and dark: no sideways page
// scroll, the main heading on screen, and the Add-a-block dialog keeps keyboard focus inside and gives it back on Escape.
// Screenshots go to E2E_SHOTS (when set) for a look by eye. Read-only.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { deviceByName } from './api.js'

const SHOTS = process.env.E2E_SHOTS
const routes = async () => {
  const p4 = (await deviceByName('PDM-04')).guid
  return [['functions', 'Functions'], ['functions/add', 'Add a function'], [`functions/flow/${p4}`, 'PDM-04 · blocks'], ['functions/whole-car', null],
    [`hardware/module/${p4}/output/8`, null], ['live', null], ['expert/can?tab=dbc', null]]
}

for (const [w, h] of [[390, 844], [1440, 900]]) for (const theme of ['dark', 'light']) {
  test(`${w}px ${theme}: no sideways scroll, heading visible`, async ({ page }) => {
    test.setTimeout(180_000)
    const errors = watchErrors(page)
    await page.setViewportSize({ width: w, height: h })
    await page.addInitScript((t) => { try { localStorage.setItem('nxTheme', t) } catch {} }, theme)
    for (const [r, heading] of await routes()) {
      // phone width folds the Main navigation away, so not open(): wait for the live feed and the page
      await page.goto('/#/next/' + r)
      await expect(page.getByTestId('connection-pill')).toContainText(/live/i, { timeout: 20_000 })
      await expect(page.getByText('Loading…')).toHaveCount(0)
      if (heading) await expect(page.getByRole('heading', { level: 1, name: heading })).toBeInViewport()
      else await expect(page.getByRole('heading', { level: 1 }).first()).toBeInViewport()
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(over, `${r} scrolls sideways at ${w}px`).toBeLessThanOrEqual(1)
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${w}-${theme}-${r.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png` })
    }
    expect(errors).toEqual([])
  })
}

test('Add a block: focus moves into the dialog, Tab stays inside, Escape closes it and focus comes back', async ({ page }) => {
  const errors = watchErrors(page)
  const p4 = (await deviceByName('PDM-04')).guid
  await open(page, `functions/flow/${p4}`)
  const add = page.getByTestId('tool-add')
  await add.focus()
  await page.keyboard.press('Enter')
  const dlg = page.getByRole('dialog', { name: 'Add a block' })
  await expect(dlg).toBeVisible()
  const inDlg = () => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))
  await expect.poll(inDlg).toBe(true)
  for (let i = 0; i < 40; i++) { await page.keyboard.press('Tab'); expect(await inDlg()).toBe(true) }
  await page.keyboard.press('Escape')
  await expect(dlg).toHaveCount(0)
  await expect(add).toBeFocused()
  expect(errors).toEqual([])
})
