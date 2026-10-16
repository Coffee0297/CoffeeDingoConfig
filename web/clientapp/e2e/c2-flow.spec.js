// Flow builder (functions/flow) against the Sim. Writes use ONLY PDM-04's test targets:
// virtual inputs 14–16, conditions 30–32, timer 8, flasher 4, counter 4, table 2, CAN outputs 30–32, output o2.
// "+ Add" claims the highest free slot, so on PDM-04 it lands on exactly those slots. Every test reads the
// slots first and puts them back in `finally`.
import { test, expect } from '@playwright/test'
import { near } from './api.js'
import { open, watchErrors } from './helpers.js'
import { API, apiJson, deviceByName, waitFor } from './api.js'

const TARGETS = { virtualInputs: [14, 15, 16], conditions: [30, 31, 32], timers: [8], flashers: [4], counters: [4], tables: [2], canOutputs: [30, 31, 32], maths: [8], canMessages: [4], comfortBlinks: [1] }
const KIND = { virtualInputs: 'virtualinput', conditions: 'condition', timers: 'timer', flashers: 'flasher', counters: 'counter', tables: 'table', canOutputs: 'canoutput', maths: 'math', canMessages: 'canmsg', comfortBlinks: 'comfortblink' }

let pdm4
const fns = (g) => apiJson('GET', `/api/devices/${g}/functions`)
// The shared bus sometimes drops a confirm (409 "no reply"); the project record is updated anyway, so retry.
async function post(path, body) {
  for (let i = 0; ; i++) {
    try { return await apiJson('POST', path, body) } catch (e) { if (i >= 3 || !/409/.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 500)) }
  }
}
const row = async (arr, n) => (await fns(pdm4.guid))[arr].find((x) => x.number === n)

async function snapshot() {
  const f = await fns(pdm4.guid)
  const s = {}
  for (const [arr, ns] of Object.entries(TARGETS)) for (const n of ns) s[arr + ':' + n] = f[arr].find((x) => x.number === n)
  const o2 = (await deviceByName('PDM-04')).outputs.find((o) => o.number === 2)
  return { s, o2 }
}
// restore: a 409 "no reply" still updated the project record (the module gets it on the next Apply)
const put = (path, body) => post(path, body).catch((e) => { if (!/409/.test(e.message)) throw e })
async function restore(snap) {
  for (const [k, r] of Object.entries(snap.s)) {
    const [arr, n] = k.split(':')
    const cur = await row(arr, +n)
    if (JSON.stringify(cur) === JSON.stringify(r)) continue
    const { number, ...body } = r
    await put(`/api/devices/${pdm4.guid}/function/${KIND[arr]}/${n}`, body)
  }
  const o2 = (await deviceByName('PDM-04')).outputs.find((o) => o.number === 2)
  if (o2.inputVal !== snap.o2.inputVal || o2.enabled !== snap.o2.enabled) await put(`/api/devices/${pdm4.guid}/outputconfig`, { Number: 2, Input: snap.o2.inputVal, Enabled: snap.o2.enabled })
}
const node = (page, id) => page.locator(`.svelte-flow__node[data-id="${id}"]`)
const insp = (page) => page.getByRole('complementary', { name: 'Inspector' })

async function openFlow(page, name = 'PDM-04', fn) {
  const d = await deviceByName(name)
  await open(page, `functions/flow/${d.guid}${fn ? '/' + fn : ''}`)
  // other teams' write-failure toasts stack over the inspector on the shared bus; let clicks pass through them
  await page.addStyleTag({ content: '.tw { pointer-events: none }' })
  await expect(page.getByRole('heading', { level: 1, name: `${name} · blocks` })).toBeVisible()
  await expect(page.getByTestId('canvas').locator('.svelte-flow__node').first()).toBeVisible({ timeout: 15_000 })
  return d
}
/** Wait for the builder's queued writes to finish (each waits for the module's confirm). */
async function settle(page) {
  await page.locator('.fb[data-busy="true"]').waitFor({ timeout: 1500 }).catch(() => {})
  await expect(page.locator('.fb[data-busy="false"]')).toBeVisible({ timeout: 60_000 })
}
async function addBlock(page, label) {
  await page.getByTestId('tool-add').click()
  const dlg = page.getByRole('dialog', { name: 'Add a block' })
  await expect(dlg).toBeVisible()
  await dlg.getByTestId('add-' + label).click()
  await expect(dlg).toHaveCount(0)
  await settle(page)
}
async function pickSource(page, field, optionText) {
  await insp(page).getByTestId('src-' + field).click()
  await page.getByRole('option', { name: optionText, exact: false }).first().click()
}
async function save(page) {
  await insp(page).getByTestId('insp-save').click()
  await settle(page)
  await expect(insp(page).getByTestId('insp-save')).toBeDisabled({ timeout: 15_000 })
}

// writes wait for the module's confirm; on a busy shared bus that can take a while
test.describe.configure({ timeout: 240_000 })
test.beforeAll(async () => { pdm4 = await deviceByName('PDM-04') })

test('canvas shows the module\'s real blocks with live values and switches module', async ({ page }) => {
  const errors = watchErrors(page)
  await openFlow(page, 'CB-1')
  const f = await fns((await deviceByName('CB-1')).guid)
  for (const v of f.virtualInputs.filter((x) => x.enabled)) await expect(node(page, 'virtualinput:' + v.number)).toContainText(v.name)
  // live pill: Ignition state from the module
  await expect(node(page, 'input:3').locator('.pill').first()).toHaveText(/ON|OFF/)
  // a cross-module CAN input wears the CAN badge on PDM-01
  await page.getByTestId('module-select').click()
  await page.getByRole('option', { name: /PDM-01/ }).click()
  await expect(page).toHaveURL(new RegExp('functions/flow/' + (await deviceByName('PDM-01')).guid))
  await expect(node(page, 'caninput:1')).toContainText('CAN')
  await node(page, 'caninput:1').click()
  await expect(insp(page)).toContainText('Reads CB-1')
  await insp(page).getByRole('button', { name: /Open CB-1/ }).click()
  await expect(page).toHaveURL(new RegExp('functions/flow/' + (await deviceByName('CB-1')).guid))
  expect(errors).toEqual([])
})

test('+ Add a Compare, edit it with hysteresis, Delete removes it and Undo brings it back', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot()
  try {
    // make sure slot 32 is the highest free compare
    for (const n of [30, 31, 32]) if ((await row('conditions', n)).enabled) await put(`/api/devices/${pdm4.guid}/function/condition/${n}`, { enabled: false })
    await openFlow(page)
    await addBlock(page, 'Compare')
    await waitFor(async () => (await row('conditions', 32)).enabled, 15_000, 'condition 32 enabled')
    await expect(node(page, 'condition:32')).toBeVisible()
    await expect(insp(page).getByRole('heading', { level: 2 })).toBeVisible()
    await insp(page).getByLabel('Name').fill('c2 battery low')
    await pickSource(page, 'input', 'Battery Voltage')
    await insp(page).getByLabel('Value', { exact: true }).fill('11.5')
    await insp(page).getByText('Separate off point (hysteresis)').click()
    await insp(page).getByLabel('Off again at').fill('12.2')
    await save(page)
    await waitFor(async () => { const r = await row('conditions', 32); return r.name === 'c2 battery low' && near(r.arg, 11.5) && near(r.argOff, 12.2) && r.input === 4 }, 15_000, 'compare saved')
    // the incomplete marker went away once it had an input
    await expect(node(page, 'condition:32')).not.toContainText('needs an input')
    // Delete key on the focused block → confirm → slot freed
    await node(page, 'condition:32').focus()
    await page.keyboard.press('Delete')
    await page.getByTestId('confirm-remove').click()
    await settle(page)
    await waitFor(async () => !(await row('conditions', 32)).enabled, 15_000, 'condition 32 disabled')
    await expect(node(page, 'condition:32')).toHaveCount(0)
    await page.getByTestId('tool-undo').click()
    await settle(page)
    await waitFor(async () => (await row('conditions', 32)).enabled, 15_000, 'undo re-enabled condition 32')
    await expect(node(page, 'condition:32')).toBeVisible()
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('Combine with NOT and OR, then the sentence view reads it and its tokens open the inspector', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot()
  try {
    for (const n of [14, 15, 16]) if ((await row('virtualInputs', n)).enabled) await put(`/api/devices/${pdm4.guid}/function/virtualinput/${n}`, { enabled: false })
    await openFlow(page)
    await addBlock(page, 'Combine AND / OR / NOR')
    await waitFor(async () => (await row('virtualInputs', 16)).enabled, 15_000, 'VI 16 enabled')
    await insp(page).getByLabel('Name').fill('c2 combine')
    await pickSource(page, 'var0', 'Hazard · State')
    await pickSource(page, 'var1', 'Brake · State')
    await insp(page).getByRole('button', { name: 'NOT on In 2' }).click()
    await insp(page).getByRole('radiogroup', { name: 'First join' }).getByRole('radio', { name: 'OR', exact: true }).click()
    await save(page)
    const f = await fns(pdm4.guid)
    const vmap = await apiJson('GET', `/api/devices/${pdm4.guid}/inputs`)
    const r = f.virtualInputs.find((x) => x.number === 16)
    expect(r.name).toBe('c2 combine')
    expect(r.not1).toBe(true)
    expect(r.cond0).toBe(1)
    expect(vmap.find((v) => v.index === r.var0).name).toBe('Hazard')
    // sentence view
    await page.getByRole('radiogroup', { name: 'Builder view' }).getByRole('radio', { name: 'Sentence view' }).click()
    const card = page.getByRole('article', { name: 'c2 combine' })
    await expect(card).toContainText('NOT')
    await expect(card).toContainText('OR')
    await card.getByRole('button', { name: /^Brake/ }).click()
    await expect(insp(page).getByRole('heading', { level: 2 })).toHaveText('Brake')
    await card.getByRole('button', { name: 'Show on canvas' }).click()
    await expect(page.getByTestId('canvas')).toBeVisible()
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('timer, flasher, push-button toggle, table and CAN output inspectors write the module', async ({ page }) => {
  test.setTimeout(480_000)
  const errors = watchErrors(page)
  const snap = await snapshot()
  try {
    for (const [arr, ns] of Object.entries(TARGETS)) for (const n of ns) if ((await row(arr, n)).enabled) await put(`/api/devices/${pdm4.guid}/function/${KIND[arr]}/${n}`, { enabled: false })
    await openFlow(page)
    // Keep on after (timer 8)
    await addBlock(page, 'Keep on after')
    await waitFor(async () => { const r = await row('timers', 8); return r.enabled && r.mode === 1 }, 15_000, 'timer 8 keep-on-after')
    await pickSource(page, 'input', 'Hazard · State')
    await insp(page).getByLabel('Time').fill('2.5')
    await insp(page).getByRole('radiogroup', { name: 'Kind' }).getByRole('radio', { name: 'Pulse' }).click()
    await save(page)
    await waitFor(async () => { const r = await row('timers', 8); return r.preset === 2500 && r.mode === 2 && r.input > 0 }, 15_000, 'timer saved')
    // Flasher 4
    await addBlock(page, 'Flasher')
    await waitFor(async () => (await row('flashers', 4)).enabled, 15_000, 'flasher 4')
    await pickSource(page, 'input', 'Hazard · State')
    await insp(page).getByLabel('On', { exact: true }).fill('300')
    await insp(page).getByLabel('Off', { exact: true }).fill('700')
    await save(page)
    await waitFor(async () => { const r = await row('flashers', 4); return r.onTime === 300 && r.offTime === 700 }, 15_000, 'flasher saved')
    // Push-button toggle = counter 4, 0..1 wrapping
    await addBlock(page, 'Push-button toggle')
    await waitFor(async () => { const r = await row('counters', 4); return r.enabled && r.maxCount === 1 && r.wrapAround }, 15_000, 'counter 4 toggle')
    await pickSource(page, 'incInput', 'Brake · State')
    await save(page)
    await waitFor(async () => (await row('counters', 4)).incInput > 0, 15_000, 'counter wired')
    // Table 2
    await addBlock(page, 'Table')
    await waitFor(async () => (await row('tables', 2)).enabled, 15_000, 'table 2')
    await pickSource(page, 'xInput', 'Battery Voltage')
    await insp(page).getByLabel('X point 1').fill('10')
    await insp(page).getByLabel('X point 2').fill('14')
    await insp(page).getByLabel('Value at row 1, column 2').fill('50')
    await save(page)
    await waitFor(async () => { const r = await row('tables', 2); return r.xAxis[0] === 10 && r.xAxis[1] === 14 && r.cells[1] === 50 && r.xInput === 4 }, 20_000, 'table saved')
    // CAN output 32 with the ID-free check
    await addBlock(page, 'CAN output')
    await waitFor(async () => (await row('canOutputs', 32)).enabled, 15_000, 'canout 32')
    await pickSource(page, 'input', 'Battery Voltage')
    await insp(page).getByLabel('CAN ID (hex)').fill('0x7A5')
    await expect(insp(page).getByText(/0x7A5 is free|already sent by/)).toBeVisible()
    await insp(page).getByLabel('Every').fill('250')
    await save(page)
    await waitFor(async () => { const r = await row('canOutputs', 32); return r.id === 0x7a5 && r.interval === 250 && r.input === 4 }, 15_000, 'canout saved')
    // Revert discards a draft
    await insp(page).getByLabel('Every').fill('999')
    await insp(page).getByRole('button', { name: 'Revert' }).click()
    await expect(insp(page).getByLabel('Every')).toHaveValue('250')
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('firmware 5.6: Math and CAN message blocks write the module, and the CAN message goes out on the bus', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  const snap = await snapshot()
  try {
    for (const arr of ['maths', 'canMessages']) for (const n of TARGETS[arr]) if ((await row(arr, n)).enabled) await put(`/api/devices/${pdm4.guid}/function/${KIND[arr]}/${n}`, { enabled: false })
    await openFlow(page)
    // Math 8: battery voltage × 10 + 0 (B a constant), Smaller of
    await addBlock(page, 'Math')
    await waitFor(async () => (await row('maths', 8)).enabled, 15_000, 'math 8')
    await pickSource(page, 'inputA', 'Battery Voltage')
    await insp(page).getByLabel('Result').click()
    await page.getByRole('option', { name: 'Smaller of A, B' }).click()
    await insp(page).getByLabel('B (no B input connected)').fill('12.5')
    await insp(page).getByLabel('Then × factor').fill('10')
    await save(page)
    await waitFor(async () => { const r = await row('maths', 8); return r.inputA === 4 && r.op === 4 && r.constB === 12.5 && r.factor === 10 }, 15_000, 'math saved')
    await expect(node(page, 'math:8')).toContainText('the smaller of A and 12.5')
    // CAN message 4: always on → 0x7A6 [11 22 33], every 200 ms
    await addBlock(page, 'CAN message')
    await waitFor(async () => (await row('canMessages', 4)).enabled, 15_000, 'canmsg 4')
    await pickSource(page, 'input', 'Always On')
    await insp(page).getByLabel('CAN ID (hex)').fill('0x7A6')
    await insp(page).getByLabel('Length').fill('3')
    await insp(page).getByLabel('Byte 0').fill('11'); await insp(page).getByLabel('Byte 0').blur()
    await insp(page).getByLabel('Byte 1').fill('22'); await insp(page).getByLabel('Byte 1').blur()
    await insp(page).getByLabel('Byte 2').fill('33'); await insp(page).getByLabel('Byte 2').blur()
    await insp(page).getByLabel('Every').fill('200')
    await save(page)
    await waitFor(async () => { const r = await row('canMessages', 4); return r.id === 0x7a6 && r.dlc === 3 && r.data[0] === 0x11 && r.data[2] === 0x33 && r.intervalMs === 200 && r.input === 1 }, 15_000, 'canmsg saved')
    // the module sends it (edits from the builder wait for Apply to car, G2: write them now)
    await post(`/api/devices/${pdm4.guid}/write`)
    await waitFor(async () => (await apiJson('GET', '/api/canlog')).some((m) => (m.id ?? m.Id) === 0x7a6), 15_000, 'frame 0x7A6 on the bus')
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('firmware 5.6.1: a Comfort blink block takes the levers, the clock, the tap time and the blink count', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot()
  try {
    if ((await row('comfortBlinks', 1)).enabled) await put(`/api/devices/${pdm4.guid}/function/comfortblink/1`, { enabled: false })
    await openFlow(page)
    await addBlock(page, 'Comfort blink')
    await waitFor(async () => { const r = await row('comfortBlinks', 1); return r.enabled && r.tapMs === 1000 && r.blinks === 3 }, 15_000, 'comfort blink added')
    await pickSource(page, 'leftInput', 'Hazard · State')
    await pickSource(page, 'rightInput', 'Brake · State')
    await pickSource(page, 'clockInput', 'Always On')
    await insp(page).getByLabel('A tap is shorter than').fill('0.8')
    await insp(page).getByLabel('Blinks for a tap').fill('4')
    await save(page)
    await waitFor(async () => { const r = await row('comfortBlinks', 1); return r.tapMs === 800 && r.blinks === 4 && r.leftInput > 0 && r.rightInput > 0 && r.clockInput === 1 }, 15_000, 'comfort blink saved')
    await expect(node(page, 'comfortblink:1')).toContainText('tap < 0.8 s: 4 blinks')
    await expect(insp(page).getByText(/blinks 4 times on/)).toBeVisible()
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('spare output o2: wire its input from the inspector and by dragging on the canvas, Undo restores it', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot()
  try {
    expect(snap.o2.enabled).toBe(false)   // spare: wiring it can't switch a load
    await openFlow(page, 'PDM-04', 'output:2')
    await expect(node(page, 'output:2')).toContainText('switched off')
    await node(page, 'output:2').click()
    await pickSource(page, 'input', 'Hazard · State')
    await save(page)
    const hazardIdx = (await apiJson('GET', `/api/devices/${pdm4.guid}/inputs`)).find((v) => v.name === 'Hazard').index
    await waitFor(async () => (await deviceByName('PDM-04')).outputs.find((o) => o.number === 2).inputVal === hazardIdx, 15_000, 'o2 input = Hazard')
    await page.getByTestId('tool-undo').click()
    await settle(page)
    await waitFor(async () => (await deviceByName('PDM-04')).outputs.find((o) => o.number === 2).inputVal === snap.o2.inputVal, 15_000, 'undo o2')
    // drag a wire: Brake state → o2 input
    const brake = (await apiJson('GET', `/api/devices/${pdm4.guid}/inputs`)).find((v) => v.name === 'Brake'), brakeIdx = brake.index
    await page.getByRole('button', { name: 'Tidy' }).click()
    const src = page.locator(`.svelte-flow__node[data-id="caninput:${brake.number}"] .svelte-flow__handle[data-handleid="v${brakeIdx}"]`)
    const dst = page.locator('.svelte-flow__node[data-id="output:2"] .svelte-flow__handle[data-handleid="input"]')
    await src.scrollIntoViewIfNeeded()
    await src.dragTo(dst)
    await settle(page)
    await waitFor(async () => (await deviceByName('PDM-04')).outputs.find((o) => o.number === 2).inputVal === brakeIdx, 15_000, 'o2 wired by drag')
    await page.keyboard.press('Control+z')
    await settle(page)
    await waitFor(async () => (await deviceByName('PDM-04')).outputs.find((o) => o.number === 2).inputVal === snap.o2.inputVal, 15_000, 'undo drag')
    await page.getByTestId('tool-undo').click()   // undo the Tidy (client-only)
    await settle(page)
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('simulate: switch inputs and inject faults in the browser; nothing reaches the module', async ({ page }) => {
  const errors = watchErrors(page)
  const cb1 = await deviceByName('CB-1')
  const before = JSON.stringify(await fns(cb1.guid))
  await openFlow(page, 'CB-1')
  await page.getByTestId('tool-sim').click()
  await expect(page.getByText('Simulating: nothing is sent to the car').first()).toBeVisible()
  const panel = page.getByRole('region', { name: 'Simulate inputs' }).or(page.locator('section[aria-label="Simulate inputs"]'))
  // Start button light = Ignition AND Gear in P AND NOT engine running
  const ign = panel.getByRole('button', { name: /^Ignition:/ })
  const pressed = await ign.getAttribute('aria-pressed')
  if (pressed === 'true') await ign.click()
  await expect(panel.getByRole('status').filter({ hasText: 'Start Button Light' })).toContainText('OFF')
  await ign.click()
  await expect(ign).toHaveAttribute('aria-pressed', 'true')
  // fault injection on the output
  await panel.getByRole('radiogroup', { name: 'Fault on Start Button Light' }).getByRole('radio', { name: /Overcurrent/ }).click()
  const outcome = panel.getByRole('status').filter({ hasText: 'Start Button Light' })
  await expect(outcome).toContainText(/TRIPPED|OFF/)
  await panel.getByRole('radiogroup', { name: 'Fault on Start Button Light' }).getByRole('radio', { name: /No fault/ }).click()
  await page.getByTestId('tool-sim').click()
  await expect(page.getByText('Simulating: nothing is sent to the car')).toHaveCount(0)
  expect(JSON.stringify(await fns(cb1.guid))).toBe(before)
  expect(errors).toEqual([])
})

test('suggestion banner: Replace groups blocks (a record on the server), Open inside, Undo, Not now, Replace all, block sheet', async ({ page }) => {
  const errors = watchErrors(page)
  const cb1 = await deviceByName('CB-1')
  const rec = () => apiJson('GET', `/api/groups/${cb1.guid}`)
  const saved = await rec()
  const before = JSON.stringify(await fns(cb1.guid))
  try {
    await apiJson('PUT', `/api/groups/${cb1.guid}`, { groups: [], dismissed: [] })
    await openFlow(page, 'CB-1')
    await expect(page.getByTestId('canvas').locator('.svelte-flow__node').first()).toBeVisible({ timeout: 15_000 })
    const sug = page.getByRole('region', { name: 'Suggestion' })
    await expect(sug).toContainText('Ready to start')
    await page.getByTestId('sug-replace').click()
    const grp = page.locator('.svelte-flow__node[data-id^="grp:"]')
    await expect(grp).toHaveCount(1)
    await expect(grp).toContainText('HELPER')
    await expect(node(page, 'virtualinput:1')).toHaveCount(0)
    await waitFor(async () => (await rec()).groups.some((g) => g.recipe === 'ready' && g.members.includes('virtualinput:1')), 5_000, 'group record on the server')
    const used = page.getByRole('region', { name: 'Group' })
    await used.getByRole('button', { name: 'Open inside' }).click()
    await expect(node(page, 'virtualinput:1')).toBeVisible()
    await expect(node(page, 'virtualinput:1')).toContainText('in Ready to start')
    await page.getByTestId('tool-undo').click()   // undo open inside
    await settle(page)
    await page.getByTestId('tool-undo').click()   // undo the grouping
    await expect(grp).toHaveCount(0)
    await expect(sug).toContainText('Ready to start')
    await page.getByTestId('sug-dismiss').click()
    await expect(sug).not.toContainText('Ready to start')
    await page.getByTestId('tool-undo').click()
    await settle(page)
    await expect(sug).toContainText('Ready to start')
    if (!(await page.getByTestId('replace-all').isVisible())) await page.getByTestId('tool-palette').click()
    await page.getByTestId('replace-all').click()
    await expect(page.locator('.svelte-flow__node[data-id^="grp:"]')).toHaveCount(3)
    // the blocks on the module did not change
    expect(JSON.stringify(await fns(cb1.guid))).toBe(before)
    await page.getByRole('button', { name: 'Block sheet' }).click()
    const sheet = page.getByRole('dialog', { name: /Block sheet/ })
    await expect(sheet).toContainText('US rear lamp')
    await expect(sheet).toContainText('Wipers & washer')
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
  } finally {
    await apiJson('PUT', `/api/groups/${cb1.guid}`, saved)
  }
  expect(errors).toEqual([])
})

test('keyboard: Tab walks blocks, Enter opens the inspector, / opens Add; search finds a block', async ({ page }) => {
  const errors = watchErrors(page)
  await openFlow(page, 'CB-1')
  const first = page.getByTestId('canvas').locator('.svelte-flow__node').first()
  await first.focus()
  await page.keyboard.press('Tab')
  const focusedId = await page.evaluate(() => document.activeElement?.getAttribute('data-id'))
  expect(focusedId).toBeTruthy()
  await page.keyboard.press('Enter')
  await expect(insp(page).getByText('· SELECTED')).toBeVisible()
  await page.keyboard.press('/')
  await expect(page.getByRole('dialog', { name: 'Add a block' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Add a block' }).getByTestId('add-Math')).toBeEnabled()   // firmware 5.6 on the Sim
  await page.keyboard.press('Escape')
  await page.getByTestId('tool-palette').click()
  await page.getByTestId('find').fill('gear in')
  await page.getByRole('list', { name: 'Matching blocks' }).getByRole('button', { name: /Gear in P/ }).click()
  await expect(insp(page).getByRole('heading', { level: 2 })).toHaveText('Gear in P')
  expect(errors).toEqual([])
})

test('Apply to car warns about unfinished blocks first', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot()
  try {
    for (const n of [30, 31, 32]) if ((await row('conditions', n)).enabled) await put(`/api/devices/${pdm4.guid}/function/condition/${n}`, { enabled: false })
    await put(`/api/devices/${pdm4.guid}/function/condition/32`, { enabled: true, input: 0, name: 'c2 unfinished' })
    await openFlow(page)
    await expect(node(page, 'condition:32')).toContainText('needs an input')
    await page.getByTestId('tool-apply').click()
    const dlg = page.getByRole('dialog', { name: 'Apply with unfinished blocks?' })
    await expect(dlg).toContainText('c2 unfinished')
    await dlg.getByRole('button', { name: 'Go back and finish them' }).click()
    await expect(insp(page).getByRole('heading', { level: 2 })).toHaveText('c2 unfinished')
    await page.getByTestId('tool-apply').click()
    await page.getByRole('dialog', { name: 'Apply with unfinished blocks?' }).getByRole('button', { name: 'Apply anyway' }).click()
    await expect(page.getByRole('dialog', { name: 'Apply to car' })).toBeVisible()
    await page.keyboard.press('Escape')
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('Tidy re-lays the canvas and Undo puts the positions back', async ({ page }) => {
  const errors = watchErrors(page)
  const d = await openFlow(page, 'CB-2')
  const k = 'dingoNextFlowPos:' + d.guid
  const before = await page.evaluate((key) => localStorage.getItem(key), k)
  await page.getByRole('button', { name: 'Tidy' }).click()
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), k)).not.toBe(before)
  await page.getByTestId('tool-undo').click()
  await settle(page)
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key) ?? null, k)).toBe(before ?? '{}')
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await page.getByRole('button', { name: 'Fit' }).click()
  expect(errors).toEqual([])
})

test('signal from another module adds a CAN input that reads it over CAN @exclusive', async ({ page }) => {
  // writes PDM-04 CAN input 32 (outside the shared test targets), so it runs alone
  const errors = watchErrors(page)
  const before = (await fns(pdm4.guid)).canInputs.find((x) => x.number === 32)
  test.skip(before.enabled, 'PDM-04 CAN input 32 is in use')
  try {
    await openFlow(page)
    if (!(await page.getByTestId('add-remote').isVisible())) await page.getByTestId('tool-palette').click()
    await page.getByTestId('add-remote').click()
    const dlg = page.getByRole('dialog', { name: 'Signal from another module' })
    await dlg.getByRole('button', { name: 'From module or ECU', exact: true }).click()
    await page.getByRole('option', { name: /^CB-1/ }).click()
    await dlg.getByLabel('Find a signal').fill('DigitalInput8')
    await dlg.getByRole('radio').first().click()
    await dlg.getByRole('button', { name: 'Add CAN input' }).click()
    await waitFor(async () => (await fns(pdm4.guid)).canInputs.find((x) => x.number === 32).enabled, 15_000, 'can input 32 linked')
    await expect(node(page, 'caninput:32')).toContainText('CAN')
    await page.getByTestId('tool-undo').click()
    await settle(page)
    await waitFor(async () => !(await fns(pdm4.guid)).canInputs.find((x) => x.number === 32).enabled, 15_000, 'undo link')
  } finally {
    const { number, ...body } = before
    await post(`/api/devices/${pdm4.guid}/function/caninput/32`, body)
  }
  expect(errors).toEqual([])
})

test('group records are checked by the server: one block in one group, a known module, a real member id (G16)', async () => {
  const cb1 = await deviceByName('CB-1')
  const put = (guid, body) => fetch(`${API}/api/groups/${guid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const g = (id, members) => ({ id, recipe: 'threshold', kind: 'helper', name: 'T', members })
  const twice = await put(cb1.guid, { groups: [g('a', ['condition:1']), g('b', ['condition:1'])], dismissed: [] })
  expect(twice.status).toBe(400)
  expect((await twice.json()).error).toMatch(/already in another group/)
  expect((await put(cb1.guid, { groups: [g('a', ['drop table'])] })).status).toBe(400)
  expect((await put(cb1.guid, { groups: [{ ...g('a', ['condition:1']), kind: 'macro' }] })).status).toBe(400)
  expect((await put('00000000-0000-0000-0000-000000000000', { groups: [] })).status).toBe(404)
})
