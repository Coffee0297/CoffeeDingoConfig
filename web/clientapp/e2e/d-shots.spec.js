// Screenshots of every implementer-D screen (look at them: nothing clips or overlaps). Also a render smoke test.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'

test.use({ viewport: { width: 1600, height: 2000 } })
const SCREENS = [
  ['power', 'power'], ['power/ignition', 'ignition'], ['power/sleep', 'sleep'], ['power/roles', 'roles'],
  ['hardware/keypads', 'keypads'], ['hardware/firmware', 'firmware'],
]
for (const [path, name] of SCREENS) {
  test(`screen renders and screenshot: ${path}`, async ({ page }) => {
    const errors = watchErrors(page)
    await open(page, path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.waitForTimeout(2500)
    await page.screenshot({ path: `e2e-results/shots/d-${name}.png`, fullPage: true })
    expect(errors).toEqual([])
  })
}
