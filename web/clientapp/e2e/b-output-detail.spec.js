// Output detail (hardware/module/<guid>/output/<n>). Config writes use PDM-05 out 1 and out 8 only; every test restores them.
import { test, expect } from '@playwright/test'
import { near } from './api.js'
import { open, watchErrors } from './helpers.js'
import { deviceByName, outputOf, withOutput, putOutput, stepper, pickSelect, saveAndWait, waitFor, apiJson } from './b-helpers.js'

test.describe.configure({ timeout: 120_000 })

const out = (n) => outputOf('PDM-05', n)
async function openOut(page, n) {
  const d = await deviceByName('PDM-05')
  await open(page, `hardware/module/${d.guid}/output/${n}`)
  await expect(page.getByTestId('save')).toBeVisible()
  return d
}

test('header shows name, pin, live state and working links', async ({ page }) => {
  const errors = watchErrors(page)
  const d = await openOut(page, 8)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Spare|.+/)
  await expect(page.getByText(/OUT 8\s*·\s*J3-3/)).toBeVisible()
  await expect(page.getByTestId('out-state')).toContainText(/Off|On/)
  await expect(page.getByRole('link', { name: 'Open in flow builder' })).toHaveAttribute('href', `#/next/functions/flow/${d.guid}`)
  // Graph it opens the Plot with this output's current on it
  await page.getByRole('link', { name: 'Graph it' }).click()
  await expect(page).toHaveURL(new RegExp(`#/next/live/plot[?]signal=out%3A${d.guid}%3A8`))
  await expect(page.getByText('Opened from Graph it.')).toBeVisible()
  await expect(page.getByText(/Output 8 current|Spare/).first()).toBeVisible()
  await page.goBack()
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Outputs' }).click()
  await expect(page).toHaveURL(/#\/next\/hardware\/outputs$/)
  expect(errors).toEqual([])
})

test('breadcrumb module link opens the module', async ({ page }) => {
  const d = await openOut(page, 8)
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'PDM-05' }).click()
  await expect(page).toHaveURL(new RegExp(`#/next/hardware/module/${d.guid}$`))
})

test('graph, trip summary and module limits are shown', async ({ page }) => {
  await openOut(page, 8)
  await expect(page.getByRole('img', { name: /Current over the last 60 seconds/ })).toBeVisible()
  await expect(page.getByTestId('peak')).toContainText('peak')
  await expect(page.getByTestId('trips')).toContainText(/trip|Trip log/, { timeout: 30_000 })
  await expect(page.getByRole('link', { name: 'Open the trip log' })).toHaveAttribute('href', /live\/trips/)
  await expect(page.getByText(/OUT8 is rated\s*8 A/)).toBeVisible()
  // the driver chip comes from the board facts in /api/definitions (G21): dingoPDM v7 o8 is a BTS7008-2EPA channel
  const def = (await apiJson('GET', '/api/definitions')).pdms.find((p) => p.typeName === 'dingoPDM')
  await expect(page.getByTestId('out-driver')).toHaveText(def.board.drivers[7])
  expect(def.board.drivers[7]).toBe('BTS7008-2EPA')
})

test('protection: steppers, summary, revert and rating guard', async ({ page }) => {
  const errors = watchErrors(page)
  const { o } = await out(8)
  await openOut(page, 8)
  const lim = stepper(page, 'Trips above')
  await expect(lim.input).toHaveValue(String(o.currentLimit))
  await expect(page.getByTestId('save')).toBeDisabled()
  await lim.less.click()
  await expect(lim.input).toHaveValue(String(o.currentLimit - 0.5))
  await expect(page.getByTestId('protection-summary')).toContainText(`${o.currentLimit - 0.5} A`)
  await expect(page.getByTestId('save-status')).toContainText('not kept yet')
  await expect(page.getByTestId('save')).toBeEnabled()
  await page.getByRole('button', { name: 'Revert' }).dispatchEvent('click')
  await expect(lim.input).toHaveValue(String(o.currentLimit))
  await expect(page.getByTestId('save-status')).toContainText('No changes')
  // above the rating of the pin: refused with a reason, Save stays off
  await lim.input.fill('9')
  await lim.input.blur()
  await expect(page.getByTestId('save-status')).toContainText(/above the 8 A rating/)
  await expect(page.getByTestId('save')).toBeDisabled()
  await expect(page.getByText('■ max 8 A on this pin')).toBeVisible()
  await page.getByRole('button', { name: 'Revert' }).dispatchEvent('click')
  expect(errors).toEqual([])
})

test('protection save writes limits, retry rule, warn and open-load to the module', async ({ page }) => {
  const errors = watchErrors(page)
  await withOutput('PDM-05', 1, async (d) => {
    await openOut(page, 1)
    await stepper(page, 'Trips above').input.fill('7'); await stepper(page, 'Trips above').input.blur()
    await stepper(page, 'Inrush allowed').input.fill('40'); await stepper(page, 'Inrush allowed').input.blur()
    await stepper(page, 'Inrush time').input.fill('500'); await stepper(page, 'Inrush time').input.blur()
    await pickSelect(page, 'After a trip', 'Retry a few times')
    await stepper(page, 'Retries').input.fill('5'); await stepper(page, 'Retries').input.blur()
    await stepper(page, 'Wait between retries').input.fill('800'); await stepper(page, 'Wait between retries').input.blur()
    await stepper(page, 'Warn at').input.fill('5.5'); await stepper(page, 'Warn at').input.blur()
    await stepper(page, 'Load missing below').input.fill('0.3'); await stepper(page, 'Load missing below').input.blur()
    await stepper(page, 'Load missing for').input.fill('900'); await stepper(page, 'Load missing for').input.blur()
    await expect(page.getByTestId('protection-summary')).toContainText('retries 5 times, 800 ms apart')
    await saveAndWait(page)
    await waitFor(async () => {
      const o = (await out(1)).o
      return o.currentLimit === 7 && o.inrushLimit === 40 && o.inrushTime === 500 && o.resetMode === 1 && o.resetCountLimit === 5 && o.resetTime === 800 && near(o.warnLimit, 5.5) && near(o.openLoadLimit, 0.3) && o.openLoadTime === 900
    }, 15_000, 'protection values on the module')
    await expect(page.getByTestId('save-status')).toContainText('Not on the car yet')
  })
  expect(errors).toEqual([])
})

test('drive: modes, duty, frequency, soft start and duty-from-signal are written', async ({ page }) => {
  const errors = watchErrors(page)
  await withOutput('PDM-05', 1, async () => {
    await openOut(page, 1)
    await page.getByRole('radio', { name: /PWM, fixed duty/ }).click()
    await stepper(page, 'Duty').input.fill('60'); await stepper(page, 'Duty').input.blur()
    await stepper(page, 'Frequency').input.fill('150'); await stepper(page, 'Frequency').input.blur()
    await page.getByRole('switch', { name: /Soft start/ }).click()
    await stepper(page, 'Ramp time').input.fill('800'); await stepper(page, 'Ramp time').input.blur()
    await saveAndWait(page)
    await waitFor(async () => { const o = (await out(1)).o; return o.pwmEnabled && o.fixedDuty === 60 && o.freq === 150 && o.softStart && o.softStartRamp === 800 && !o.variableDutyCycle }, 15_000, 'PWM fixed on module')
    // duty from a signal
    await page.getByRole('radio', { name: /duty from a signal/ }).click()
    await expect(page.getByRole('button', { name: 'Duty comes from' })).toBeVisible()
    await pickSelect(page, 'Duty comes from', 'Battery')
    await page.getByLabel('Signal value at 100 % duty').fill('200'); await page.getByLabel('Signal value at 100 % duty').blur()
    await saveAndWait(page)
    await waitFor(async () => { const o = (await out(1)).o; return o.variableDutyCycle && o.dutyCycleInput > 0 && o.dutyCycleDenom === 2 }, 15_000, 'duty from signal on module')
    // back to on / off
    await page.getByRole('radio', { name: /On \/ off/ }).click()
    await saveAndWait(page)
    await waitFor(async () => !(await out(1)).o.pwmEnabled, 15_000, 'PWM off on module')
  })
  expect(errors).toEqual([])
})

test('drive: off while cranking points to the Accessory role (firmware 5.6)', async ({ page }) => {
  await openOut(page, 8)
  await expect(page.getByText(/give it the Accessory role/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Output roles' })).toHaveAttribute('href', /power\/roles/)
})

test('wiring: gauge, length, colour and voltage drop are saved', async ({ page }) => {
  const errors = watchErrors(page)
  await withOutput('PDM-05', 1, async () => {
    await openOut(page, 1)
    await pickSelect(page, 'Gauge', '1.5 mm²')
    await page.getByLabel('Length, one way').fill('0.6'); await page.getByLabel('Length, one way').blur()
    await page.getByTestId('wire-color').fill('#3366cc')
    await expect(page.getByTestId('vdrop')).toContainText(/1\.5 mm² .* over 0\.6 m at 8 A drops/)
    await saveAndWait(page)
    await waitFor(async () => { const o = (await out(1)).o; return o.wireGaugeMm2 === 1.5 && o.wireLength === 0.6 && o.wireColor.toLowerCase() === '#3366cc' }, 15_000, 'wiring on record')
    await page.getByRole('button', { name: 'Clear' }).first().click()
    await saveAndWait(page)
    await waitFor(async () => !(await out(1)).o.wireColor, 15_000, 'colour cleared')
  })
  expect(errors).toEqual([])
})

test('driver: picking a source enables the output, shows it in the chain and saves', async ({ page }) => {
  const errors = watchErrors(page)
  await withOutput('PDM-05', 1, async () => {
    await openOut(page, 1)
    await expect(page.getByTestId('lane-input')).toContainText('Nothing drives this output')
    await pickSelect(page, 'Change what turns it on', 'Always On')
    await expect(page.getByRole('switch', { name: 'Output enabled' })).toBeChecked()
    await expect(page.getByTestId('lane-input')).toContainText('Always On')
    await saveAndWait(page)
    await waitFor(async () => { const o = (await out(1)).o; return o.inputVal === 1 && o.enabled }, 15_000, 'driver on module')
    await pickSelect(page, 'Change what turns it on', 'Nothing')
    await page.getByRole('switch', { name: 'Output enabled' }).click()
    await saveAndWait(page)
    await waitFor(async () => { const o = (await out(1)).o; return o.inputVal === 0 && !o.enabled }, 15_000, 'driver cleared')
  })
  expect(errors).toEqual([])
})

test('chain panel: raw view, flow-builder links and firmware-gated items', async ({ page }) => {
  const d = await openOut(page, 2)   // a configured output: read only
  await expect(page.getByTestId('lane-input')).not.toContainText('Nothing drives this output')
  await page.getByTestId('show-raw').click()
  await expect(page.getByLabel('Raw output settings')).toContainText('"number": 2')
  await page.getByTestId('show-raw').click()
  await expect(page.getByLabel('Raw output settings')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Use a role instead…' })).toHaveAttribute('href', /power\/roles/)   // firmware 5.6
  await expect(page.getByRole('link', { name: '+ Math' })).toHaveAttribute('href', /functions\/flow/)
  for (const c of ['On-delay', 'Keep on after', 'Flasher', 'Table', 'Signal', 'Lua']) await expect(page.getByRole('link', { name: '+ ' + c })).toHaveAttribute('href', `#/next/functions/flow/${d.guid}`)
  await page.getByRole('link', { name: 'Open in flow builder' }).click()
  await expect(page).toHaveURL(new RegExp(`#/next/functions/flow/${d.guid}`))
})

test('compare and combine dialogs open, validate and cancel without writing', async ({ page }) => {
  await openOut(page, 8)
  await page.getByRole('button', { name: '+ Compare' }).click()
  await expect(page.getByRole('dialog', { name: 'New compare block' })).toBeVisible()
  await page.getByTestId('create-compare').click()
  await expect(page.getByRole('alert').filter({ hasText: 'Pick the value to compare' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '+ Combine' }).click()
  await expect(page.getByRole('dialog', { name: 'New combine block' })).toBeVisible()
  await page.getByTestId('create-combine').click()
  await expect(page.getByRole('alert').filter({ hasText: 'Pick at least one signal' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

// Creates a block in a free slot of PDM-05 (not one of the assigned write targets), so it is run by the lead alone.
test('compare builder makes a block and drives the output from it @exclusive', async ({ page }) => {
  const d = await deviceByName('PDM-05')
  const before = await apiJson('GET', `/api/devices/${d.guid}/functions`)
  await withOutput('PDM-05', 1, async () => {
    await openOut(page, 1)
    await page.getByRole('button', { name: '+ Compare' }).click()
    await page.getByRole('dialog').getByLabel('Name (optional)').fill('MCPVAL b compare')
    await pickSelect(page, 'Value to compare', 'Battery')
    await page.getByRole('dialog').getByLabel('This number').fill('13')
    await page.getByTestId('create-compare').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('lane-input')).toContainText('MCPVAL b compare')
    await saveAndWait(page)
  })
  const after = await apiJson('GET', `/api/devices/${d.guid}/functions`)
  const made = after.conditions.find((c) => c.name === 'MCPVAL b compare')
  expect(made?.enabled).toBe(true)
  const prev = before.conditions.find((c) => c.number === made.number)
  await apiJson('POST', `/api/devices/${d.guid}/function/condition/${made.number}`, prev)
})

// ---------------------------------------------------------------- bench test (PDM-05 out 8)
async function armOut8() {
  const { d, o } = await out(8)
  await putOutput(d.guid, { ...o, enabled: true, currentLimit: 6 })
  await waitFor(async () => (await out(8)).o.enabled, 15_000, 'out 8 enabled')
}
// the one Test button lives in the page header (the bench card only explains)
const start = (page) => page.getByTestId('header-test')

test('bench: refused with a reason while the output is off, or has unsaved changes', async ({ page }) => {
  await openOut(page, 1)   // disabled spare
  await expect(start(page)).toBeDisabled()
  await expect(page.getByRole('status').filter({ hasText: 'Turn the output on and save first' })).toBeVisible()
  await expect(page.getByTestId('header-test')).toBeDisabled()
  await expect(page.getByTestId('header-test')).toHaveAttribute('title', /Turn the output on and save first/)
})

test('bench: Test runs on the module, shows TEST banner and countdown, Stop now releases', async ({ page }) => {
  const errors = watchErrors(page)
  await withOutput('PDM-05', 8, async () => {
    await armOut8()
    await openOut(page, 8)
    await expect(start(page)).toBeEnabled()
    await stepper(page, 'Hold').input.fill('10'); await stepper(page, 'Hold').input.blur()
    await expect(start(page)).toContainText('Test for 10 s')
    await start(page).click()
    await expect(page.getByTestId('bench-banner')).toContainText('TEST')
    await expect(page.getByTestId('bench-banner')).toContainText(/is forced ON/)
    await expect(page.getByTestId('bench-count')).toContainText(/auto-off in \d+ s/)
    await expect(page.getByTestId('bench-now')).toContainText(/Now .* A · .* s of 10 s/)
    await waitFor(async () => (await out(8)).o.state === 'On', 10_000, 'output on while testing')
    await expect(page.getByTestId('out-state')).toContainText('On', { timeout: 10_000 })
    await page.getByTestId('bench-stop').click()
    await expect(page.getByTestId('bench-banner')).toHaveCount(0)
    await expect(page.getByTestId('bench-now')).toContainText('Stopped. The output is off.')
    await waitFor(async () => (await out(8)).o.state === 'Off', 10_000, 'output off after Stop now')
  })
  expect(errors).toEqual([])
})

test('bench: the top Stop now button also releases the output', async ({ page }) => {
  await withOutput('PDM-05', 8, async () => {
    await armOut8()
    await openOut(page, 8)
    await page.getByTestId('header-test').click()
    await expect(page.getByTestId('bench-banner')).toBeVisible()
    await expect(page.getByTestId('header-test')).toBeDisabled()
    await page.getByTestId('bench-stop-top').click()
    await expect(page.getByTestId('bench-banner')).toHaveCount(0)
    await waitFor(async () => (await out(8)).o.state === 'Off', 10_000, 'off after top Stop now')
  })
})

test('bench: PWM test and auto-off at the end of the hold time', async ({ page }) => {
  await withOutput('PDM-05', 8, async () => {
    await armOut8()
    await openOut(page, 8)
    await page.getByRole('radio', { name: 'PWM, set duty' }).click()
    await stepper(page, 'Hold').input.fill('3'); await stepper(page, 'Hold').input.blur()
    await stepper(page, 'Duty').input.fill('40'); await stepper(page, 'Duty').input.blur()
    await stepper(page, 'Frequency').input.fill('120'); await stepper(page, 'Frequency').input.blur()
    await expect(start(page)).toContainText('Run PWM 40 % for 3 s')
    await start(page).click()
    await expect(page.getByTestId('bench-banner')).toContainText(/on at 40 % PWM/)
    await waitFor(async () => (await out(8)).o.state === 'On', 10_000, 'PWM output on')
    // the module lets go by itself when the hold time ends
    await expect(page.getByTestId('bench-now')).toContainText('ran its full time', { timeout: 15_000 })
    await expect(page.getByTestId('bench-banner')).toHaveCount(0)
    await waitFor(async () => (await out(8)).o.state === 'Off', 10_000, 'off after the hold time')
    await expect(start(page)).toBeEnabled()
  })
})

test('bench: leaving the page during a test releases the output', async ({ page }) => {
  await withOutput('PDM-05', 8, async () => {
    await armOut8()
    await openOut(page, 8)
    await stepper(page, 'Hold').input.fill('20'); await stepper(page, 'Hold').input.blur()
    await start(page).click()
    await waitFor(async () => (await out(8)).o.state === 'On', 10_000, 'on')
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Car', exact: true }).click()
    await waitFor(async () => (await out(8)).o.state === 'Off', 10_000, 'released when the page is left')
  })
})

test('bench: unsaved edits block the test until saved or reverted', async ({ page }) => {
  await withOutput('PDM-05', 8, async () => {
    await armOut8()
    await openOut(page, 8)
    await stepper(page, 'Warn at').more.click()
    await expect(start(page)).toBeDisabled()
    await expect(page.getByRole('status').filter({ hasText: 'Save your changes first' })).toBeVisible()
    await page.getByRole('button', { name: 'Revert' }).dispatchEvent('click')
    await expect(start(page)).toBeEnabled()
  })
})

// The link drops mid-test: disconnects the adapter, so it must run alone.
test('bench: link lost mid-test shows LINK LOST, no Stop, and the module turns the output off @exclusive', async ({ page }) => {
  const adapters = await apiJson('GET', '/api/adapters')
  await withOutput('PDM-05', 8, async () => {
    await armOut8()
    // edits another test left waiting for Apply (G2) would block the bench: write them first
    await apiJson('POST', `/api/devices/${(await deviceByName('PDM-05')).guid}/write`)
    await openOut(page, 8)
    await stepper(page, 'Hold').input.fill('8'); await stepper(page, 'Hold').input.blur()
    await start(page).click()
    await expect(page.getByTestId('bench-banner')).toContainText('TEST')
    await apiJson('POST', '/api/disconnect')
    await expect(page.getByTestId('bench-banner')).toContainText('LINK LOST')
    await expect(page.getByTestId('bench-stop-top')).toBeDisabled()
    await expect(page.getByTestId('bench-count')).toContainText(/off in about \d+ s/)
    await expect(page.getByTestId('bench-now')).toContainText(/Last seen/)
    await page.waitForTimeout(9000)
    await expect(page.getByTestId('bench-now')).toContainText(/link dropped/)
    await apiJson('POST', '/api/connect', { Adapter: adapters.activeAdapter, Port: adapters.activePort, Bitrate: '500K' })
    await waitFor(async () => (await out(8)).o.state === 'Off', 20_000, 'output off after the link came back')
  })
})

test('shows module / output not found states', async ({ page }) => {
  await open(page, 'hardware/module/00000000-0000-0000-0000-000000000000/output/1')
  await expect(page.getByRole('heading', { level: 1, name: 'Module not found' })).toBeVisible()
  const d = await deviceByName('PDM-05')
  await open(page, `hardware/module/${d.guid}/output/99`)
  await expect(page.getByRole('heading', { level: 1, name: 'Output 99 not found' })).toBeVisible()
  await page.getByRole('link', { name: 'See every output' }).click()
  await expect(page).toHaveURL(/hardware\/outputs$/)
})

test('CANBoard output: chain, drive and protection note; test button enabled but not pressed', async ({ page }) => {
  const errors = watchErrors(page)
  const cb = await deviceByName('CB-2')
  await open(page, `hardware/module/${cb.guid}/output/1`)
  await expect(page.getByText('cannot measure or limit current')).toBeVisible()
  await expect(page.getByTestId('lane-input')).toContainText('THIS OUTPUT')
  await expect(page.getByTestId('cb-live')).toContainText(/Right now this output is|No live value/)
  await expect(page.getByTestId('header-test')).toBeEnabled()
  await expect(page.getByRole('radio', { name: /On \/ off/ })).toBeVisible()
  expect(errors).toEqual([])
})
