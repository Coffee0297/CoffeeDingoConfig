// Functions screens (C1): function list, add function (template picker) and the setup wizard, against the Sim.
// Writes only touch the spare outputs SP o8 and PDM-03 o8 (and spare inputs CB-2 DI6..DI7), and every test
// removes what it applied again (also in `finally`, through the backend's template remove).
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'
import { putOutput } from './b-helpers.js'

const PFX = 'c1-'
// The spare output o8 these tests drive: PDM-02's when it is spare (switched off, no input); the 5.7 Ranchero project has
// the Starter Relay there, so PDM-04's o8 stands in, and the hand-built function duplicated onto it is one of PDM-04's.
let SP = 'PDM-02', DUP = { fn: 'Low Beam', out: /low beam/i }
test.beforeAll(async () => {
  const o8 = (await deviceByName('PDM-02')).outputs.find((o) => o.number === 8)
  if (o8.enabled || o8.inputVal > 0) { SP = 'PDM-04'; DUP = { fn: 'Fuel Pump', out: /fuel pump/i } }
})

/** Remove every function this file applied, whatever state a failed test left. */
async function cleanup() {
  await new Promise((r) => setTimeout(r, 600))   // the page mirrors its list to the server a moment after a change
  const inst = (await apiJson('GET', '/api/templates/instances').catch(() => null)) ?? []
  for (const i of inst) if (String(i.name).startsWith(PFX)) {
    for (let k = 0; k < 5; k++) { try { await apiJson('POST', '/api/templates/remove', { id: i.id }, 120_000); break } catch { await new Promise((r) => setTimeout(r, 2000)) } }
  }
}
const outCfg = async (mod, n) => (await deviceByName(mod)).outputs.find((o) => o.number === n)
/** Put a CB-2 input back as it was (a remove that failed half-way can leave the pin switched on). */
const restoreIn = async (before) => { const d = await deviceByName('CB-2'); const { number, ...body } = before; await apiJson('POST', `/api/devices/${d.guid}/function/input/${number}`, body).catch(() => {}) }
const cbIn = async (n) => { const d = await deviceByName('CB-2'); return (await apiJson('GET', `/api/devices/${d.guid}/functions`)).digitalIn.find((x) => x.number === n) }
const instances = async () => (await apiJson('GET', '/api/templates/instances').catch(() => null)) ?? []
const row = (page, name) => page.locator('[data-testid=fn-row]').filter({ has: page.getByText(name, { exact: true }) })

/** Click Apply until the wizard shows its result. The shared bus sometimes drops a module's write confirmation:
 *  the app then rolls back and says so, and applying again is what a person would do. */
async function dismissToasts(page) {
  for (const b of await page.getByRole('button', { name: 'Dismiss message' }).all()) await b.click({ timeout: 2000 }).catch(() => {})
}
async function applyWizard(page) {
  for (let i = 0; i < 6; i++) {
    await dismissToasts(page)
    await page.getByTestId('wz-apply').dispatchEvent('click')   // toasts from other people's writes can sit on top of the button
    const done = page.getByTestId('wizard-result'), err = page.getByTestId('apply-error')
    await expect(done.or(err)).toBeVisible({ timeout: 150_000 })
    if (await done.isVisible()) return
  }
  throw new Error('Apply never completed')
}
/** Remove the selected function (panel button + confirm); try again when a module did not confirm. */
async function removeFn(page, name) {
  const panel = page.getByTestId('fn-panel')
  await expect(row(page, name)).toBeVisible({ timeout: 20_000 })   // the list loads after the wizard closes
  for (let i = 0; i < 6; i++) {
    if (await row(page, name).count() === 0) return
    await row(page, name).getByRole('button', { name: new RegExp(name) }).first().click()
    await dismissToasts(page)
    await panel.getByRole('button', { name: 'Remove' }).dispatchEvent('click')
    await page.getByTestId('confirm-remove').dispatchEvent('click')
    try { await expect(row(page, name)).toHaveCount(0, { timeout: 90_000 }); return } catch { /* a write was not confirmed: Remove again */ }
  }
  throw new Error('Remove never completed for ' + name)
}

async function pick(page, id, text, optionName) {
  await page.getByTestId(id).fill(text)
  await page.getByRole('option', { name: optionName ?? new RegExp(text.replace(/[-.]/g, '\\$&')) }).first().click()
}

test.describe('function list', () => {
  test('shows the car grouped by system, with live state and a kind on every row', async ({ page }) => {
    const errors = watchErrors(page)
    await open(page, 'functions')
    await expect(page.getByRole('heading', { level: 1, name: 'Functions' })).toBeVisible()
    await expect(page.getByTestId('fn-row').first()).toBeVisible()
    const n = await page.getByTestId('fn-row').count()
    expect(n).toBeGreaterThan(5)
    await expect(page.getByText(/^\d+ functions · \d+ on now$/)).toBeVisible()
    await expect(page.getByTestId('fn-breakdown')).toHaveAttribute('title', /On \d+ modules/)
    // every row names its kind and a state word
    for (const r of await page.getByTestId('fn-row').all()) {
      await expect(r.locator('.kind')).toHaveText(/FUNCTION BLOCK|HELPER|BLOCKS|CUSTOM CODE/)
      await expect(r.getByText(/^(ON( [\d.]+ A)?|off|tripped|disabled|not reported|no connection)$/)).toBeVisible()
    }
    // the live state matches the module: a row says "on" only when an output of it is on
    const low = row(page, 'Low Beam')
    const on = /^ON/.test((await low.locator('.st').innerText()).trim())
    const pdm = await deviceByName('PDM-02')
    expect(pdm.outputs[0].state === 'On').toBe(on)
    expect(errors).toEqual([])
  })

  test('chips, search and selection', async ({ page }) => {
    const errors = watchErrors(page)
    await open(page, 'functions')
    await expect(page.getByTestId('fn-row').first()).toBeVisible()   // the list loads after the page
    const total = await page.getByTestId('fn-row').count()
    // system chip
    await page.getByRole('button', { name: /^Lights/ }).click()
    await expect(page.getByRole('button', { name: /^Lights/ })).toHaveAttribute('aria-pressed', 'true')
    const lights = await page.getByTestId('fn-row').count()
    expect(lights).toBeGreaterThan(0); expect(lights).toBeLessThan(total)
    await expect(page.getByRole('heading', { name: 'LIGHTS' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'WIPERS' })).toHaveCount(0)
    // custom code chip: every row is custom code
    await page.getByRole('button', { name: /^Custom code/ }).click()
    for (const r of await page.getByTestId('fn-row').all()) await expect(r.locator('.kind')).toHaveText('CUSTOM CODE (LUA)')
    // on now chip: every row has an "on" state
    await page.getByRole('button', { name: /^On now/ }).click()
    for (const r of await page.getByTestId('fn-row').all()) await expect(r.locator('.st')).toHaveText(/^\s*ON\b/)
    await page.getByRole('button', { name: /^All/ }).click()
    expect(await page.getByTestId('fn-row').count()).toBe(total)
    // search by name, by pin and by module; unknown text shows the empty state
    await page.getByTestId('fn-search').fill('horn')
    await expect(page.getByTestId('fn-row')).toHaveCount(1)
    await page.getByTestId('fn-search').fill('J3-6 PDM-02')
    await expect(page.getByTestId('fn-row').first()).toBeVisible()
    await page.getByTestId('fn-search').fill('zzzz-nothing')
    await expect(page.getByText('Nothing matches')).toBeVisible()
    await page.getByTestId('fn-search').fill('')
    expect(await page.getByTestId('fn-row').count()).toBe(total)
    // select a row: the side panel follows
    await row(page, 'Horn').getByRole('button', { name: /Horn/ }).click()
    await expect(page.getByTestId('fn-panel').getByRole('heading', { name: 'Horn' })).toBeVisible()
    await row(page, 'Low Beam').getByRole('button', { name: /Low Beam/ }).click()
    await expect(page.getByTestId('fn-panel').getByRole('heading', { name: 'Low Beam' })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('hand-built functions open in the builder and have every action a template has', async ({ page }) => {
    const errors = watchErrors(page)
    await open(page, 'functions')
    await row(page, 'Low Beam').getByRole('button', { name: /Low Beam/ }).click()
    const panel = page.getByTestId('fn-panel')
    await expect(panel.getByText(/Built by hand/)).toBeVisible()
    for (const b of ['Duplicate', 'Disable function', 'Remove']) await expect(panel.getByRole('button', { name: new RegExp(b) })).toBeEnabled()
    expect(await panel.getByTestId('fn-simulate').getAttribute('href')).toMatch(/fn=Low\+Beam.*&sim=1$/)
    await expect(row(page, 'Low Beam').getByRole('switch')).toBeEnabled()
    // the row link and the panel button both open the function's own page: its outputs and what feeds them
    const pdm = await deviceByName('PDM-02')
    const link = row(page, 'Low Beam').getByRole('link', { name: /Open Low Beam in the flow builder/ })
    expect(await link.getAttribute('href')).toMatch(/#\/next\/functions\/flow\/[0-9a-f-]{36}\?fn=Low\+Beam&show=/)
    await link.dispatchEvent('click')
    await expect(page.getByTestId('fn-title')).toHaveText('Low Beam')
    const canvas = page.getByTestId('canvas')
    await expect(canvas.locator('.svelte-flow__node').first()).toBeVisible({ timeout: 15_000 })
    const mine = await canvas.locator('.svelte-flow__node').count()
    await expect(canvas.locator('.svelte-flow__node[data-id^="output:"]').first()).toBeVisible()
    // its other modules are one click away; "Show all" opens the whole module
    const mods = page.getByRole('group', { name: 'Where Low Beam runs' })
    if (await mods.count()) await expect(mods.getByRole('link')).not.toHaveCount(0)
    await page.getByTestId('fn-whole').click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('· blocks')
    await expect.poll(() => canvas.locator('.svelte-flow__node').count(), { timeout: 15_000 }).toBeGreaterThan(mine)
    await page.goBack(); await page.goBack()
    await row(page, 'Low Beam').getByRole('button', { name: /Low Beam/ }).click()
    await panel.getByRole('link', { name: 'Open in builder' }).dispatchEvent('click')
    await expect(page).toHaveURL(/#\/next\/functions\/flow\//)
    expect(pdm.guid).toBeTruthy()
    expect(errors).toEqual([])
  })

  test('+ Add function opens the picker', async ({ page }) => {
    const errors = watchErrors(page)
    await open(page, 'functions')
    await page.getByTestId('add-function').dispatchEvent('click')
    await expect(page).toHaveURL(/#\/next\/functions\/add$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Add a function' })).toBeVisible()
    expect(errors).toEqual([])
  })
})

test('a hand-built function: disable and enable it, duplicate it onto a spare output, remove the copy @exclusive', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  const p2 = await deviceByName(SP)
  const ARRS = { virtualInputs: 'virtualinput', conditions: 'condition', counters: 'counter', flashers: 'flasher', timers: 'timer', tables: 'table', maths: 'math' }
  const before = await apiJson('GET', `/api/devices/${p2.guid}/functions`)
  const outsBefore = JSON.parse(JSON.stringify(p2.outputs))
  const out = async (n) => (await deviceByName(SP)).outputs.find((o) => o.number === n)
  const panel = page.getByTestId('fn-panel')
  try {
    await open(page, 'functions')
    const low = row(page, DUP.fn)
    await low.getByRole('button', { name: new RegExp(DUP.fn) }).click()
    // disable: the outputs switch off; the row stays and says so; enable asks first
    await panel.getByRole('button', { name: 'Disable function' }).click()
    await expect(low.locator('.st')).toHaveText(/disabled/, { timeout: 30_000 })
    await panel.getByRole('button', { name: 'Enable function' }).click()
    await page.getByTestId('confirm-on').click()
    await expect(low.locator('.st')).not.toHaveText(/disabled/, { timeout: 30_000 })
    // duplicate onto the spare o8: copied blocks drive it, the original is untouched
    await panel.getByTestId('fn-duplicate').click()
    await page.getByTestId('dup-output').click()
    await page.getByRole('option', { name: new RegExp('^' + SP + ' · OUT8') }).click()
    await page.getByTestId('dup-name').fill('c1-low copy')
    await page.getByTestId('dup-go').click()
    await waitFor(async () => { const o = await out(8); return o.enabled && o.inputVal > 0 }, 30_000, 'o8 driven by the copy')
    const lowOut = outsBefore.find((o) => DUP.out.test(o.name))
    expect((await out(lowOut.number)).inputVal).toBe(lowOut.inputVal)
    const vars = await apiJson('GET', `/api/devices/${p2.guid}/inputs`)
    const o8in = (await out(8)).inputVal
    const drv = vars.find((v) => v.index === o8in)
    // a logic block driving it is copied into a new slot; an input or CAN input it reads is shared
    const orig = vars.find((v) => v.index === lowOut.inputVal)
    if (['virtualinput', 'condition', 'counter', 'flasher', 'timer', 'table', 'math'].includes(orig.kind)) expect([drv.kind, drv.number]).not.toEqual([orig.kind, orig.number])
    else expect(o8in).toBe(lowOut.inputVal)
    const copy = row(page, 'c1-low copy')
    await expect(copy).toBeVisible({ timeout: 30_000 })
    // remove the copy: o8 switched off and unwired, the original still runs
    await copy.getByRole('button', { name: /c1-low copy/ }).click()
    await panel.getByRole('button', { name: 'Remove' }).click()
    await page.getByTestId('confirm-remove').click()
    await expect(copy).toHaveCount(0, { timeout: 30_000 })
    await waitFor(async () => { const o = await out(8); return !o.enabled && !o.inputVal }, 30_000, 'o8 free again')
    expect((await out(lowOut.number)).inputVal).toBe(lowOut.inputVal)
  } finally {
    const now = await apiJson('GET', `/api/devices/${p2.guid}/functions`)
    for (const [arr, kind] of Object.entries(ARRS))
      for (const r of before[arr] ?? []) {
        const c = (now[arr] ?? []).find((x) => x.number === r.number)
        if (c && JSON.stringify(c) !== JSON.stringify(r)) await apiJson('POST', `/api/devices/${p2.guid}/function/${kind}/${r.number}`, r).catch(() => {})
      }
    const live = await deviceByName(SP)
    for (const o of outsBefore) {
      const c = live.outputs.find((x) => x.number === o.number)
      if (['enabled', 'inputVal', 'name'].some((k) => c?.[k] !== o[k])) await putOutput(p2.guid, o).catch(() => {})
    }
    await apiJson('POST', `/api/devices/${p2.guid}/writeall`, undefined, 60_000).catch(() => {})
  }
  expect(errors).toEqual([])
})

test.describe('add function', () => {
  test('cards, chips, search, badges and the disabled ones', async ({ page }) => {
    const errors = watchErrors(page)
    await open(page, 'functions/add')
    const cards = page.getByTestId('tpl-cards').locator('article[data-tpl]')
    const total = await cards.count()
    expect(total).toBe(22)   // every template in templates.js (the integration branch adds retryall, loadshed, reminder, pidfan)
    await expect(cards.first().getByText(/You need:/)).toBeVisible()
    await expect(page.locator('article[data-tpl=washwipe]').getByText('NEW')).toBeVisible()
    await expect(page.locator('article[data-tpl=headlights]').getByText('NEW')).toHaveCount(0)
    // chips filter the cards
    await page.getByRole('button', { name: /^Wipers/ }).click()
    await expect(cards).toHaveCount(3)
    await page.getByRole('button', { name: /^All/ }).click()
    await expect(cards).toHaveCount(total)
    // search
    await page.getByTestId('tpl-search').fill('fan')
    await expect(page.locator('article[data-tpl=radfan]')).toBeVisible()
    await expect(page.locator('article[data-tpl=headlights]')).toHaveCount(0)
    await page.getByTestId('tpl-search').fill('qqqq')
    await expect(page.getByText('No function matches')).toBeVisible()
    await page.getByTestId('tpl-search').fill('')
    // blank function is visibly not available; the ignition card opens the ignition setup (firmware 5.6)
    expect(await page.getByTestId('tpl-blank').getAttribute('href')).toMatch(/functions\/flow\/[0-9a-f-]{36}\?add=1$/)
    await expect(page.getByRole('link', { name: 'Ignition & start button' })).toHaveAttribute('href', /power\/ignition/)
    // a card opens the wizard
    await page.getByRole('link', { name: 'Headlights', exact: true }).click()
    await expect(page).toHaveURL(/#\/next\/functions\/setup\/headlights$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Headlights' })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('breadcrumb goes back to the list; an unknown template says so', async ({ page }) => {
    const errors = watchErrors(page)
    await open(page, 'functions/add')
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Functions' }).click()
    await expect(page).toHaveURL(/#\/next\/functions$/)
    await open(page, 'functions/setup/not-a-template')
    await expect(page.getByText('That function is not in the list')).toBeVisible()
    await page.getByRole('link', { name: 'Add a function' }).click()
    await expect(page).toHaveURL(/#\/next\/functions\/add$/)
    expect(errors).toEqual([])
  })
})

test.describe('setup wizard', () => {
  test('steps are gated, Back and Cancel work, nothing is written before Apply', async ({ page }) => {
    const errors = watchErrors(page)
    const before = JSON.stringify((await deviceByName(SP)).outputs[7])
    await open(page, 'functions/setup/simple')
    await expect(page.getByText('STEP 1 OF 3')).toBeVisible()
    await expect(page.getByTestId('wz-next')).toBeDisabled()
    await expect(page.getByTestId('step-issue')).toContainText('Pick: Output')
    await pick(page, 'pick-output', SP + ' o8', new RegExp(SP + ' · J3-3 OUT8'))
    await expect(page.getByTestId('wz-next')).toBeEnabled()
    await expect(page.getByTestId('wizard-sentence')).toContainText(SP)
    await page.getByTestId('wz-next').click()
    await expect(page.getByText('STEP 2 OF 3')).toBeVisible()
    await expect(page.getByTestId('wz-next')).toBeDisabled()
    await pick(page, 'pick-input', 'CB-2 DI6', /CB-2 · J3-6 DI6/)
    await expect(page.getByTestId('wizard-fits')).toContainText('Fits on ' + SP)
    await expect(page.getByTestId('wizard-preview')).toContainText('add a CAN input on ' + SP)
    await page.getByTestId('wz-back').click()
    await expect(page.getByText('STEP 1 OF 3')).toBeVisible()
    await page.getByRole('navigation', { name: 'Steps' }).getByRole('button', { name: /What drives it/ }).click()   // jump to a visited step
    await page.getByTestId('wz-next').click()
    await expect(page.getByTestId('drawings')).toBeVisible()
    await expect(page.getByRole('img', { name: 'Wiring diagram' })).toBeVisible()
    await expect(page.getByRole('img', { name: 'Signal links' })).toBeVisible()
    await expect(page.getByTestId('wz-apply')).toBeEnabled()
    await page.getByTestId('wz-cancel').click()
    await expect(page).toHaveURL(/#\/next\/functions$/)
    expect(JSON.stringify((await deviceByName(SP)).outputs[7])).toBe(before)
    expect((await instances()).filter((i) => i.name.startsWith(PFX))).toEqual([])
    expect(errors).toEqual([])
  })

  test('taking over an output that is in use asks first; Cancel changes nothing', async ({ page }) => {
    const errors = watchErrors(page)
    await open(page, 'functions/setup/simple')
    const before = JSON.stringify((await deviceByName('PDM-02')).outputs[6])
    await pick(page, 'pick-output', 'PDM-02 o7', /PDM-02 · J3-4 OUT7/)
    await expect(page.getByText('Already driven by something else')).toBeVisible()
    await page.getByTestId('wz-next').click()
    await pick(page, 'pick-input', 'CB-2 DI6', /CB-2 · J3-6 DI6/)
    await page.getByTestId('wz-next').click()
    await page.getByTestId('wz-apply').click()
    const dlg = page.getByRole('dialog', { name: /Take over an output that is in use/ })
    await expect(dlg).toBeVisible()
    await dlg.getByRole('button', { name: 'Cancel' }).click()
    await expect(dlg).toHaveCount(0)
    expect(JSON.stringify((await deviceByName('PDM-02')).outputs[6])).toBe(before)
    expect(errors).toEqual([])
  })

  test('settings step validates ranges; relay checkbox changes the drawing', async ({ page }) => {
    const errors = watchErrors(page)
    await open(page, 'functions/setup/afterrun')
    await expect(page.getByText('STEP 1 OF 4')).toBeVisible()
    await pick(page, 'pick-output', 'PDM-03 o8', /PDM-03 · J3-3 OUT8/)
    const relay = page.getByRole('checkbox', { name: /Via relay/ })
    await expect(relay).not.toBeChecked()   // a PDM output drives a fan directly: no relay by default
    await page.getByTestId('wz-next').click()
    await pick(page, 'pick-trig', 'CB-2 DI7', /CB-2 · J3-7 DI7/)
    await page.getByTestId('wz-next').click()
    await expect(page.getByText('STEP 3 OF 4')).toBeVisible()
    await page.getByTestId('set-hold').fill('4000000')
    await expect(page.getByTestId('step-issue')).toContainText('must be 0 to 3600000')
    await expect(page.getByTestId('wz-next')).toBeDisabled()
    await page.getByTestId('set-hold').fill('5000')
    await expect(page.getByTestId('wz-next')).toBeEnabled()
    await expect(page.getByTestId('wizard-sentence')).toContainText('Hold after off')
    await page.getByTestId('wz-next').click()
    await expect(page.getByText(/OUTPUTS/).first()).toBeVisible()
    await expect(page.getByTestId('drawings').getByText(/through a relay/)).toHaveCount(0)
    await page.getByTestId('wz-back').click(); await page.getByTestId('wz-back').click(); await page.getByTestId('wz-back').click()
    await page.getByRole('checkbox', { name: /Via relay/ }).click()
    await page.getByTestId('wz-next').click(); await page.getByTestId('wz-next').click(); await page.getByTestId('wz-next').click()
    await expect(page.getByTestId('drawings').getByText(/through a relay/)).toBeVisible()
    expect(errors).toEqual([])
  })

  test('apply builds the function, it shows in the list, turns off and on, duplicates, edits and is removed @exclusive', async ({ page }) => {
    test.setTimeout(600_000)
    const errors = watchErrors(page)
    const NAME = PFX + 'simple'
    const p2o8 = await outCfg(SP, 8)
    const p3o8 = await outCfg('PDM-03', 8)
    expect(p2o8.inputVal).toBe(0); expect(p3o8.inputVal).toBe(0)   // the spare outputs really are spare
    const di6 = await cbIn(6)
    try {
      // ---- apply on the spare o8, driven by CB-2 DI6
      await open(page, 'functions/setup/simple')
      await page.getByTestId('fn-name').fill(NAME)
      await pick(page, 'pick-output', SP + ' o8', new RegExp(SP + ' · J3-3 OUT8'))
      await page.getByTestId('wz-next').click()
      await pick(page, 'pick-input', 'CB-2 DI6', /CB-2 · J3-6 DI6/)
      await expect(page.getByTestId('now-input')).toContainText('switched on when you apply')
      await page.getByTestId('wz-next').click()
      await applyWizard(page)
      await expect(page.getByTestId('wizard-result')).toContainText(`“${NAME}” is built`)
      // the module really changed: output 8 follows a CAN input that decodes CB-2 DI6
      const o8 = await waitFor(async () => { const o = await outCfg(SP, 8); return o.inputVal > 0 && o }, 20_000, SP + ' output 8 wired')
      expect(o8.enabled).toBe(true)
      expect((await cbIn(6)).enabled).toBe(true)   // the pin it reads was switched on
      const inst = (await instances()).find((i) => i.name === NAME)
      expect(inst?.wired).toEqual([`${(await deviceByName(SP)).guid}:8`])

      // ---- the list shows it as a function block
      await page.getByTestId('result-done').click()
      await expect(page).toHaveURL(/#\/next\/functions$/)
      const r = row(page, NAME)
      await expect(r).toBeVisible()
      await expect(r.locator('.kind')).toHaveText('FUNCTION BLOCK')
      await expect(r.locator('.st')).toHaveText(/^\s*(off|ON [\d.]+ A)$/)
      await r.getByRole('button', { name: new RegExp(NAME) }).click()
      const panel = page.getByTestId('fn-panel')
      await expect(panel.getByRole('heading', { name: NAME })).toBeVisible()
      await expect(panel).toContainText('From template “Simple switched circuit”')
      await expect(panel.getByText(SP + ' o8')).toBeVisible()
      await expect(panel.getByRole('link', { name: 'Open in builder' })).toBeVisible()
      // the add picker now says it is in use
      await page.goto('/#/next/functions/add')
      await expect(page.locator('article[data-tpl=simple]').getByText('IN USE')).toBeVisible()
      await page.goBack()

      // ---- disable it (writes the output config), then enable again (asks first)
      await row(page, NAME).getByRole('button', { name: new RegExp(NAME) }).click()
      await panel.getByRole('button', { name: 'Disable function' }).click()
      await expect(row(page, NAME).locator('.st')).toHaveText('disabled', { timeout: 15_000 })
      expect((await outCfg(SP, 8)).enabled).toBe(false)
      await panel.getByRole('button', { name: 'Enable function' }).click()
      const on = page.getByRole('dialog', { name: /Enable/ })
      await on.getByRole('button', { name: 'Cancel' }).click()
      expect((await outCfg(SP, 8)).enabled).toBe(false)   // Cancel wrote nothing
      await row(page, NAME).getByRole('switch').click()           // the row switch asks as well
      await page.getByTestId('confirm-on').click()
      await expect(row(page, NAME).locator('.st')).toHaveText(/^\s*(off|ON [\d.]+ A)$/, { timeout: 15_000 })
      expect((await outCfg(SP, 8)).enabled).toBe(true)
      await row(page, NAME).getByRole('switch').click()           // and off again from the row
      await expect(row(page, NAME).locator('.st')).toHaveText('disabled', { timeout: 15_000 })
      await panel.getByRole('button', { name: 'Enable function' }).click()
      await page.getByTestId('confirm-on').click()
      await expect.poll(async () => (await outCfg(SP, 8)).enabled).toBe(true)

      // ---- duplicate: the wizard opens with the picks, a "copy" name and empty outputs; put the copy on PDM-03 o8
      await panel.getByRole('link', { name: 'Duplicate' }).click()
      await expect(page).toHaveURL(/setup\/simple\?from=/)
      await expect(page.getByTestId('fn-name')).toHaveValue(NAME + ' copy')
      await expect(page.getByTestId('wz-next')).toBeDisabled()       // outputs are empty
      await pick(page, 'pick-output', 'PDM-03 o8', /PDM-03 · J3-3 OUT8/)
      await page.getByTestId('wz-next').click()
      await page.getByTestId('wz-next').click().catch(() => {})
      // the logic moved to PDM-03: the CB-2 input reaches it over CAN, so the review adds a CAN input
      await expect(page.getByText(/add a CAN input on PDM-03 that reads CB-2/)).toBeVisible()
      await applyWizard(page)
      await waitFor(async () => (await outCfg('PDM-03', 8)).inputVal > 0, 20_000, 'PDM-03 output 8 wired')
      await page.getByTestId('result-done').click()
      await expect(row(page, NAME + ' copy')).toBeVisible()
      await expect(page.getByText(/\d+ functions · /)).toBeVisible()

      // ---- change settings (edit): the wizard opens filled in; applying again keeps one function
      await row(page, NAME).getByRole('button', { name: new RegExp(NAME) }).first().click()
      await panel.getByRole('link', { name: 'Change settings' }).click()
      await expect(page).toHaveURL(/setup\/simple\?edit=/)
      await expect(page.getByTestId('fn-name')).toHaveValue(NAME)
      await expect(page.getByTestId('pick-output')).toHaveValue(new RegExp(SP))
      await page.getByTestId('fn-name').fill(NAME + ' v2')
      await page.getByTestId('wz-next').click(); await page.getByTestId('wz-next').click()
      await applyWizard(page)
      await page.getByTestId('result-done').click()
      await expect(row(page, NAME + ' v2')).toBeVisible()
      await expect(row(page, NAME)).toHaveCount(0)
      expect((await instances()).filter((i) => i.name.startsWith(PFX)).length).toBe(2)
      expect((await outCfg(SP, 8)).inputVal).toBeGreaterThan(0)

      // ---- remove both: Cancel first, then confirm
      for (const nm of [NAME + ' v2', NAME + ' copy']) {
        await row(page, nm).getByRole('button', { name: new RegExp(nm) }).click()
        await panel.getByRole('button', { name: 'Remove' }).click()
        const dlg = page.getByRole('dialog', { name: /Remove/ })
        await dlg.getByRole('button', { name: 'Cancel' }).click()
        await expect(row(page, nm)).toBeVisible()
        await removeFn(page, nm)
      }
      // the outputs and the pin are back as they were
      await waitFor(async () => (await outCfg(SP, 8)).inputVal === 0 && (await outCfg('PDM-03', 8)).inputVal === 0, 20_000, 'outputs restored')
      expect((await cbIn(6)).enabled).toBe(di6.enabled)
      expect((await instances()).filter((i) => i.name.startsWith(PFX))).toEqual([])
    } finally {
      await cleanup()
      await restoreIn(di6)
    }
    expect(errors).toEqual([])
  })

  test('apply with settings: an after-run function builds a timer and is removed again @exclusive', async ({ page }) => {
    test.setTimeout(420_000)
    const errors = watchErrors(page)
    const NAME = PFX + 'afterrun'
    const pdm3 = await deviceByName('PDM-03')
    const timersBefore = (await apiJson('GET', `/api/devices/${pdm3.guid}/functions`)).timers.filter((t) => t.enabled).length
    const di7 = await cbIn(7)
    try {
      await open(page, 'functions/setup/afterrun')
      await page.getByTestId('fn-name').fill(NAME)
      await pick(page, 'pick-output', 'PDM-03 o8', /PDM-03 · J3-3 OUT8/)
      await expect(page.getByRole('checkbox', { name: /Via relay/ })).not.toBeChecked()
      await page.getByTestId('wz-next').click()
      await pick(page, 'pick-trig', 'CB-2 DI7', /CB-2 · J3-7 DI7/)
      await page.getByTestId('wz-next').click()
      await page.getByTestId('set-hold').fill('7000')
      await page.getByTestId('wz-next').click()
      await expect(page.getByTestId('wizard-preview')).toContainText('create a timer')
      await applyWizard(page)
      const t = await waitFor(async () => { const f = await apiJson('GET', `/api/devices/${pdm3.guid}/functions`); return f.timers.filter((x) => x.enabled).length > timersBefore && f.timers.find((x) => x.enabled && x.preset === 7000) }, 20_000, 'timer with the 7 s hold')
      expect(t.mode).toBe(1)   // off-delay
      await page.getByTestId('result-done').click()
      await removeFn(page, NAME)
      await waitFor(async () => (await apiJson('GET', `/api/devices/${pdm3.guid}/functions`)).timers.filter((x) => x.enabled).length === timersBefore, 20_000, 'timer removed')
      expect((await outCfg('PDM-03', 8)).inputVal).toBe(0)
    } finally {
      await cleanup()
      await restoreIn(di7)
    }
    expect(errors).toEqual([])
  })

  test('a combination the template cannot build says why and keeps Apply off', async ({ page }) => {
    const errors = watchErrors(page)
    const before = JSON.stringify([(await outCfg(SP, 8)), (await outCfg('PDM-03', 8))])
    await open(page, 'functions/setup/headlights')
    await pick(page, 'pick-lowL', 'PDM-03 o8', /PDM-03 · J3-3 OUT8/)
    await pick(page, 'pick-highL', SP + ' o8', new RegExp(SP + ' · J3-3 OUT8'))   // a high-beam output, but no high-beam switch below
    await page.getByTestId('wz-next').click()
    await pick(page, 'pick-low', 'CB-2 DI6', /CB-2 · J3-6 DI6/)
    await page.getByTestId('wz-next').click()
    await expect(page.getByText('STEP 3 OF 4')).toBeVisible()
    await page.getByTestId('wz-next').click()
    await expect(page.getByText('Cannot build this yet')).toBeVisible()
    await expect(page.getByText(/High-beam outputs need a high-beam switch/).first()).toBeVisible()
    await expect(page.getByTestId('wz-apply')).toBeDisabled()
    // fix it: add the high-beam switch (DI7) and the wizard lets go
    await page.getByTestId('wz-back').click(); await page.getByTestId('wz-back').click()
    await pick(page, 'pick-high', 'CB-2 DI7', /CB-2 · J3-7 DI7/)
    await page.getByTestId('wz-next').click(); await page.getByTestId('wz-next').click()
    await expect(page.getByText('Cannot build this yet')).toHaveCount(0)
    await expect(page.getByTestId('wz-apply')).toBeEnabled()
    await page.getByTestId('wz-cancel').click()   // nothing is applied
    expect(JSON.stringify([(await outCfg(SP, 8)), (await outCfg('PDM-03', 8))])).toBe(before)
    expect(errors).toEqual([])
  })
})
