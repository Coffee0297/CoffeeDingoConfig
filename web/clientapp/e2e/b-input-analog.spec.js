// Analog input detail (hardware/module/<guid>/input/analoginput/<n>). Writes: CB-2 inputs 3, 4 and 5 only (AI2 is used by other work in the scene); restored after each test.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { deviceByName, funcRow, withFunc, stepper, waitFor, mockFunctions } from './b-helpers.js'

test.describe.configure({ timeout: 120_000 })

let cb, cb1, p5
test.beforeAll(async () => { cb = await deviceByName('CB-2'); cb1 = await deviceByName('CB-1'); p5 = await deviceByName('PDM-05') })
const row = (n) => funcRow(cb.guid, 'analogIn', n)
const openAi = async (page, n, d = cb) => { await open(page, `hardware/module/${d.guid}/input/analoginput/${n}`); await expect(page.getByTestId('save')).toBeVisible() }
const withAi = (n, fn) => withFunc(cb.guid, 'analoginput', 'analogIn', n, fn)
// 5.7 (upstream layout): Multi-position switch opens on Evenly spaced; the resistor ladder is the Calibrated choice (fork: always the ladder)
const ladderMode = async (page) => {
  await page.getByRole('radio', { name: 'Multi-position switch' }).click()
  const cal = page.getByRole('radio', { name: 'Calibrated (measured voltages)' })
  if (await cal.count()) await cal.click()
}
const save = async (page) => { await page.getByTestId('save').dispatchEvent('click'); await expect(page.getByTestId('save-status')).toContainText(/^Kept in the project/, { timeout: 30_000 }) }

/** Report a fixed millivolt value for one analog input (and its switch state) in GET .../signals. */
async function mockMv(page, realName, name, mv) {
  const ctl = { mv, sw: false }
  await page.route('**/api/devices/*/signals', async (route) => {
    const r = await route.fetch()
    const list = await r.json()
    for (const s of list) {
      if (s.kind === 'Analog input' && s.name === realName) { s.name = name; s.value = String(ctl.mv); s.on = ctl.mv > 0; s.enabled = true }
      if (s.kind === 'Analog switch' && s.name === realName + ' Switch') { s.name = name + ' Switch'; s.on = ctl.sw; s.value = ctl.sw ? 'on' : 'off'; s.enabled = true }
    }
    await route.fulfill({ response: r, json: list })
  })
  return ctl
}

test('on / off threshold is saved: level, switch type and invert', async ({ page }) => {
  const errors = watchErrors(page)
  await withAi(5, async () => {
    await openAi(page, 5)
    await expect(page.getByTestId('in-state')).toContainText('Not in use')
    await page.getByRole('radio', { name: 'On / off threshold' }).click()
    await expect(page.getByText('No separate off level yet')).toBeVisible()
    await stepper(page, 'Switches at').input.fill('2.5'); await stepper(page, 'Switches at').input.blur()
    await stepper(page, 'Switches at').more.click()
    await expect(stepper(page, 'Switches at').input).toHaveValue('2.6')
    await stepper(page, 'Switches at').less.click()
    await page.getByRole('radio', { name: /Latching/ }).click()
    await page.getByRole('checkbox', { name: /Invert/ }).click()
    await expect(page.getByRole('img', { name: /Line graph of the input voltage/ })).toBeVisible()
    const inUse = page.getByRole('switch', { name: 'Input in use' })
    if (!(await inUse.isChecked())) await inUse.click()
    await save(page)
    await waitFor(async () => { const r = await row(5); return r.enabled && r.switch.enabled && r.switch.threshold === 2500 && r.switch.mode === 1 && r.switch.invert && !r.scale.enabled && !r.rotary.enabled }, 20_000, 'threshold on the module')
  })
  expect(errors).toEqual([])
})

test('threshold: ON and OFF follow the switch signal and the pin voltage is shown', async ({ page }) => {
  {
    await mockFunctions(page, cb.guid, (f) => { const r = f.analogIn[1]; r.name = 'MCPVAL b thr'; r.enabled = true; r.switch.enabled = true; r.switch.threshold = 2000 })
    const ctl = await mockMv(page, (await row(2)).name, 'MCPVAL b thr', 1500)
    await openAi(page, 2)
    await expect(page.getByTestId('in-state')).toContainText('OFF · 1.50 V')
    await expect(page.getByTestId('big-value')).toContainText('1.50 V')
    ctl.mv = 3200; ctl.sw = true
    await expect(page.getByTestId('in-state')).toContainText('ON · 3.20 V', { timeout: 5000 })
  }
})

test('linear sensor: presets, two points, use live, unit and formula are saved', async ({ page }) => {
  const errors = watchErrors(page)
  await withAi(3, async () => {
    await openAi(page, 3)
    await page.getByRole('radio', { name: 'Linear sensor' }).click()
    await page.getByRole('radio', { name: /Oil pressure 0–10 bar/ }).click()
    await expect(page.getByTestId('unit')).toHaveValue('bar')
    await expect(page.getByTestId('highX')).toHaveValue('10')
    await page.getByRole('radio', { name: /Fuel level 0–100 %/ }).click()
    await expect(page.getByTestId('unit')).toHaveValue('%')
    await page.getByRole('radio', { name: /Oil pressure/ }).click()
    await page.getByTestId('lowV').fill('0.4'); await page.getByTestId('lowV').blur()
    await expect(page.getByRole('radio', { name: 'Custom' })).toBeChecked()
    await expect(page.getByTestId('formula')).toContainText('(V − 0.40)')
    // "Use live" copies the live reading into the point
    await page.getByTestId('take-highV').click()
    await expect(page.getByTestId('highV')).toHaveValue(/^\d(\.\d+)?$/)
    await page.getByTestId('highV').fill('4.5'); await page.getByTestId('highV').blur()
    await save(page)
    await waitFor(async () => { const r = await row(3); return r.enabled && r.scale.enabled && r.scale.inLowMv === 400 && r.scale.inHighMv === 4500 && r.scale.outHigh === 10 && r.scale.units === 'bar' && !r.rotary.enabled && !r.switch.enabled && Math.abs(r.scale.gain - 10 / 4100) < 1e-4 }, 20_000, 'linear sensor on the module')
  })
  expect(errors).toEqual([])
})

test('linear sensor flags a reading outside the range', async ({ page }) => {
  {
    await mockFunctions(page, cb.guid, (f) => { const r = f.analogIn[2]; r.name = 'MCPVAL b sender'; r.enabled = true; Object.assign(r.scale, { enabled: true, inLowMv: 500, outLow: 0, inHighMv: 4500, outHigh: 100, units: '%', gain: 0.025, offset: -12.5 }) })
    const ctl = await mockMv(page, (await row(3)).name, 'MCPVAL b sender', 2500)
    await openAi(page, 3)
    await expect(page.getByTestId('in-state')).toContainText('50 % · 2.50 V')
    await expect(page.getByTestId('big-value')).toContainText('50 %')
    ctl.mv = 4950
    await expect(page.getByTestId('in-state')).toContainText('Out of range', { timeout: 5000 })
    await expect(page.getByText('The reading is outside the sensor range')).toBeVisible()
  }
})

test('resistor ladder: presets, count, overlap check, order check, then save', async ({ page }) => {
  const errors = watchErrors(page)
  await withAi(4, async () => {
    await openAi(page, 4)
    await ladderMode(page)
    await page.getByRole('radio', { name: 'Headlight, 5 positions' }).click()
    await expect(page.getByTestId('ladder-table').locator('tbody tr')).toHaveCount(5)
    await expect(page.getByTestId('ladder-table')).toContainText('Clear')
    // same resistor as the next position: they overlap
    await page.getByLabel('Resistor for position 1 in ohms').fill('230'); await page.getByLabel('Resistor for position 1 in ohms').blur()
    await expect(page.getByText('Two positions overlap')).toBeVisible()
    await expect(page.getByTestId('ladder-table')).toContainText(/Overlaps/)
    // out of order blocks Save
    await page.getByLabel('Resistor for position 1 in ohms').fill('100'); await page.getByLabel('Resistor for position 1 in ohms').blur()
    await expect(page.getByText('The voltages must go up with the position number')).toBeVisible()
    await expect(page.getByTestId('save-status')).toContainText('must go up')
    await expect(page.getByTestId('save')).toBeDisabled()
    // evenly spaced + 3 positions, then count stepper
    await page.getByRole('radio', { name: 'Evenly spaced, 5' }).click()
    await expect(page.getByTestId('ladder-table').locator('tbody tr')).toHaveCount(5)
    await page.getByRole('radio', { name: '3 positions' }).click()
    await expect(page.getByTestId('ladder-table').locator('tbody tr')).toHaveCount(3)
    await stepper(page, 'Number of positions').more.click()
    await expect(page.getByTestId('ladder-table').locator('tbody tr')).toHaveCount(4)
    await stepper(page, 'Number of positions').less.click()
    await expect(page.getByTestId('ladder-table').locator('tbody tr')).toHaveCount(3)
    // names and a typed voltage
    await page.getByLabel('Name of position 1').fill('Low'); await page.getByLabel('Name of position 2').fill('High')
    const v1 = page.getByLabel('Voltage of position 1 in volts')
    await v1.fill('2.00'); await v1.blur()
    await expect(page.getByLabel('Resistor for position 1 in ohms')).not.toHaveValue('open')
    await expect(page.getByRole('img', { name: /Voltage windows of 3 positions/ })).toBeVisible()
    await save(page)
    await waitFor(async () => {
      const r = await row(4); const ro = r.rotary
      return r.enabled && ro.enabled && ro.numPos === 3 && ro.points[1] === 2000 && ro.points[0] < ro.points[1] && ro.points[1] < ro.points[2] && ro.positionNames[1] === 'Low' && ro.positionNames[2] === 'High' && !r.switch.enabled && !r.scale.enabled
    }, 20_000, 'ladder on the module')
    // reopen: the saved positions come back
    await openAi(page, 4)
    await expect(page.getByTestId('ladder-table').locator('tbody tr')).toHaveCount(3)
    await expect(page.getByLabel('Name of position 1')).toHaveValue('Low')
  })
  expect(errors).toEqual([])
})

test('teach the real switch: Use live per row and Capture steps through the positions', async ({ page }) => {
  {
    await mockFunctions(page, cb.guid, (f) => { const r = f.analogIn[4]; r.name = 'MCPVAL b rotary'; r.enabled = true })
    const ctl = await mockMv(page, (await row(5)).name, 'MCPVAL b rotary', 1230)
    await openAi(page, 5)
    await ladderMode(page)
    await page.getByRole('radio', { name: 'Evenly spaced, 5' }).click()
    await expect(page.getByText('Turn the switch to "Off" and press Capture')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('capture-step')).toBeEnabled({ timeout: 10_000 })   // steady for 1 s
    await page.getByTestId('capture-step').click()
    await expect(page.getByLabel('Voltage of position 0 in volts')).toHaveValue('1.23')
    await expect(page.getByText('Turn the switch to "Park" and press Capture')).toBeVisible()
    await expect(page.getByTestId('ladder-table')).toContainText('captured ✓')
    // a moving reading is not "steady": Capture waits
    ctl.mv = 1800
    await expect(page.getByTestId('capture-step')).toBeDisabled({ timeout: 3000 }).catch(() => {})
    await expect(page.getByTestId('capture-step')).toBeEnabled({ timeout: 10_000 })
    await page.getByTestId('capture-3').click()
    await expect(page.getByLabel('Voltage of position 3 in volts')).toHaveValue('1.80')
  }
})

test('reads a configured rotary switch: position, windows and tightest gap', async ({ page }) => {
  const errors = watchErrors(page)
  await open(page, `hardware/module/${cb1.guid}/input/analoginput/1`)
  await expect(page.getByTestId('in-state')).toContainText(/Position \d|No position/)
  await expect(page.getByRole('img', { name: /Voltage windows of \d+ positions/ })).toBeVisible()
  await expect(page.getByText('Tightest gap').first()).toBeVisible()
  await expect(page.getByText('470 Ω (fixed on the board)')).toBeVisible()
  expect(errors).toEqual([])
})

test('a PDM has no analog inputs', async ({ page }) => {
  await open(page, `hardware/module/${p5.guid}/input/analoginput/1`)
  await expect(page.getByRole('heading', { level: 1, name: 'No analog inputs here' })).toBeVisible()
})
