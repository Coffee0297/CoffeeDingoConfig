// Whole car canvas (functions/whole-car): read-only, so no writes.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { deviceByName } from './api.js'

test('every module on one canvas, links over CAN, a block opens its flow builder', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'functions/whole-car')
  await expect(page.getByRole('heading', { level: 1, name: 'Whole car' })).toBeVisible()
  const wc = page.getByTestId('whole-car')
  await expect(wc).toBeVisible({ timeout: 20_000 })
  for (const m of ['CB-1', 'CB-2', 'PDM-01', 'PDM-05']) await expect(wc.locator('.svelte-flow__node').filter({ hasText: m }).first()).toBeVisible()
  await expect(page.getByText(/\d+ signals travel over CAN/)).toBeVisible()
  // modules start collapsed to the blocks that talk over CAN; Expand all shows every block
  await page.getByTestId('wc-expand').click()
  await expect(page.getByTestId('wc-expand')).toHaveText('Collapse all')
  const cb1 = await deviceByName('CB-1')
  const blk = wc.locator(`.svelte-flow__node[data-id="${cb1.guid}#virtualinput:1"]`)
  await expect(blk).toContainText('Start button light')
  // Enter on a focused block opens it
  await blk.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`functions/flow/${cb1.guid}/virtualinput(%3A|:)1`))
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { level: 2 })).toHaveText('Start button light')
  await page.goBack()
  await expect(page.getByTestId('whole-car')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByTestId('whole-car')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Fit' }).click()
  expect(errors).toEqual([])
})
