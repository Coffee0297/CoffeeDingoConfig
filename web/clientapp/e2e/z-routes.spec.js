// Cross-cutting checks over every screen: loads without errors, and passes axe (WCAG 2 A/AA) in both themes.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { devices } from './api.js'

const AXE = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js'

async function routes() {
  const ds = await devices()
  const pdm = ds.find((d) => /pdm/i.test(d.type)) ?? ds[0]
  const cb = ds.find((d) => /canboard/i.test(d.type)) ?? ds[0]
  return [
    'car', 'connect', 'functions', 'functions/add', 'functions/flow', `functions/flow/${pdm.guid}`, 'functions/whole-car',
    'power', 'power/ignition', 'power/sleep', 'power/roles',
    'hardware', `hardware/module/${pdm.guid}`, `hardware/module/${pdm.guid}/output/1`, `hardware/module/${cb.guid}/input/digital/1`,
    `hardware/module/${cb.guid}/input/analog/1`, `hardware/module/${pdm.guid}/input/can/1`,
    'hardware/outputs', 'hardware/keypads', 'hardware/firmware',
    'live', 'live/plot', 'live/trips', 'live/logs',
    'expert/lua', 'expert/can', 'expert/tools',
  ]
}

test('every screen loads without errors', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = watchErrors(page)
  for (const r of await routes()) {
    await open(page, r)
    await expect(page.getByRole('heading', { level: 1 }).first(), r).toBeVisible()
    await expect(page.getByText('This screen is being built'), r + ' is still a stub').toHaveCount(0)
    await expect(page.getByText('This screen failed to load'), r).toHaveCount(0)
  }
  expect(errors).toEqual([])
})

for (const theme of ['dark', 'light']) {
  test(`every screen passes axe (${theme})`, async ({ page }) => {
    test.setTimeout(300_000)
    await page.addInitScript((t) => { try { localStorage.setItem('nxTheme', t) } catch {} }, theme)
    const found = []
    for (const r of await routes()) {
      await open(page, r)
      await page.waitForTimeout(400)
      await page.addScriptTag({ url: AXE })
      const res = await page.evaluate(async () => {
        const out = await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'], rules: { 'meta-viewport': { enabled: false } } })
        return out.violations.map((v) => `${v.id} ×${v.nodes.length}: ${v.nodes[0]?.target?.join(' ')} — ${(v.nodes[0]?.failureSummary ?? '').split('\n')[1] ?? ''}`)
      })
      for (const v of res) found.push(`${r}: ${v}`)
    }
    expect(found).toEqual([])
  })
}
