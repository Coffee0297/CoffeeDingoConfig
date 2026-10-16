// Cross-module functions screen (C3): list, create dialog, preview. Read-only against the modules: the list
// lives in the browser (seeded through localStorage here), the preview is computed in the page, and nothing
// is ever sent — the tests stop at the preview and cancel.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { deviceByName } from './api.js'

const SEED = 'c3-seed indicator'

/** Put one cross-module function in the browser's list before the app loads. */
async function seed(page) {
  const pdm1 = await deviceByName('PDM-01'), pdm2 = await deviceByName('PDM-02')
  const fn = { name: SEED, mode: 'rule', blink: true, blinkRateMs: 350, slot: 0,
    trigger: { guid: pdm1.guid, varIndex: 27, varName: 'Turn left' },
    targets: [{ guid: pdm2.guid, output: 8 }], clockMaster: '', clockBackup: '', luaByModule: {} }
  await page.addInitScript((list) => localStorage.setItem('dingoCrossFns', JSON.stringify(list)), [fn])
}
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('dingoCrossFns') || '[]'))

test.describe('cross-module functions', () => {
  test('reachable from the function list', async ({ page }) => {
    const errors = watchErrors(page)
    await open(page, 'functions')
    await page.getByTestId('cross-module-link').click()
    await expect(page).toHaveURL(/#\/next\/functions\/cross-module/)
    await expect(page.getByRole('heading', { level: 1, name: 'Cross-module functions' })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('lists functions, previews a new one, cancel keeps the list', async ({ page }) => {
    const errors = watchErrors(page)
    await seed(page)
    await open(page, 'functions/cross-module')

    // the existing function renders as a card with its trigger and output
    const card = page.getByTestId('cm-card').filter({ hasText: SEED })
    await expect(card).toBeVisible()
    await expect(card).toContainText('Turn left')
    await expect(card).toContainText('PDM-02 O8')
    await expect(card).toContainText('Native wiring')

    // create dialog
    await page.getByTestId('cm-new').click()
    const dlg = page.getByTestId('cm-editor')
    await expect(dlg).toBeVisible()
    await expect(page.getByTestId('cm-save')).toBeDisabled()   // no trigger, no output yet
    await page.getByTestId('cm-name').fill('c3-draft hazard')

    // trigger: any module's signal (searchable list)
    await page.getByTestId('cm-trigger').click()
    await page.getByRole('searchbox', { name: /Search Trigger signal/ }).fill('Hazard')
    await page.getByRole('option', { name: /^Hazard · PDM-01/ }).first().click()
    await expect(page.getByTestId('cm-trigger')).toContainText('Hazard · PDM-01')

    // one output on another module
    await page.getByTestId('cm-add-target').click()
    await page.getByTestId('cm-target-0').click()
    await page.getByRole('searchbox').fill('PDM-03 · O8')
    await page.getByRole('option', { name: /PDM-03 · O8/ }).first().click()
    await expect(page.getByTestId('cm-save')).toBeEnabled()

    // preview only: what each module gets (blink is on by default → PDM-01 keeps the time, PDM-03 follows)
    await page.getByTestId('cm-preview-btn').click()
    const pv = dlg.getByTestId('cm-preview')
    await expect(pv).toBeVisible()
    await expect(pv.getByTestId('cm-preview-module').filter({ hasText: 'PDM-01' })).toContainText(/flashes 350 ms on/)
    await expect(pv.getByTestId('cm-preview-module').filter({ hasText: 'PDM-03' })).toContainText(/follows the lamp state on CAN ID 0x/)

    // cancel: nothing saved, list unchanged
    await page.getByTestId('cm-cancel').click()
    await expect(dlg).toHaveCount(0)
    await expect(page.getByTestId('cm-card')).toHaveCount(1)
    expect((await stored(page)).map((f) => f.name)).toEqual([SEED])
    expect(errors).toEqual([])
  })

  test('check-and-send shows the preview first and can be cancelled', async ({ page }) => {
    const errors = watchErrors(page)
    await seed(page)
    await open(page, 'functions/cross-module')
    await page.getByTestId('cm-send').click()
    const dlg = page.getByTestId('cm-send-dialog')
    await expect(dlg.getByRole('heading', { name: 'What each module gets' })).toBeVisible()
    await expect(dlg.getByTestId('cm-preview-module').filter({ hasText: 'PDM-02' })).toContainText(/O8/)
    await page.getByTestId('cm-send-cancel').click()
    await expect(dlg).toHaveCount(0)
    expect(errors).toEqual([])
  })
})
