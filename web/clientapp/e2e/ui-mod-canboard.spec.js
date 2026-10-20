// ui-mod: CANBoard pages on 5.7 — the two PID blocks (a third is not offered), applied and read back; the calibrated
// rotary switch counts its positions from 0; a digital input in PWM mode is applied and read back.
import { test, expect } from '@playwright/test'
import { watchErrors, open } from './helpers.js'
import { deviceByName, SIM_MCP, near } from './api.js'
import { fns, snapshot, restore, openFlow, addBlock, pickSource, insp, save, applyModule, readModule } from './ui-fn-helpers.js'

const sim = (name, args) => fetch(SIM_MCP, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })

test('CB-1 has two PID blocks: both are added and set, a third is not offered, Apply and Read bring them back @exclusive', async ({ page }) => {
  test.setTimeout(600_000)
  const errors = watchErrors(page)
  const snap = await snapshot('CB-1'), g = snap.guid
  try {
    await openFlow(page, 'CB-1')
    const used = (await fns(g)).pids.filter((x) => x.enabled).length
    const added = []
    for (let i = used; i < 2; i++) {
      const n = await addBlock(page, g, 'PID', 'pids')
      added.push(n)
      await pickSource(page, 'processInput', 'Headlights')
      await insp(page).getByLabel('Fixed setpoint').fill(String(1 + n))
      await insp(page).getByLabel('Kp').fill('1.5')
      await save(page)
    }
    // both used: the add dialog no longer offers a PID
    await page.getByTestId('tool-add').click()
    const dlg = page.getByRole('dialog', { name: 'Add a block' })
    await expect(dlg.getByTestId('add-PID')).toHaveCount(0).catch(async () => expect(dlg.getByTestId('add-PID')).toBeDisabled())
    await page.keyboard.press('Escape')
    await applyModule(page, 'CB-1')
    await readModule(page, 'CB-1')
    const pids = (await fns(g)).pids
    for (const n of added) {
      const r = pids.find((x) => x.number === n)
      expect(r.enabled).toBe(true)
      expect([near(r.setpoint, 1 + n), near(r.kp, 1.5)]).toEqual([true, true])
    }
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('the calibrated rotary switch on CB-1 shows the position the knob is at, counted from 0', async ({ page }) => {
  const errors = watchErrors(page)
  const g = (await deviceByName('CB-1')).guid
  await open(page, `hardware/module/${g}/input/analog/4`)   // Gear: P R N D 2 1
  try {
    for (const [i, name] of [[0, 'P'], [3, 'D'], [5, '1']]) {
      await sim('sim_rotary', { node: 'CB-1.ai4', index: i })
      await expect(page.getByText(new RegExp(`^Position ${i} · ${name} · `))).toBeVisible({ timeout: 30_000 })
    }
  } finally { await sim('sim_rotary', { node: 'CB-1.ai4', index: 0 }) }
  expect(errors).toEqual([])
})

test('a CB-2 digital input switched to PWM measurement is applied and read back, then put back @exclusive', async ({ page }) => {
  test.setTimeout(600_000)
  const errors = watchErrors(page)
  const cb = await deviceByName('CB-2')
  try {
    await open(page, `hardware/module/${cb.guid}/input/digital/5`)
    await page.getByText('PWM measurement').first().click()
    await page.getByLabel('Expected frequency (0 = find it, max 5000)').fill('9000')
    await expect(page.getByText('Expected frequency must be 0 to 5000 Hz.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Keep changes' })).toBeDisabled()
    await page.getByLabel('Expected frequency (0 = find it, max 5000)').fill('400')
    await page.getByRole('button', { name: 'Keep changes' }).click()
    await applyModule(page, 'CB-2')
    await readModule(page, 'CB-2')
    await page.reload()
    await expect(page.getByRole('radio', { name: /PWM measurement/ }).or(page.getByText('PWM measurement')).first()).toBeVisible()
    await expect(page.getByLabel('Expected frequency (0 = find it, max 5000)')).toHaveValue('400')
  } finally {
    await open(page, `hardware/module/${cb.guid}/input/digital/5`)
    await page.getByText('On / off switch').first().click()
    await page.getByRole('button', { name: 'Keep changes' }).click().catch(() => {})
    await applyModule(page, 'CB-2').catch(() => {})
  }
  expect(errors.filter((e) => !/40\d/.test(e))).toEqual([])
})
