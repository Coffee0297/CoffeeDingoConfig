// ui-fn: every kind of function block the flow builder adds, created, edited (good and bad values), applied to the module
// through the Apply panel, read back from the module, and removed again. Writes only free slots of PDM-04 and its spare
// output 8 (switched off, no input in the Ranchero project); everything is put back in `finally`.
import { test, expect } from '@playwright/test'
import { watchErrors } from './helpers.js'
import { near, waitFor, deviceByName } from './api.js'
import { fns, vmap, node, insp, snapshot, restore, openFlow, settle, addBlock, pickSource, choose, save, saveRefused, applyModule, readModule } from './ui-fn-helpers.js'

const MOD = 'PDM-04'
let g
const row = async (arr, n) => (await fns(g))[arr].find((x) => x.number === n)
test.describe.configure({ timeout: 420_000 })
test.beforeAll(async () => { g = (await deviceByName(MOD)).guid })

test('curve: points, a falling X refused, applied, read back from the module, removed', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(MOD)
  try {
    await openFlow(page, MOD)
    const n = await addBlock(page, g, 'Curve', 'curves')
    await expect(node(page, 'curve:' + n)).toBeVisible()
    await insp(page).getByLabel('Name').fill('ui-fn fan curve')
    await pickSource(page, 'input', 'Battery Voltage')
    await insp(page).getByLabel('Points (2–12)').fill('3')
    for (const [i, x, y] of [[1, 10, 0], [2, 12, 40], [3, 11, 100]]) { await insp(page).getByLabel('X of point ' + i).fill(String(x)); await insp(page).getByLabel('Y of point ' + i).fill(String(y)) }
    await saveRefused(page, /X|rise|above/)
    await insp(page).getByLabel('X of point 3').fill('14')
    await save(page)
    await waitFor(async () => { const r = await row('curves', n); return r.name === 'ui-fn fan curve' && r.points === 3 && r.x[2] === 14 && r.y[1] === 40 && r.input === 4 }, 15_000, 'curve saved in the project')
    await applyModule(page, MOD)
    await readModule(page, MOD)
    const r = await row('curves', n)
    expect([r.enabled, r.points, r.x.slice(0, 3), r.y.slice(0, 3), r.input]).toEqual([true, 3, [10, 12, 14], [0, 40, 100], 4])
    // reload: the inspector shows what the module holds
    await page.reload()
    await pick(page, 'curve:' + n)
    await expect(insp(page).getByLabel('Y of point 2')).toHaveValue('40')
    await insp(page).getByTestId('insp-remove').click()
    await page.getByTestId('confirm-remove').click()
    await settle(page)
    await waitFor(async () => !(await row('curves', n)).enabled, 15_000, 'curve removed')
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('PID: on PDM-04 its frame lands on PDM-05 and Apply says so; on PDM-05: fixed setpoint, gains, crossed limits refused, applied and read back', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(MOD), snap5 = await snapshot('PDM-05'), g5 = snap5.guid
  try {
    // a 5.7 PDM sends its PID frame past base + 31: in the Ranchero (PDMs 0x20 apart) that is the next PDM's id
    await openFlow(page, MOD)
    await addBlock(page, g, 'PID', 'pids')
    await pickSource(page, 'processInput', 'Battery Voltage')
    await save(page)
    await page.getByTestId('tool-apply').click()
    const panel = page.getByRole('dialog', { name: 'Apply to car' })
    await expect(panel.getByTestId('apply-checks')).toContainText(/PDM-04 · CAN id 0x7[0-9A-F]{2} is sent by more than one device: PDM-05: broadcast, PDM-04: broadcast/)
    await expect(panel.getByRole('button', { name: 'Apply PDM-04', exact: true }).first()).toBeDisabled()
    await page.keyboard.press('Escape')
    await restore(snap)
    // PDM-05 has the highest base: its PID frame is free
    await openFlow(page, 'PDM-05')
    const n = await addBlock(page, g5, 'PID', 'pids')
    const row5 = async () => (await fns(g5)).pids.find((x) => x.number === n)
    await pickSource(page, 'processInput', 'Battery Voltage')
    await insp(page).getByLabel('Fixed setpoint').fill('13.2')
    await insp(page).getByRole('radiogroup', { name: 'The output rises while the measured value is' }).getByRole('radio', { name: /above it/ }).click()
    await insp(page).getByLabel('Kp').fill('2.5')
    await insp(page).getByLabel('Ki').fill('0.5')
    await insp(page).getByLabel('Output min').fill('80')
    await insp(page).getByLabel('Output max').fill('20')
    await saveRefused(page, /output min is above output max/i)
    await insp(page).getByLabel('Output min').fill('10')
    await insp(page).getByLabel('Output max').fill('90')
    await insp(page).getByLabel('Update every').fill('50')
    await save(page)
    await waitFor(async () => { const r = await row5(); return r.processInput === 4 && near(r.setpoint, 13.2) && r.invert && near(r.kp, 2.5) && r.outMax === 90 && r.periodMs === 50 }, 15_000, 'pid saved')
    await applyModule(page, 'PDM-05')
    await readModule(page, 'PDM-05')
    const r = await row5()
    expect(r.enabled).toBe(true)
    expect([near(r.setpoint, 13.2), near(r.kp, 2.5), near(r.ki, 0.5), r.outMin, r.outMax, r.periodMs, r.invert]).toEqual([true, true, true, 10, 90, 50, true])
  } finally { await restore(snap); await restore(snap5) }
  expect(errors).toEqual([])
})

test('latch and gate: types, auto-off time checked, a gate drives the spare output o8 live', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(MOD)
  try {
    await o8On(); await openFlow(page, MOD)
    // latch: set / reset, auto-off 2.5 s; 700 s is refused
    const l = await addBlock(page, g, 'Latch (set / reset)', 'latchGates')
    await pickSource(page, 'input', 'Hazard · State')
    await pickSource(page, 'controlInput', 'Brake · State')
    await insp(page).getByLabel('Turn off by itself after (0 = never)').fill('700')
    await saveRefused(page, /0 to 600 s/)
    await insp(page).getByLabel('Turn off by itself after (0 = never)').fill('2.5')
    await save(page)
    await waitFor(async () => { const r = await row('latchGates', l); return r.type === 0 && r.timeMs === 2500 && r.input === 17 && r.controlInput === 15 }, 15_000, 'latch saved')
    // gate: value = battery voltage while Always On; a Compare "gate > 5" drives o8
    const gt = await addBlock(page, g, 'Gate (hold a value)', 'latchGates')
    await expect(insp(page).getByTestId('src-controlInput')).toBeVisible()   // the ports follow the type: Value / Enable
    await pickSource(page, 'input', 'Battery Voltage')
    await pickSource(page, 'controlInput', 'Always On')
    await save(page)
    const gIdx = (await vmap(g)).find((v) => v.kind === 'latchgate' && v.number === gt).index
    const c = await addBlock(page, g, 'Compare', 'conditions')
    await pickSource(page, 'input', `Latch/Gate ${gt}`)
    await choose(page, 'Is', /is above/)
    await insp(page).getByLabel('Value', { exact: true }).fill('5')
    await save(page)
    await waitFor(async () => (await row('conditions', c)).input === gIdx, 15_000, 'compare reads the gate')
    const cIdx = (await vmap(g)).find((v) => v.kind === 'condition' && v.number === c && v.type === 'bool')?.index ?? (await vmap(g)).find((v) => v.kind === 'condition' && v.number === c).index
    await wireO8(page, `condition${c} · Result`, cIdx)
    await applyModule(page, MOD)
    await waitFor(async () => (await deviceByName(MOD)).outputs.find((o) => o.number === 8).state === 'On', 30_000, 'o8 on from the gate')
    await readModule(page, MOD)
    expect((await row('latchGates', gt))).toMatchObject({ enabled: true, type: 1, input: 4, controlInput: 1 })
    expect((await row('latchGates', l))).toMatchObject({ enabled: true, type: 0, timeMs: 2500 })
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('Combine NOR and Compare AND / NAND read 0 or 1, delays checked, each seen live on o8', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(MOD)
  const o8 = async () => (await deviceByName(MOD)).outputs.find((o) => o.number === 8).state
  try {
    await o8On(); await openFlow(page, MOD)
    // NOR of Always On = 0; with NOT on In 1 it is 1
    const v = await addBlock(page, g, 'Combine AND / OR / NOR', 'virtualInputs')
    await insp(page).getByLabel('Name').fill('ui-fn nor')
    await pickSource(page, 'var0', 'Always On')
    await insp(page).getByRole('radiogroup', { name: 'First join' }).getByRole('radio', { name: 'NOR', exact: true }).click()
    await save(page)
    const vIdx = (await vmap(g)).find((x) => x.kind === 'virtualinput' && x.number === v).index
    await wireO8(page, 'ui-fn nor · State', vIdx)
    await applyModule(page, MOD)
    await waitFor(async () => (await o8()) === 'Off', 30_000, 'NOR(on) = off')
    await pick(page, 'virtualinput:' + v)
    await insp(page).getByRole('button', { name: 'NOT on In 1' }).click()
    await save(page)
    await applyModule(page, MOD)
    await waitFor(async () => (await o8()) === 'On', 30_000, 'NOR(NOT on) = on')
    // Compare "has bits" (AND): Always On & 1 = 1; "has not bits" (NAND): 0. Delay 61 s is refused, 1.5 s is kept.
    const c = await addBlock(page, g, 'Compare', 'conditions')
    await pickSource(page, 'input', 'Always On')
    await choose(page, 'Is', /has bits/)
    await insp(page).getByLabel('Value', { exact: true }).fill('1')
    await insp(page).getByLabel('Delay on').fill('61')
    await saveRefused(page, 'Delays must be 0 to 60 s.')
    await insp(page).getByLabel('Delay on').fill('1.5')
    await save(page)
    const cIdx = (await vmap(g)).find((x) => x.kind === 'condition' && x.number === c).index
    await wireO8(page, `condition${c} · Result`, cIdx)
    await applyModule(page, MOD)
    await waitFor(async () => (await o8()) === 'On', 30_000, 'AND reads 1')
    await pick(page, 'condition:' + c)
    await choose(page, 'Is', /has not bits/)
    await save(page)
    await applyModule(page, MOD)
    await waitFor(async () => (await o8()) === 'Off', 30_000, 'NAND reads 0')
    await readModule(page, MOD)
    expect(await row('conditions', c)).toMatchObject({ enabled: true, operator: 7, arg: 1, delayOn: 1500, input: 1 })
    expect(await row('virtualInputs', v)).toMatchObject({ enabled: true, not0: true, cond0: 2, var0: 1 })
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('counter: edges, wrap, hold to reset, keep across power-off; max not above min refused', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(MOD)
  try {
    await openFlow(page, MOD)
    const n = await addBlock(page, g, 'Counter', 'counters')
    await pickSource(page, 'incInput', 'Hazard · State')
    await pickSource(page, 'decInput', 'Brake · State')
    await insp(page).getByRole('spinbutton', { name: 'Min', exact: true }).fill('3')
    await insp(page).getByRole('spinbutton', { name: 'Max', exact: true }).fill('3')
    await saveRefused(page, 'Max must be above min.')
    await insp(page).getByRole('spinbutton', { name: 'Min', exact: true }).fill('0')
    await insp(page).getByRole('spinbutton', { name: 'Max', exact: true }).fill('5')
    await choose(page, 'Up on', 'Falling')
    await insp(page).getByText('Wrap round past max').click()
    await insp(page).getByText('Hold to reset').click()
    await insp(page).getByLabel('Hold for').fill('1500')
    const keep = insp(page).getByText('Keep the count across power-off')
    if (await keep.count()) await keep.click()
    await save(page)
    await applyModule(page, MOD)
    await readModule(page, MOD)
    const r = await row('counters', n)
    expect(r).toMatchObject({ enabled: true, minCount: 0, maxCount: 5, incEdge: 1, wrapAround: true, holdToReset: true, resetTime: 1500, incInput: 17, decInput: 15 })
    if (await keep.count()) expect(r.retain).toBe(true)
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('CAN input: timeout is opt-in, its value is used only when ticked, and a missing frame drives o8 live', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(MOD)
  try {
    await o8On(); await openFlow(page, MOD)
    const n = await addBlock(page, g, 'CAN input', 'canInputs')
    await insp(page).getByLabel('Name').fill('ui-fn coolant')
    await insp(page).getByLabel('CAN ID (hex)').fill('0x7C9')   // nothing sends it
    await insp(page).getByLabel('Length (bits)').fill('8')
    await expect(insp(page).getByLabel('Timeout', { exact: true })).toHaveCount(0)
    await insp(page).getByText('Off when no frame arrives (timeout)').click()
    await insp(page).getByLabel('Timeout', { exact: true }).fill('500')
    const val = insp(page).getByLabel('Then the value is')
    await expect(val).toBeDisabled()   // 5.7: reads 0 unless "Use this value instead of 0" is ticked
    await insp(page).getByText('Use this value instead of 0').click()
    await expect(val).toBeEnabled()
    await val.fill('120')
    await save(page)
    await waitFor(async () => { const r = await row('canInputs', n); return r.id === 0x7c9 && r.timeoutEnabled && r.timeout === 500 && r.timeoutUseValue && r.timeoutValue === 120 }, 15_000, 'can input saved')
    // value > 100 → o8: the frame never comes, so after the timeout the value is 120
    const valIdx = (await vmap(g)).find((x) => x.kind === 'caninput' && x.number === n && x.type !== 'bool').index
    const c = await addBlock(page, g, 'Compare', 'conditions')
    await pickSource(page, 'input', 'ui-fn coolant · Value')
    await choose(page, 'Is', /is above/)
    await insp(page).getByLabel('Value', { exact: true }).fill('100')
    await save(page)
    expect((await row('conditions', c)).input).toBe(valIdx)
    await wireO8(page, `condition${c} · Result`, (await vmap(g)).find((x) => x.kind === 'condition' && x.number === c).index)
    await applyModule(page, MOD)
    await waitFor(async () => (await deviceByName(MOD)).outputs.find((o) => o.number === 8).state === 'On', 30_000, 'o8 on from the timeout value')
    await readModule(page, MOD)
    expect(await row('canInputs', n)).toMatchObject({ enabled: true, timeoutEnabled: true, timeout: 500, timeoutUseValue: true, timeoutValue: 120 })
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('CAN outputs: a signal and an XOR checksum in one frame, the checksum on the bus is right; a trigger warns the frame peers', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(MOD)
  const { apiJson } = await import('./api.js')
  try {
    await openFlow(page, MOD)
    const a = await addBlock(page, g, 'CAN output', 'canOutputs')
    await pickSource(page, 'input', 'Always On')
    await insp(page).getByLabel('CAN ID (hex)').fill('0x7B4')
    await insp(page).getByLabel('Start bit').fill('0')
    await insp(page).getByLabel('Length (bits)').fill('8')
    await insp(page).getByLabel('÷ Factor').fill('0.2')   // a DBC scale: the frame holds value ÷ factor (Always On: 1 ÷ 0.2 = 5)
    await expect(insp(page)).toContainText('The frame holds (value − offset) ÷ factor')
    await insp(page).getByLabel('Every').fill('100')
    await save(page)
    const b = await addBlock(page, g, 'CAN output', 'canOutputs')
    await insp(page).getByTestId('cout-kind').click()
    await page.getByRole('option', { name: 'Checksum XOR' }).click()
    await expect(insp(page).getByLabel('Length (bits)')).toBeDisabled()
    await insp(page).getByLabel('CAN ID (hex)').fill('0x7B4')
    await insp(page).getByLabel('Start bit').fill('59')   // snapped to the byte on save: 56
    await saveRefused(page, /whole byte/)
    await insp(page).getByLabel('Start bit').fill('56')
    await insp(page).getByLabel('Every').fill('100')
    await save(page)
    expect(await row('canOutputs', b)).toMatchObject({ kind: 2, startBit: 56, bitLength: 8, id: 0x7b4 })
    await applyModule(page, MOD)
    const f = await waitFor(async () => (await apiJson('GET', '/api/canlog')).filter((m) => (m.id ?? m.Id) === 0x7b4).at(-1), 20_000, 'frame 0x7B4 on the bus')
    const d = (f.data ?? f.Data ?? f.payload)
    const bytes = Array.isArray(d) ? d : String(d).trim().split(/[\s,]+/).map((x) => parseInt(x, 16))
    expect(bytes[0]).toBe(5)   // Always On (1) ÷ 0.2
    expect(bytes[7]).toBe(bytes.slice(0, 7).reduce((x, y) => x ^ y, 0))
    // a trigger on the signal output: the checksum output has none and is told the frame now goes out on triggers only
    await pick(page, 'canoutput:' + a)
    await pickSource(page, 'triggerInput', 'Hazard · State')
    await expect(insp(page).getByLabel('Every')).toBeDisabled()
    await save(page)
    await pick(page, 'canoutput:' + b)
    await expect(insp(page).getByRole('status').filter({ hasText: /has a trigger/ })).toBeVisible()
    expect((await row('canOutputs', a)).triggerInput).toBe(17)
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

test('timer "Pulse, restarts" (5.7): the canvas, the inspector and the sentence view use the same name; 11 min refused', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(MOD)
  try {
    await openFlow(page, MOD)
    const n = await addBlock(page, g, 'Pulse / limit', 'timers')
    await insp(page).getByLabel('Name').fill('ui-fn pulse')
    await pickSource(page, 'input', 'Hazard · State')
    await expect(insp(page).getByRole('radiogroup', { name: 'Kind' }).getByRole('radio', { name: 'Pulse, restarts' })).toBeChecked()
    await expect(insp(page).getByRole('radiogroup', { name: 'Kind' }).getByRole('radio', { name: 'One pulse' })).toBeVisible()
    await insp(page).getByLabel('Time').fill('660')
    await saveRefused(page, 'Time must be 0 to 10 minutes.')
    await insp(page).getByLabel('Time').fill('1.5')
    await save(page)
    await expect(node(page, 'timer:' + n)).toContainText('Pulse, restarts · 1.5 s')
    await page.getByRole('radiogroup', { name: 'Builder view' }).getByRole('radio', { name: 'Sentence view' }).click()
    const card = page.getByRole('article', { name: 'ui-fn pulse' })
    await expect(card).toContainText('TIMER · PULSE, RESTARTS')
    await expect(card).toContainText('pulse each time')
    await card.getByRole('button', { name: /^Hazard/ }).click()
    await expect(insp(page).getByRole('heading', { level: 2 })).toHaveText('Hazard')
    await card.getByRole('button', { name: 'Show on canvas' }).click()
    await expect(page.getByTestId('canvas')).toBeVisible()
    await applyModule(page, MOD)
    await readModule(page, MOD)
    expect(await row('timers', n)).toMatchObject({ enabled: true, mode: 2, preset: 1500, input: 17 })
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

/** Wire PDM-04's spare output 8 to var `idx` and switch it on (its own inspector; Enabled is set on the Hardware page). */
/** Switch the spare o8 on (no input yet) before the canvas opens: a spare output that is off is not drawn. */
async function o8On() {
  const { putOutput } = await import('./b-helpers.js')
  const o = (await deviceByName(MOD)).outputs.find((x) => x.number === 8)
  if (!o.enabled) await putOutput(g, { ...o, enabled: true, currentLimit: 5 })
}
async function wireO8(page, label, idx) {
  await pick(page, 'output:8')
  await insp(page).getByTestId('src-input').click()
  await page.getByRole('option', { name: label, exact: true }).click()   // this module's block, not a same-named one over CAN
  await save(page)
  await waitFor(async () => (await deviceByName(MOD)).outputs.find((x) => x.number === 8).inputVal === idx, 15_000, 'o8 wired')
}
/** Open a block in the inspector from the keyboard: on the wide 5.7 canvas it can sit outside the visible part. */
async function pick(page, id) {
  await node(page, id).focus()
  await page.keyboard.press('Enter')
  await expect(insp(page).getByText('· SELECTED')).toBeVisible()
}
