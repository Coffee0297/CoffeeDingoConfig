// Power & ignition, Ignition, Output roles, Sleep & wake.
// Safe targets: sleep SETTINGS on CB-2 only (restored in `finally`). Anything that sleeps modules or writes the
// PDMs' sleep settings is @exclusive. Ignition setup and roles (firmware 5.6) write every module: @exclusive, undone at the end.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, devices, waitFor } from './api.js'

// Sleep writes can wait for the module's confirm (up to ~10 s when the bus is busy).
test.use({ actionTimeout: 45_000 })

async function pick(page, testid, label) {
  await page.getByTestId(testid).click()
  await page.getByRole('option', { name: label, exact: false }).first().click()
}

test('power home: modules, roles, sleep status, links', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'power')
  await expect(page.getByRole('heading', { level: 1, name: 'Power & ignition' })).toBeVisible()
  const rows = page.getByTestId('power-modules').locator('tbody tr')
  await expect(rows).toHaveCount((await devices()).filter((d) => !/dbc/i.test(d.type)).length)   // modules; an ECU (DBC) has no power state
  await expect(page.getByTestId('power-modules').locator('tr[data-module="CB-2"]')).toContainText('Awake')
  await expect(page.getByTestId('power-modules').locator('tr[data-module="PDM-01"]')).toContainText(/Own auto-sleep|Stays awake|Master|Follower|sleep input/)
  await expect(page.getByTestId('ignition-gap')).toContainText(/not set up yet|runs the ignition/)
  if (await page.getByTestId('ignition-setup').count()) await expect(page.getByTestId('ignition-setup')).toHaveAttribute('href', /power\/ignition/)
  // shut-down order editor: opens seeded, ↑/↓ swap modules but keep the time slots; Cancel writes nothing
  await page.getByTestId('edit-sequence').click()
  const dlg = page.getByRole('dialog', { name: 'Shut-down order' })
  const items = dlg.getByTestId('seq-order').locator('li')
  await expect(items).toHaveCount((await devices()).filter((d) => /pdm|canboard/i.test(d.type)).length - 1)
  const nameOf = async (k) => (await items.nth(k).getByRole('button', { name: /^Move .* down$/ }).getAttribute('aria-label')).replace(/^Move | down$/g, '')
  const first = await nameOf(0), second = await nameOf(1)
  await dlg.getByRole('button', { name: 'Move ' + first + ' down' }).click()
  await expect(items.nth(0)).toContainText(second)
  await expect(items.nth(1)).toContainText(first)
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await expect(dlg).toBeHidden()
  await page.getByRole('link', { name: 'Sleep settings', exact: true }).click()
  await expect(page).toHaveURL(/#\/next\/power\/sleep/)
  await page.goBack()
  await page.getByRole('link', { name: 'Edit ignition setup' }).click()
  await expect(page).toHaveURL(/#\/next\/power\/ignition/)
  expect(errors).toEqual([])
})

test('power home: the power-down timeline is read from the modules\' own sleep blocks', async ({ page }) => {
  const errors = watchErrors(page)
  const pdm = await deviceByName('PDM-01')
  // The Sim has no sequence set up: feed the screen the blocks the old designer writes, without touching a module.
  await page.route(`**/api/devices/${pdm.guid}/functions`, async (route) => {
    const r = await route.fetch(), j = await r.json()
    const tm = (name, s) => ({ name, enabled: true, preset: s * 1000 })
    j.timers = [...(j.timers ?? []), tm('Sleep · off delay', 30), tm('Sleep · quiet CAN', 28), tm('Sleep · hold outputs', 5), tm('Sleep · shutdown frame', 15)]
    j.canOutputs = [...(j.canOutputs ?? []), { name: 'Sleep · shutdown frame', enabled: true, id: 0x5aa, interval: 500 }]
    await route.fulfill({ response: r, json: j })
  })
  await open(page, 'power')
  const tl = page.getByTestId('power-timeline')
  await expect(tl).toBeVisible()
  await expect(page.getByTestId('sequence-source')).toContainText('PDM-01')
  await expect(tl).toContainText('Quiet bus')
  await expect(tl).toContainText('Asleep')
  await expect(page.getByTestId('power-rules')).toContainText('0x5AA')
  await expect(page.getByTestId('power-rules')).toContainText('every 500 ms for 15 s')
  await expect(page.getByTestId('power-rules')).toContainText('All modules sleep 30 s after ignition off')
  await expect(page.getByTestId('power-modules').locator('tr[data-module="PDM-01"]')).toContainText('Master: sends the shutdown frame')
  await page.getByRole('link', { name: 'Open sleep settings' }).click()
  await expect(page).toHaveURL(/#\/next\/power\/sleep/)
  expect(errors).toEqual([])
})

test('ignition: the setup is editable on firmware 5.6 and the rules follow the mode', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'power/ignition')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('How is the car started?')
  await expect(page.getByTestId('ignition-banner')).toContainText(/Ignition is not set up|runs the ignition/)
  await expect(page.getByTestId('ign-main')).toBeEnabled()
  await expect(page.getByTestId('ignition-rules')).toContainText('Ignition switch on')
  // the switch picker lists other modules' signals too, found with the list's search box (nothing is saved)
  await page.getByTestId('ign-switch').click()
  await page.getByRole('searchbox').fill('over CAN')
  await expect(page.getByRole('option', { name: /· (CB|PDM)-\d+ \(over CAN/ }).first()).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  // the two times are − / + steppers (nothing is saved until Save)
  await page.getByRole('button', { name: 'More Seconds of cranking at most' }).click()
  await expect(page.getByTestId('ign-crank')).toHaveValue(/\d/)
  await expect(page.getByRole('button', { name: 'Less Seconds the dash stays on' })).toBeVisible()
  await page.getByRole('radio', { name: /Start button only/ }).check()
  await expect(page.getByTestId('ignition-rules')).toContainText('Press while running')
  await expect(page.getByTestId('ign-switch')).toHaveCount(0)              // button only: no ignition switch
  await page.getByRole('radio', { name: /Key switch/ }).check()
  await expect(page.getByTestId('ignition-rules')).toContainText('Key at START')
  await page.getByTestId('ignition-next').click()
  await expect(page).toHaveURL(/#\/next\/power\/roles/)
  await page.goBack()
  await page.getByTestId('ignition-cancel').click()
  await expect(page).toHaveURL(/#\/next\/power$/)
  expect(errors).toEqual([])
})

test('output roles: every output is listed with a role picker (firmware 5.6)', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'power/roles')
  const pdms = (await devices()).filter((d) => /pdm/i.test(d.type))
  const total = pdms.reduce((n, d) => n + d.outputs.length, 0)
  const selects = page.locator('select[data-testid^="role-"]')
  await expect(selects).toHaveCount(total)
  await expect(page.getByTestId('role-PDM-04-o8')).toBeEnabled()
  await expect(page.getByTestId('roles-PDM-04').locator('li')).toHaveCount(pdms.find((d) => d.name === 'PDM-04').outputs.length)
  await expect(page.getByTestId('roles-conflicts')).toContainText(/No conflicts|Starter/)
  await expect(page.getByRole('region', { name: 'Roles at a glance' })).toContainText(/used by \d+/)
  await expect(page.getByTestId('roles-unused-none')).toContainText('Set all unused to None')
  await expect(page.getByText('own rule', { exact: false })).toHaveCount(0)   // it is called Custom now
  await page.getByRole('link', { name: 'Back to ignition setup' }).click()
  await expect(page).toHaveURL(/#\/next\/power\/ignition/)
  expect(errors).toEqual([])
})

test('sleep & wake: shows the real per-module settings and live status', async ({ page }) => {
  const errors = watchErrors(page)
  const devs = await devices()
  await open(page, 'power/sleep')
  const pdms = devs.filter((d) => d.canSleep !== false)
  // Simple card mirrors the PDMs
  const allOn = pdms.every((d) => d.sleepEnabled)
  await expect(page.getByTestId('sleep-auto')).toHaveAttribute('aria-checked', String(allOn))
  await expect(page.getByTestId('sleep-seconds')).toHaveValue(String(Math.round(pdms[0].sleepTimeoutMs / 1000)))
  await expect(page.getByTestId('sleep-sentence')).toContainText(allOn ? /goes to sleep \d+ s after nothing is in use/ : /Automatic sleep is off/)
  // Wake matrix: PDM has 2 DIs, CANBoard 8; CANBoards (no sleep in this firmware) are locked with the reason
  const m = page.getByTestId('wake-matrix')
  const pdm = devs.find((d) => d.name === 'PDM-02')
  await expect(m.locator('tr[data-module="PDM-02"] input[type=checkbox]')).toHaveCount(2 + 1)
  await expect(m.locator('tr[data-module="PDM-02"] .dash')).toHaveCount(6)
  await expect(page.getByTestId('wake-PDM-02-di1')).toBeChecked({ checked: !!(pdm.wakeDigInputMask & 1) })
  await expect(page.getByTestId('wake-PDM-02-can')).toBeChecked({ checked: pdm.wakeOnCan })
  await expect(m.locator('tr[data-module="CB-2"] input[type=checkbox]')).toHaveCount(8 + 1)
  const cb = devs.find((d) => d.name === 'CB-2')
  if (cb.canSleep === false) {
    await expect(page.getByTestId('wake-CB-2-di1')).toBeDisabled()
    await expect(m.locator('tr[data-module="CB-2"]')).toContainText("No sleep in this firmware")
  }
  // Live status
  await expect(page.getByTestId('sleep-banner')).toContainText(/Awake: \d+ of \d+ modules answer/)
  await expect(page.getByTestId('sleep-live').locator('tbody tr')).toHaveCount(devs.filter((d) => !/dbc/i.test(d.type)).length)   // modules, not an ECU
  await expect(page.getByTestId('sleep-live').locator('tr[data-module="CB-2"]')).toContainText('Awake')
  // firmware 5.6 reports what last woke each module
  await expect(page.getByTestId('sleep-live').locator('tr[data-module="PDM-01"] [data-testid=last-wake]')).toHaveText(/power-on|CAN traffic|digital input|USB/, { timeout: 10_000 })
  // Why card reads the bus
  await expect(page.getByTestId('why-verdict')).not.toHaveText('', { timeout: 15_000 })
  await expect(page.getByTestId('why-list')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('why-list')).toContainText(/output/)
  expect(errors).toEqual([])
})

test('sleep & wake: mute-transmit input of CB-2 changes and is restored', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = watchErrors(page)
  const cb = await deviceByName('CB-2')
  const orig = cb.muteTxInput
  try {
    await open(page, 'power/sleep')
    await pick(page, 'sleep-custom-module', 'CB-2')
    await expect(page.getByTestId('sleep-input')).toBeDisabled() // a CANBoard without sleep has no sleep input
    await expect(page.getByText("This board's firmware has no sleep, so it has no sleep input.")).toBeVisible()
    const sigs = (await apiJson('GET', `/api/devices/${cb.guid}/inputs?type=bool&inUse=true`)).filter((s) => s.kind !== 'sys')
    const origName = sigs.find((s) => s.index === orig)?.name
    // clear it (no confirmation needed to clear)
    await pick(page, 'mute-input', 'No driver')
    await waitFor(async () => (await deviceByName('CB-2')).muteTxInput === 0, 30_000, 'mute cleared')
    await expect(page.getByTestId('sleep-custom-status')).toContainText('mute-transmit input cleared')
    // choose a signal: asks first, Cancel leaves it
    const other = sigs.find((s) => s.index !== orig)
    await page.getByTestId('mute-input').click()
    await page.getByRole('option', { name: other.name, exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('stops sending its cyclic frames')
    await expect(page.getByRole('dialog')).toContainText('If it goes wrong')
    await page.getByTestId('confirm-cancel').click()
    expect((await deviceByName('CB-2')).muteTxInput).toBe(0)
    // put the original back through the dialog
    if (origName) {
      await page.getByTestId('mute-input').click()
      await page.getByRole('option', { name: origName, exact: true }).click()
      await page.getByTestId('confirm-go').click()
      await waitFor(async () => (await deviceByName('CB-2')).muteTxInput === orig, 30_000, 'mute restored')
    }
  } finally {
    await apiJson('POST', `/api/devices/${cb.guid}/device-inputs`, { muteTxInput: orig }).catch(() => {})
  }
  expect((await deviceByName('CB-2')).muteTxInput).toBe(orig)
  expect(errors).toEqual([])
})

test('sleep & wake: Sleep now asks first and Cancel leaves every module awake', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, 'power/sleep')
  const awakeBefore = (await devices()).filter((d) => d.connected && d.canSleep !== false).map((d) => d.name)
  await page.getByTestId('sleep-now').click()
  const dlg = page.getByRole('dialog')
  await expect(dlg).toContainText('Put the car to sleep now?')
  await expect(dlg).toContainText('If it goes wrong')
  await expect(dlg).toContainText(`asks ${awakeBefore.length} module`)
  await page.getByTestId('confirm-cancel').click()
  await expect(dlg).toHaveCount(0)
  await expect(page.getByTestId('sleep-result')).toHaveCount(0)
  // Cancel sent nothing: whoever was answering still answers
  const after = (await devices()).filter((d) => d.connected).map((d) => d.name)
  for (const n of awakeBefore) expect(after).toContain(n)
  expect(errors).toEqual([])
})

test('sleep & wake: simple settings write to the PDMs and are restored @exclusive', async ({ page }) => {
  test.setTimeout(420_000)
  const errors = watchErrors(page)
  const before = (await devices()).filter((d) => d.canSleep !== false).map((d) => ({ guid: d.guid, name: d.name, t: d.sleepTimeoutMs, e: d.sleepEnabled, i: d.sleepIgnoreAlwaysOn }))
  const restore = async () => { for (const b of before) { await apiJson('POST', `/api/devices/${b.guid}/writeparam`, { Index: 0, Sub: 5, Value: b.t }).catch(() => {}); await apiJson('POST', `/api/devices/${b.guid}/writeparam`, { Index: 0, Sub: 9, Value: b.i ? 1 : 0 }).catch(() => {}); await apiJson('POST', `/api/devices/${b.guid}/writeparam`, { Index: 0, Sub: 2, Value: b.e ? 1 : 0 }).catch(() => {}) } }
  try {
    await open(page, 'power/sleep')
    // seconds: never leave the car on a 1 s timer: use 20 s, then back
    await page.getByTestId('sleep-seconds').fill('20')
    await page.getByTestId('sleep-seconds').blur()
    await waitFor(async () => (await devices()).filter((d) => d.canSleep !== false).every((d) => d.sleepTimeoutMs === 20000), 120_000, 'timeout 20 s on all PDMs')
    await expect(page.getByTestId('sleep-sentence')).toContainText('20 s')
    await page.getByTestId('sleep-seconds').fill(String(Math.round(before[0].t / 1000)))
    await page.getByTestId('sleep-seconds').blur()
    await waitFor(async () => (await devices()).filter((d) => d.canSleep !== false).every((d) => d.sleepTimeoutMs === before.find((b) => b.guid === d.guid).t), 120_000, 'timeout restored')
    // ignore always-on
    await page.getByTestId('sleep-ignore').click()
    await waitFor(async () => (await devices()).filter((d) => d.canSleep !== false).every((d) => d.sleepIgnoreAlwaysOn !== before[0].i), 120_000, 'ignore flipped')
    await page.getByTestId('sleep-ignore').click()
    await waitFor(async () => (await devices()).filter((d) => d.canSleep !== false).every((d) => d.sleepIgnoreAlwaysOn === before.find((b) => b.guid === d.guid).i), 120_000, 'ignore restored')
    // automatic sleep off and on
    await page.getByTestId('sleep-auto').click()
    await waitFor(async () => (await devices()).filter((d) => d.canSleep !== false).every((d) => d.sleepEnabled !== before[0].e), 120_000, 'auto flipped')
    await page.getByTestId('sleep-auto').click()
    await waitFor(async () => (await devices()).filter((d) => d.canSleep !== false).every((d) => d.sleepEnabled === before.find((b) => b.guid === d.guid).e), 120_000, 'auto restored')
  } finally { await restore() }
  expect(errors).toEqual([])
})

test('sleep & wake: wake matrix writes a wake input and CAN activity, then restores @exclusive', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  const pdm = await deviceByName('PDM-05')
  const restore = async () => {
    await apiJson('POST', `/api/devices/${pdm.guid}/writeparam`, { Index: 0, Sub: 12, Value: pdm.wakeDigInputMask }).catch(() => {})
    await apiJson('POST', `/api/devices/${pdm.guid}/writeparam`, { Index: 0, Sub: 13, Value: pdm.wakeOnCan ? 1 : 0 }).catch(() => {})
  }
  try {
    await open(page, 'power/sleep')
    const di2 = page.getByTestId('wake-PDM-05-di2'), can = page.getByTestId('wake-PDM-05-can')
    const had = !!(pdm.wakeDigInputMask & 2)
    await di2.setChecked(!had)
    await waitFor(async () => !!((await deviceByName('PDM-05')).wakeDigInputMask & 2) === !had, 60_000, 'DI2 wake flipped')
    await expect(page.getByTestId('wake-status')).toContainText('DI2')
    await di2.setChecked(had)
    await waitFor(async () => !!((await deviceByName('PDM-05')).wakeDigInputMask & 2) === had, 60_000, 'DI2 wake restored')
    await can.setChecked(!pdm.wakeOnCan)
    await waitFor(async () => (await deviceByName('PDM-05')).wakeOnCan === !pdm.wakeOnCan, 60_000, 'CAN wake flipped')
    await can.setChecked(pdm.wakeOnCan)
    await waitFor(async () => (await deviceByName('PDM-05')).wakeOnCan === pdm.wakeOnCan, 60_000, 'CAN wake restored')
  } finally { await restore() }
  expect(errors).toEqual([])
})

test('sleep & wake: Sleep now puts the modules to sleep and Wake up brings them back @exclusive', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  await open(page, 'power/sleep')
  await page.getByTestId('sleep-now').click()
  await page.getByTestId('confirm-go').click()
  await expect(page.getByTestId('sleep-result')).toContainText(/Sleep sent to \d+ module/)
  await page.waitForTimeout(8000)
  await page.getByTestId('wake-up').click()
  await expect(page.getByTestId('sleep-result')).toContainText(/Wake up sent to \d+ module/)
  await waitFor(async () => (await devices()).every((d) => d.connected), 120_000, 'every module back on the bus')
  expect(errors).toEqual([])
})

test('ignition on PDM-01 with the others following: live state, a Starter role, then all off @exclusive', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = watchErrors(page)
  const all = (await devices()).filter((d) => /pdm|canboard/i.test(d.type))
  const p1 = all.find((d) => d.name === 'PDM-01'), p4 = all.find((d) => d.name === 'PDM-04')
  const ign = async (d) => (await apiJson('GET', `/api/devices/${d.guid}/functions`)).ignition
  const o8 = p4.outputs.find((o) => o.number === 8)
  const ciBefore = (await apiJson('GET', `/api/devices/${p1.guid}/functions`)).canInputs.filter((c) => c.enabled).map((c) => c.number)
  try {
    await open(page, 'power/ignition')
    await pick(page, 'ign-main', 'PDM-01')
    await page.getByRole('radio', { name: /Ignition switch \+ start button/ }).check()
    await pick(page, 'ign-switch', 'Always On')                      // ignition on as soon as it is saved
    // start button: a signal on another module; Save links it to a CAN input on PDM-01
    await page.getByTestId('ign-start').click()
    await page.getByRole('searchbox').fill('over CAN')
    await page.getByRole('option', { name: /\(over CAN\)$/ }).first().click()
    await page.getByTestId('ignition-save').click()
    await waitFor(async () => { const g = await ign(p1); return g.enabled && g.role === 0 && g.ignitionInput === 1 && g.startInput > 0 }, 30_000, 'PDM-01 main')
    const startIdx = (await ign(p1)).startInput
    const startVar = (await apiJson('GET', `/api/devices/${p1.guid}/inputs`)).find((v) => v.index === startIdx)
    expect(startVar.kind).toBe('caninput')
    // the page saves to the project; Apply to car sends it (G2): write every module now
    for (const d of all) await apiJson('POST', `/api/devices/${d.guid}/write`).catch(() => {})
    for (const d of all.filter((x) => x.guid !== p1.guid)) await waitFor(async () => { const g = await ign(d); return g.enabled && g.role === 1 && g.mainStateId === p1.baseId + 30 }, 30_000, d.name + ' follows')
    // PDM-01 sends its state frame: the backend and the screens show it
    await waitFor(async () => { const d = await deviceByName('PDM-01'); return d.ignition?.live && d.ignition.state === 'on' }, 15_000, 'ignition state on')
    await open(page, 'power')
    await expect(page.getByTestId('ignition-gap')).toContainText('PDM-01 runs the ignition. Now: Ignition.')
    // a role: PDM-04 o8 = Starter (follows Cranking)
    await open(page, 'power/roles')
    await page.getByTestId('role-PDM-04-o8').selectOption('Starter')
    const vars = await apiJson('GET', `/api/devices/${p4.guid}/inputs`)
    const cranking = vars.find((v) => v.kind === 'ignition' && v.prop === 'Cranking').index
    await waitFor(async () => (await deviceByName('PDM-04')).outputs.find((o) => o.number === 8).inputVal === cranking, 20_000, 'o8 follows Cranking')
    await expect(page.getByTestId('role-PDM-04-o8')).toHaveValue('Starter')
  } finally {
    await apiJson('POST', `/api/devices/${p4.guid}/outputconfig`, { Number: 8, Input: o8.inputVal, Enabled: o8.enabled }).catch(() => {})
    for (const d of all) await apiJson('POST', `/api/devices/${d.guid}/function/ignition/1`, { enabled: false, role: 0, mainStateId: 0, ignitionInput: 0, startInput: 0 }).catch(() => {})
    for (const c of (await apiJson('GET', `/api/devices/${p1.guid}/functions`)).canInputs.filter((c) => c.enabled && !ciBefore.includes(c.number)))
      await apiJson('POST', `/api/devices/${p1.guid}/function/caninput/${c.number}`, { enabled: false }).catch(() => {})
    for (const d of all) await apiJson('POST', `/api/devices/${d.guid}/write`).catch(() => {})
  }
  expect(errors).toEqual([])
})

test('ignition signals as rules: NOT engine running, a number above 300 OR a switch; read back, then all off @exclusive', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = watchErrors(page)
  const p1 = await deviceByName('PDM-01')
  const fns = () => apiJson('GET', `/api/devices/${p1.guid}/functions`)
  const before = await fns()
  const vmap = await apiJson('GET', `/api/devices/${p1.guid}/inputs`)
  const byIdx = (i) => vmap.find((v) => v.index === i)
  try {
    await open(page, 'power/ignition')
    await pick(page, 'ign-main', 'PDM-01')
    await page.getByRole('radio', { name: /Ignition switch \+ start button/ }).check()
    await pick(page, 'ign-switch', 'Always On')
    await page.getByTestId('ign-start').click()
    await page.getByRole('option').nth(2).click()
    // engine running = NOT a signal
    await page.getByTestId('ign-running').click()
    await page.getByRole('option').nth(3).click()
    await page.getByTestId('ign-running-not').click()
    // crank allowed = a number is above 300 OR a switch
    await page.getByTestId('ign-allow').click()
    await page.getByRole('searchbox').fill('(number)')
    await page.getByRole('option', { name: /\(number\)$/ }).first().click()
    await page.getByTestId('ign-allow-val').fill('300')
    await page.getByTestId('ign-allow-or').click()
    await page.getByTestId('ign-allow-b').click()
    await page.getByRole('option').nth(2).click()
    await page.getByTestId('ignition-save').click()
    await waitFor(async () => (await fns()).ignition?.enabled, 30_000, 'ignition saved')
    const f = await fns()
    const vi = (idx) => f.virtualInputs.find((x) => x.number === byIdx(idx)?.number && byIdx(idx)?.kind === 'virtualinput')
    const run = vi(f.ignition.runningInput)
    expect(run.name).toBe('Ign Running')
    expect([run.not0, run.not1, run.var0 === run.var1]).toEqual([true, true, true])
    const allow = vi(f.ignition.crankAllowInput)
    expect([allow.name, allow.cond0]).toEqual(['Ign Crank OK', 1])
    const cmp = f.conditions.find((x) => byIdx(allow.var0)?.kind === 'condition' && x.number === byIdx(allow.var0).number)
    expect([cmp.name, cmp.operator, cmp.arg]).toEqual(['Ign Crank OK A', 2, 300])
    // the page reads the rules back
    await open(page, 'power/ignition')
    await pick(page, 'ign-main', 'PDM-01')
    await expect(page.getByTestId('ign-running-not')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('ign-allow-val')).toHaveValue('300')
    await expect(page.getByTestId('ign-allow-b')).toBeVisible()
  } finally {
    const now = await fns()
    // the followers too: Save made every 5.6 module follow PDM-01
    for (const d of (await devices()).filter((x) => /pdm|canboard/i.test(x.type)))
      await apiJson('POST', `/api/devices/${d.guid}/function/ignition/1`, { enabled: false, role: 0, mainStateId: 0, ignitionInput: 0, startInput: 0, crankAllowInput: 0, runningInput: 0 }).catch(() => {})
    for (const [arr, kind] of [['conditions', 'condition'], ['virtualInputs', 'virtualinput']])
      for (const x of now[arr]) {
        const was = before[arr].find((y) => y.number === x.number)
        if (JSON.stringify(was) !== JSON.stringify(x)) await apiJson('POST', `/api/devices/${p1.guid}/function/${kind}/${x.number}`, was).catch(() => {})
      }
    await apiJson('POST', `/api/devices/${p1.guid}/writeall`, undefined, 60_000).catch(() => {})
  }
  expect(errors).toEqual([])
})
