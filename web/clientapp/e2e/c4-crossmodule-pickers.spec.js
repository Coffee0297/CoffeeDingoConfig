// Cross-module pickers (C4): every source picker that offers another module's signal (or an ECU signal from
// the project's DBC) claims a CAN input on its own module when it is used. Each test picks through the UI,
// checks the claimed CAN input (id / bits) and the field that now reads it, checks the behaviour on the Sim
// where it can, and puts every module it touched back as it was.
import { test, expect } from '@playwright/test'
import { open, watchErrors } from './helpers.js'
import { apiJson, deviceByName, devices, waitFor, API } from './api.js'
import { putOutput, saveAndWait } from './b-helpers.js'
import fs from 'node:fs'

test.describe.configure({ timeout: 180_000 })
test.use({ actionTimeout: 30_000 })

// These checks use the Ranchero's blocks (PDM-05 "Position" …: run them with that project loaded and written to
// the modules) and an ECU device built from the car's DBC (a GM Global A HS file, not kept in the repo: C4_DBC).
const C4_DBC = process.env.C4_DBC
let addedEcu = null
test.beforeAll(async () => {
  test.setTimeout(120_000)
  const p5 = await deviceByName('PDM-05')
  test.skip(!(await fns(p5.guid)).virtualInputs.some((v) => v.number === 14 && v.enabled && v.name === 'Position'), 'needs the Ranchero project loaded')
  if ((await devices()).some((d) => /dbc/i.test(d.type))) return
  test.skip(!C4_DBC || !fs.existsSync(C4_DBC), "set C4_DBC to the car's DBC file")
  const r = await fetch(`${API}/api/devices/dbc-import?name=${encodeURIComponent('Car ECU (Global A HS)')}&base=0&rebase=false`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: fs.readFileSync(C4_DBC, 'utf8') })
  if (!r.ok) throw new Error('DBC import failed: ' + (await r.text()))
  addedEcu = (await r.json()).guid
})
test.afterAll(async () => { if (addedEcu) await apiJson('POST', `/api/devices/${addedEcu}/remove`).catch(() => {}) })

// ---------------------------------------------------------------- helpers
const SIM = 'http://127.0.0.1:8787/mcp'
async function sim(name, args) {
  const r = await fetch(SIM, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const t = (await r.json()).result.content[0].text
  try { return JSON.parse(t) } catch { return t }
}
const simOut = async (mod, n) => (await sim('sim_state', { module: mod })).modules.outputs.find((o) => o.n === n)?.state
const simSwitch = (node, on) => sim('sim_switch', { node, state: on })
const simInputs = async (mod) => (await sim('sim_state', { module: mod })).modules.inputs

const fns = (guid) => apiJson('GET', `/api/devices/${guid}/functions`)
const vars = (guid) => apiJson('GET', `/api/devices/${guid}/inputs`)
const KIND = { canInputs: 'caninput', canOutputs: 'canoutput', virtualInputs: 'virtualinput', conditions: 'condition', maths: 'math', counters: 'counter', flashers: 'flasher', timers: 'timer', keypads: 'keypad' }

/** Everything a picker can change on these modules: outputs, function rows, ignition, device inputs. */
async function snapshot(names) {
  const out = []
  for (const n of names) {
    const d = await deviceByName(n)
    out.push({ d, outputs: JSON.parse(JSON.stringify(d.outputs ?? [])), f: await fns(d.guid) })
  }
  return out
}
async function retry(fn, tries = 4) {
  let last
  for (let i = 0; i < tries; i++) { try { return await fn() } catch (e) { last = e; await new Promise((r) => setTimeout(r, 2000)) } }
  throw last
}
/** Put back every row that differs from the snapshot, then write each module whole. */
async function restore(snap) {
  for (const { d, outputs, f } of snap) {
    const now = await fns(d.guid)
    for (const [arr, kind] of Object.entries(KIND))
      for (const row of f[arr] ?? []) {
        const cur = (now[arr] ?? []).find((x) => x.number === row.number)
        if (cur && JSON.stringify(cur) !== JSON.stringify(row)) await retry(() => apiJson('POST', `/api/devices/${d.guid}/function/${kind}/${row.number}`, row))
      }
    if (f.ignition && JSON.stringify(now.ignition) !== JSON.stringify(f.ignition)) await retry(() => apiJson('POST', `/api/devices/${d.guid}/function/ignition/1`, f.ignition))
    const live = await deviceByName(d.name)
    for (const o of outputs) {
      const cur = live.outputs.find((x) => x.number === o.number)
      if (JSON.stringify(cur) === JSON.stringify(o)) continue
      if (['enabled', 'inputVal', 'pwmEnabled', 'variableDutyCycle', 'dutyCycleInput', 'name', 'currentLimit'].some((k) => cur?.[k] !== o[k])) await putOutput(d.guid, o)
    }
    // a CANBoard has no force-sleep input: send only what changed
    const di = { ...(live.forceSleepInput !== d.forceSleepInput ? { ForceSleepInput: d.forceSleepInput } : {}), ...(live.muteTxInput !== d.muteTxInput ? { MuteTxInput: d.muteTxInput } : {}) }
    if (Object.keys(di).length) await retry(() => apiJson('POST', `/api/devices/${d.guid}/device-inputs`, di))
    await apiJson('POST', `/api/devices/${d.guid}/writeall`, undefined, 60_000).catch(() => {})
  }
}
/** CAN inputs enabled now that were not in the snapshot row set (or changed). */
async function newCanInputs(snapEntry) {
  const now = await fns(snapEntry.d.guid)
  return now.canInputs.filter((c) => c.enabled && JSON.stringify(c) !== JSON.stringify(snapEntry.f.canInputs.find((x) => x.number === c.number)))
}
/** The var index of a CAN input's State (bool) or Value (num) port. */
async function ciVar(guid, number, prop = 'State') {
  return (await vars(guid)).find((v) => v.kind === 'caninput' && v.number === number && v.prop === prop)?.index
}
/** Pick an option from a kit Select by trigger test id, typing into its search box first. */
async function pickFrom(page, trigger, query, option) {
  await trigger.click()
  const box = page.getByRole('searchbox')
  if (query) await box.fill(query)
  await page.getByRole('option', { name: option }).first().click()
}
const writeAll = (guid) => retry(() => apiJson('POST', `/api/devices/${guid}/writeall`, undefined, 60_000))

// CB-1 broadcasts its switches in base+4 (bit 32 + n-1): Horn is DI2, Hazard DI8
const cbFrame = async () => (await deviceByName('CB-1')).baseId + 4

// ---------------------------------------------------------------- 1. output: what turns it on
test('output page: a CB-1 switch over CAN drives a spare output, and the output follows it on the Sim @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-05'])
  const pdm = snap[0].d
  try {
    await simSwitch('CB-1.di2', false)
    await open(page, `hardware/module/${pdm.guid}/output/8`)
    await pickFrom(page, page.getByTestId('driver-select'), 'Horn · CB-1', /^Horn · CB-1 \(over CAN\)$/)
    await expect(page.getByTestId('driver-select')).toContainText('Horn', { timeout: 20_000 })
    // the output needs a trip point to be switched on
    await saveAndWait(page)
    const made = await newCanInputs(snap[0])
    expect(made.length).toBe(1)
    expect(made[0]).toMatchObject({ id: await cbFrame(), startBit: 33, bitLength: 1, ide: false })
    const idx = await ciVar(pdm.guid, made[0].number)
    await waitFor(async () => (await deviceByName('PDM-05')).outputs.find((o) => o.number === 8).inputVal === idx, 15_000, 'o8 reads the CAN input')
    // on the Sim: write it, then the horn switch on CB-1 turns PDM-05 o8 on
    const o8 = (await deviceByName('PDM-05')).outputs.find((o) => o.number === 8)
    if (!(o8.currentLimit > 0)) await putOutput(pdm.guid, { ...o8, currentLimit: 5 })
    await writeAll(pdm.guid)
    await waitFor(async () => (await simOut('PDM-05', 8)) === 'Off', 10_000, 'o8 off while the horn is off')
    await simSwitch('CB-1.di2', true)
    await waitFor(async () => (await simOut('PDM-05', 8)) === 'On', 10_000, 'o8 follows the horn switch on')
    await simSwitch('CB-1.di2', false)
    await waitFor(async () => (await simOut('PDM-05', 8)) === 'Off', 10_000, 'o8 follows the horn switch off')
  } finally { await simSwitch('CB-1.di2', false); await restore(snap) }
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- 2. compare / combine builders
test('compare builder: a CB-1 number over CAN reuses the CAN input that already reads it @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-05'])
  const pdm = snap[0].d
  const frame = await cbFrame()
  const had = snap[0].f.canInputs.find((c) => c.enabled && c.id === frame && c.startBit === 0 && c.bitLength === 4)   // "Lights (Park+)" reads the headlight rotary
  try {
    await sim('sim_rotary', { node: 'CB-1.ai1', index: 0 })
    await open(page, `hardware/module/${pdm.guid}/output/1`)
    await page.getByRole('button', { name: '+ Compare' }).click()
    const dlg = page.getByRole('dialog', { name: 'New compare block' })
    await dlg.getByLabel('Name (optional)').fill('MCPVAL c4 headlights on')
    await pickFrom(page, page.getByRole('button', { name: 'Value to compare', exact: true }), 'Headlights', /^Headlights · Pos · CB-1 \(over CAN\)$/)
    await page.getByRole('button', { name: 'It is on when the value', exact: true }).click()
    await page.getByRole('option', { name: 'is above', exact: true }).click()
    await dlg.getByLabel('This number').fill('1')
    await page.getByTestId('create-compare').click()
    await expect(dlg).toHaveCount(0)
    await expect(page.getByTestId('lane-input')).toContainText('MCPVAL c4 headlights on')
    await saveAndWait(page)
    // no new CAN input: the one that already decodes that slice is reused; the compare reads its Value
    expect(await newCanInputs(snap[0])).toEqual([])
    const cond = (await fns(pdm.guid)).conditions.find((c) => c.name === 'MCPVAL c4 headlights on')
    expect(cond).toMatchObject({ enabled: true, operator: 2, arg: 1 })
    expect(had).toBeTruthy()
    expect(cond.input).toBe(await ciVar(pdm.guid, had.number, 'Value'))
    const cv = (await vars(pdm.guid)).find((v) => v.kind === 'condition' && v.number === cond.number).index
    await waitFor(async () => (await deviceByName('PDM-05')).outputs.find((o) => o.number === 1).inputVal === cv, 15_000, 'o1 reads the compare')
    // on the Sim: headlight rotary past 1 turns o1 on
    const o1 = (await deviceByName('PDM-05')).outputs.find((o) => o.number === 1)
    if (!(o1.currentLimit > 0)) await putOutput(pdm.guid, { ...o1, currentLimit: 5 })
    await writeAll(pdm.guid)
    await waitFor(async () => (await simOut('PDM-05', 1)) === 'Off', 10_000, 'o1 off at position 0')
    await sim('sim_rotary', { node: 'CB-1.ai1', index: 2 })
    await waitFor(async () => (await simOut('PDM-05', 1)) === 'On', 10_000, 'o1 on at position 2')
  } finally { await sim('sim_rotary', { node: 'CB-1.ai1', index: 0 }); await restore(snap) }
  expect(errors).toEqual([])
})

test('combine builder: two CB-1 switches over CAN, OR, drive a spare output on the Sim @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-05'])
  const pdm = snap[0].d
  try {
    await simSwitch('CB-1.di1', false); await simSwitch('CB-1.di2', false)
    await open(page, `hardware/module/${pdm.guid}/output/1`)
    await page.getByRole('button', { name: '+ Combine' }).click()
    const dlg = page.getByRole('dialog', { name: 'New combine block' })
    await dlg.getByLabel('Name (optional)').fill('MCPVAL c4 washer or horn')
    await pickFrom(page, page.getByRole('button', { name: 'Signal 1', exact: true }), 'Washer · CB-1', /^Washer · CB-1 \(over CAN\)$/)
    await page.getByRole('button', { name: 'Join with signal 2', exact: true }).click()
    await page.getByRole('option', { name: 'OR', exact: true }).click()
    await pickFrom(page, page.getByRole('button', { name: 'Signal 2', exact: true }), 'Horn · CB-1', /^Horn · CB-1 \(over CAN\)$/)
    await page.getByTestId('create-combine').click()
    await expect(dlg).toHaveCount(0)
    await expect(page.getByTestId('lane-input')).toContainText('MCPVAL c4 washer or horn')
    await saveAndWait(page)
    const frame = await cbFrame()
    const made = await newCanInputs(snap[0])
    expect(made.map((c) => [c.id, c.startBit, c.bitLength]).sort()).toEqual([[frame, 32, 1], [frame, 33, 1]])
    const vi = (await fns(pdm.guid)).virtualInputs.find((v) => v.name === 'MCPVAL c4 washer or horn')
    const washer = made.find((c) => c.startBit === 32), horn = made.find((c) => c.startBit === 33)
    expect(vi).toMatchObject({ enabled: true, cond0: 1, var0: await ciVar(pdm.guid, washer.number), var1: await ciVar(pdm.guid, horn.number), var2: 0 })
    const o1 = (await deviceByName('PDM-05')).outputs.find((o) => o.number === 1)
    if (!(o1.currentLimit > 0)) await putOutput(pdm.guid, { ...o1, currentLimit: 5 })
    await writeAll(pdm.guid)
    await waitFor(async () => (await simOut('PDM-05', 1)) === 'Off', 10_000, 'o1 off with both switches off')
    await simSwitch('CB-1.di1', true)
    await waitFor(async () => (await simOut('PDM-05', 1)) === 'On', 10_000, 'o1 on with the washer')
    await simSwitch('CB-1.di1', false)
    await waitFor(async () => (await simOut('PDM-05', 1)) === 'Off', 10_000, 'o1 off again')
    await simSwitch('CB-1.di2', true)
    await waitFor(async () => (await simOut('PDM-05', 1)) === 'On', 10_000, 'o1 on with the horn')
  } finally { await simSwitch('CB-1.di1', false); await simSwitch('CB-1.di2', false); await restore(snap) }
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- 3. PWM duty from another module's number
test('output drive: PWM duty from a CB-1 number claims a CAN input for it @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-05'])
  const pdm = snap[0].d
  try {
    await open(page, `hardware/module/${pdm.guid}/output/8`)
    await page.getByRole('radio', { name: /PWM, duty from a signal/ }).click()
    await pickFrom(page, page.getByTestId('duty-source'), 'Headlights · Millivolts', /^Headlights · Millivolts · CB-1 \(over CAN\)$/)
    await expect(page.getByTestId('duty-source')).toContainText('Headlights', { timeout: 20_000 })
    await saveAndWait(page)
    const made = await newCanInputs(snap[0])
    expect(made.length).toBe(1)
    expect(made[0]).toMatchObject({ id: (await deviceByName('CB-1')).baseId + 2, startBit: 0, bitLength: 16 })
    const idx = await ciVar(pdm.guid, made[0].number, 'Value')
    await waitFor(async () => { const o = (await deviceByName('PDM-05')).outputs.find((x) => x.number === 8); return o.pwmEnabled && o.variableDutyCycle && o.dutyCycleInput === idx }, 15_000, 'o8 duty reads the CAN input value')
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- 4. keypad LED and dim signals
test('keypad: an LED signal and the dim signal from CB-1 over CAN @exclusive', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-05'])
  const pdm = snap[0].d
  const before = snap[0].f.keypads.find((k) => k.number === 2)
  const btn1 = JSON.parse(JSON.stringify(before.buttons.find((b) => b.number === 1)))
  try {
    // a keypad in slot 2 of PDM-05 with button 1 mapped (none on the Sim bus: the settings still save)
    await apiJson('POST', `/api/devices/${pdm.guid}/function/keypad/2`, { enabled: true, id: 22, model: 4, backlightBrightness: 63, dimmingVar: 0 })
    await apiJson('POST', `/api/devices/${pdm.guid}/function/keypadbutton/33`, { ...btn1, enabled: true, name: 'MCPVAL c4 key' })
    await open(page, 'hardware/keypads')
    await expect(page.getByTestId('keypad-PDM-05-2')).toBeVisible()
    await page.getByTestId('keypad-PDM-05-2').click()
    await page.getByTestId('key-1').click()
    await pickFrom(page, page.getByTestId('led-1-signal'), 'Door · CB-1', /^Door · CB-1 \(over CAN\)$/)
    const kp = async () => (await fns(pdm.guid)).keypads.find((k) => k.number === 2)
    await waitFor(async () => (await kp()).buttons.find((b) => b.number === 1).valVars[1] !== 0, 30_000, 'LED signal set')
    let made = await newCanInputs(snap[0])
    expect(made.map((c) => [c.id, c.startBit, c.bitLength])).toEqual([[await cbFrame(), 36, 1]])
    expect((await kp()).buttons.find((b) => b.number === 1).valVars[1]).toBe(await ciVar(pdm.guid, made[0].number))
    // the dim signal: a second remote switch (washer) gets its own CAN input
    await pickFrom(page, page.getByTestId('dim-signal'), 'Washer · CB-1', /^Washer · CB-1 \(over CAN\)$/)
    await waitFor(async () => (await kp()).dimmingVar !== 0, 30_000, 'dim signal set')
    made = await newCanInputs(snap[0])
    const washer = made.find((c) => c.startBit === 32)
    expect(washer).toMatchObject({ id: await cbFrame(), bitLength: 1 })
    expect((await kp()).dimmingVar).toBe(await ciVar(pdm.guid, washer.number))
  } finally {
    await apiJson('POST', `/api/devices/${pdm.guid}/function/keypadbutton/33`, btn1).catch(() => {})
    const { buttons, dials, ...pad } = before
    await apiJson('POST', `/api/devices/${pdm.guid}/function/keypad/2`, pad).catch(() => {})
    await restore(snap)
  }
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- 5. sleep input and the shut-down order
test('sleep & wake custom: the sleep input from another module, staged, then put back @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-05'])
  const pdm = snap[0].d
  try {
    await open(page, 'power/sleep')
    await pickFrom(page, page.getByTestId('sleep-custom-module'), null, /^PDM-05$/)
    await pickFrom(page, page.getByTestId('sleep-input'), 'Door · CB-1', /^Door · CB-1 \(over CAN\)$/)
    await page.getByTestId('confirm-go').click()
    await expect(page.getByTestId('sleep-custom-status')).toContainText('PDM-05: sleep input set to “Door · CB-1 (over CAN)”', { timeout: 30_000 })
    const made = await newCanInputs(snap[0])
    expect(made.map((c) => [c.id, c.startBit, c.bitLength, c.operator, c.operand])).toEqual([[await cbFrame(), 36, 1, 1, 0]])
    await waitFor(async () => (await deviceByName('PDM-05')).forceSleepInput === (await ciVar(pdm.guid, made[0].number)), 15_000, 'sleep input reads the CAN input')
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

const ALL = ['PDM-01', 'PDM-02', 'PDM-03', 'PDM-04', 'PDM-05', 'CB-1', 'CB-2']
const N_AWAKE = 'Sleep · awake', N_QUIET = 'Sleep · master quiet'

test('sleep: a master keeps the car awake on a CB-1 switch over CAN, the others follow its status frame; staged, then put back @exclusive', async ({ page }) => {
  test.setTimeout(420_000)
  const errors = watchErrors(page)
  const snap = await snapshot(ALL)
  const p2 = snap.find((s) => s.d.name === 'PDM-02').d
  try {
    await open(page, 'power')
    await page.getByTestId('edit-sequence').click()
    const dlg = page.getByRole('dialog', { name: 'Sleep' })
    const fol = dlg.getByTestId('sleep-followers').getByRole('checkbox')
    await pickFrom(page, dlg.getByTestId('sleep-master'), null, /^PDM-02$/)
    // the master is not in the follower list; every other module is
    await expect(fol).toHaveCount(ALL.length - 1)
    await expect(dlg.getByTestId('sleep-followers')).not.toContainText('PDM-02')
    await pickFrom(page, dlg.getByTestId('sleep-in-0'), 'Ignition · CB-1', /^Ignition · CB-1 \(over CAN\)$/)
    await page.getByTestId('sleep-stage').click()
    await expect(dlg).toHaveCount(0, { timeout: 180_000 })
    // PDM-02's keep-awake timer reads a CAN input on PDM-02 that decodes CB-1's ignition switch
    const f2 = await fns(p2.guid)
    const t = f2.timers.find((x) => x.enabled && x.name === N_AWAKE)
    const frame = await cbFrame()
    const ci = f2.canInputs.find((c) => c.enabled && c.id === frame && c.startBit === 34 && c.bitLength === 1 && c.operator === 1 && c.operand === 0)
    expect(ci).toBeTruthy()
    expect(t.input).toBe(await ciVar(p2.guid, ci.number))
    // every other module watches PDM-02's first status frame (base + 2) for silence
    for (const s of snap.filter((x) => x.d.name !== 'PDM-02'))
      expect((await fns(s.d.guid)).canInputs.filter((c) => c.enabled && c.name === N_QUIET && c.id === p2.baseId + 2), s.d.name).toHaveLength(1)
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- 6. flow builder inspector
const insp = (page) => page.getByRole('complementary', { name: 'Inspector' })
async function flowSettle(page) {
  await page.locator('.fb[data-busy="true"]').waitFor({ timeout: 1500 }).catch(() => {})
  await expect(page.locator('.fb[data-busy="false"]')).toBeVisible({ timeout: 60_000 })
}

test('flow builder: a block input from another module and from the ECU; Undo takes the CAN input back @exclusive', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-05'])
  const pdm = snap[0].d
  const vi = () => fns(pdm.guid).then((f) => f.virtualInputs.find((v) => v.number === 14))   // "Position": signal 3 unused
  const before = await vi()
  try {
    await open(page, `functions/flow/${pdm.guid}/virtualinput:14`)
    await page.addStyleTag({ content: '.tw { pointer-events: none }' })
    await expect(insp(page).getByTestId('src-var2')).toBeVisible({ timeout: 20_000 })
    // another module's switch
    await pickFrom(page, insp(page).getByTestId('src-var2'), 'Door · CB-1', /^Door · CB-1 \(over CAN\)$/)
    await insp(page).getByTestId('insp-save').click()
    await flowSettle(page)
    let made = await newCanInputs(snap[0])
    expect(made.map((c) => [c.id, c.startBit, c.bitLength, c.operator])).toEqual([[await cbFrame(), 36, 1, 1]])
    expect((await vi()).var2).toBe(await ciVar(pdm.guid, made[0].number))
    // Undo: the block and the CAN input are back as they were
    await page.getByTestId('tool-undo').click()
    await flowSettle(page)
    await waitFor(async () => (await vi()).var2 === before.var2 && (await newCanInputs(snap[0])).length === 0, 20_000, 'undo of the link')
    // an ECU signal from the DBC
    await pickFrom(page, insp(page).getByTestId('src-var2'), 'RRDoorAjarSwAct', /^RRDoorAjarSwAct · Car ECU \(Global A HS\) \(ECU\)$/)
    await insp(page).getByTestId('insp-save').click()
    await flowSettle(page)
    made = await newCanInputs(snap[0])
    expect(made.map((c) => [c.id, c.startBit, c.bitLength, c.operator, c.operand])).toEqual([[298, 23, 1, 1, 0]])
    expect((await vi()).var2).toBe(await ciVar(pdm.guid, made[0].number))
    await page.getByTestId('tool-undo').click()
    await flowSettle(page)
    await waitFor(async () => (await vi()).var2 === before.var2 && (await newCanInputs(snap[0])).length === 0, 20_000, 'undo of the ECU link')
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- 7. "Signal from another module" with an ECU source
test('flow builder: Signal from another module finds an ECU signal in the DBC and adds its CAN input @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-05'])
  const pdm = snap[0].d
  try {
    await open(page, `functions/flow/${pdm.guid}`)
    await page.addStyleTag({ content: '.tw { pointer-events: none }' })
    await expect(page.getByTestId('canvas').locator('.svelte-flow__node').first()).toBeVisible({ timeout: 15_000 })
    if (!(await page.getByTestId('add-remote').isVisible())) await page.getByTestId('tool-palette').click()
    await page.getByTestId('add-remote').click()
    const dlg = page.getByRole('dialog', { name: 'Signal from another module' })
    await pickFrom(page, dlg.getByRole('button', { name: 'From module or ECU', exact: true }), null, /^Car ECU \(Global A HS\) \(ECU\)$/)
    await dlg.getByLabel('Find a signal').fill('RLDoorAjar')
    await dlg.getByRole('radio', { name: /RLDoorAjarSwAct/ }).click()
    await dlg.getByRole('button', { name: 'Add CAN input' }).click()
    await expect(dlg).toHaveCount(0, { timeout: 30_000 })
    await flowSettle(page)
    const made = await newCanInputs(snap[0])
    expect(made.map((c) => [c.id, c.startBit, c.bitLength, c.operator, c.operand, c.name])).toEqual([[298, 8, 1, 1, 0, 'RLDoorAjarSwAct']])
    await page.getByTestId('tool-undo').click()
    await flowSettle(page)
    await waitFor(async () => (await newCanInputs(snap[0])).length === 0, 20_000, 'undo of the ECU input')
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- 8. setup wizard with an ECU input
const instanceIds = async () => ((await apiJson('GET', '/api/templates/instances').catch(() => null)) ?? []).map((i) => i.id)
/** Remove every applied function that is not in `keep` (what the function list's Remove calls). */
async function removeInstances(keep, strict = false) {
  await new Promise((r) => setTimeout(r, 600))   // the page mirrors its list to the server a moment after a change
  // strict (the step under test): a failed remove fails the test with its reason; cleanup stays lenient
  for (const id of await instanceIds()) if (!keep.includes(id)) await retry(() => apiJson('POST', '/api/templates/remove', { id }, 120_000)).catch((e) => { if (strict) throw e })
}

test('setup wizard: an ECU signal as the input of a simple function; applied, checked, removed @exclusive', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-05'])
  const pdm = snap[0].d
  const keep = await instanceIds()
  try {
    await open(page, 'functions/setup/simple')
    await page.getByTestId('pick-output').fill('PDM-05 o8')
    await page.getByRole('option', { name: /PDM-05 · J3-3 OUT8/ }).first().click()
    await page.getByTestId('wz-next').click()
    // past the first 500 of the 2501 DBC signals: the picker must still find it
    await page.getByTestId('pick-input').fill('RRDoorAjarSwAct')
    await page.getByRole('option', { name: /Car ECU \(Global A HS\) · RRDoorAjarSwAct \(ECU, over CAN\)/ }).first().click()
    await page.getByTestId('wz-next').click()
    const name = page.getByTestId('fn-name')
    if (await name.count()) await name.fill('c4-ecu door')
    while (await page.getByTestId('wz-next').count()) await page.getByTestId('wz-next').click()
    await page.getByTestId('wz-apply').dispatchEvent('click')
    await expect(page.getByTestId('wizard-result')).toBeVisible({ timeout: 150_000 })
    const made = await newCanInputs(snap[0])
    expect(made.map((c) => [c.id, c.startBit, c.bitLength, c.operator, c.operand])).toEqual([[298, 23, 1, 1, 0]])
    const st = await ciVar(pdm.guid, made[0].number)
    await waitFor(async () => (await deviceByName('PDM-05')).outputs.find((o) => o.number === 8).inputVal === st, 15_000, 'o8 follows the ECU signal')
    // remove it again (what the function list's Remove calls)
    expect((await instanceIds()).filter((id) => !keep.includes(id))).toHaveLength(1)
    await removeInstances(keep, true)
    await waitFor(async () => {
      const left = (await newCanInputs(snap[0])).map((c) => 'CAN input ' + c.number)
      const o8 = (await deviceByName('PDM-05')).outputs.find((o) => o.number === 8).inputVal
      if (left.length || o8) throw new Error(`still there: ${[...left, o8 ? 'o8 input ' + o8 : ''].filter(Boolean).join(', ')}`)
      return true
    }, 60_000, 'function removed')
  } finally { await removeInstances(keep); await restore(snap) }
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- 9. whole car: wire across modules
test('whole car: a wire from a CB-1 switch to a block input on PDM-05 claims a CAN input there @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-05'])
  const pdm = snap[0].d, cb1 = await deviceByName('CB-1')
  const vi = () => fns(pdm.guid).then((f) => f.virtualInputs.find((v) => v.number === 14))   // "Position": signal 3 is free
  try {
    await open(page, 'functions/whole-car')
    await page.getByTestId('wc-expand').click()
    await expect(page.getByTestId('wc-expand')).toHaveText('Collapse all')
    await page.addStyleTag({ content: '.svelte-flow__minimap { display: none } .tw { pointer-events: none }' })   // the mini map sits over the PDM-05 column
    const wc = page.getByTestId('whole-car')
    const from = wc.locator(`.svelte-flow__node[data-id="${cb1.guid}#input:5"] .svelte-flow__handle.source`)
    const to = wc.locator(`.svelte-flow__node[data-id="${pdm.guid}#virtualinput:14"] .svelte-flow__handle.target`)
    await expect(from).toBeVisible({ timeout: 20_000 })
    await expect(to).toBeVisible()
    await from.dragTo(to)
    await waitFor(async () => (await vi()).var2 !== 0, 30_000, 'signal 3 of Position wired')
    const made = await newCanInputs(snap[0])
    expect(made.map((c) => [c.id, c.startBit, c.bitLength, c.operator, c.operand])).toEqual([[await cbFrame(), 36, 1, 1, 0]])
    const v = await vi()
    expect(v.var2).toBe(await ciVar(pdm.guid, made[0].number))
    const was = snap[0].f.virtualInputs.find((x) => x.number === 14)
    expect([v.var0, v.var1]).toEqual([was.var0, was.var1])   // the wired inputs are left alone
    // a block whose every input is wired is refused, not silently rewired ("Sidemarker steady" uses all three)
    const full = snap[0].f.virtualInputs.find((x) => x.number === 9)
    await expect(page.getByText(/now follows Door on CB-1 over CAN/).first()).toBeVisible({ timeout: 15_000 })   // the first wire is done and the canvas reloaded
    await expect(from).toBeVisible()
    // the canvas re-reads every module after a wire: a drag that lands while it rebuilds is lost, so try again
    const refused = page.getByText(/is already wired/).first()
    for (let i = 0; i < 3 && !(await refused.count()); i++) {
      await expect(wc).toHaveAttribute('data-busy', 'false', { timeout: 30_000 })   // the canvas has re-read every module
      await from.dragTo(wc.locator(`.svelte-flow__node[data-id="${pdm.guid}#virtualinput:9"] .svelte-flow__handle.target`))
      await refused.waitFor({ state: 'attached', timeout: 5_000 }).catch(() => {})
    }
    await expect(refused).toBeAttached()
    const after = (await fns(pdm.guid)).virtualInputs.find((x) => x.number === 9)
    expect([after.var0, after.var1, after.var2]).toEqual([full.var0, full.var1, full.var2])
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- 10. base-ID change re-links the readers
const hex3 = (n) => '0x' + n.toString(16).toUpperCase().padStart(3, '0')

test('base ID: re-addressing CB-2 re-points the CAN input PDM-01 reads it with, and back again @exclusive', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-01', 'CB-2'])
  const p1 = snap[0].d, cb2 = snap[1].d
  const orig = cb2.baseId
  // PDM-01's "ECU Fan Request" reads CB-2's switch frame (base + 4, bit 33)
  const reader = snap[0].f.canInputs.find((c) => c.enabled && c.id === orig + 4 && c.startBit === 33)
  expect(reader).toBeTruthy()
  const readerId = async () => (await fns(p1.guid)).canInputs.find((c) => c.number === reader.number).id
  const settings = page.getByTestId('module-settings')
  async function move(to) {
    await settings.getByTestId('base-input').fill(hex3(to))
    await settings.getByTestId('base-set').click()
    const dlg = page.getByRole('alertdialog')
    await expect(dlg.getByTestId('base-relinks')).toContainText('1 CAN input on other modules reads this module')
    await dlg.getByTestId('confirm-yes').click()
    await expect(settings.getByTestId('readdr-msg')).toContainText(`answers on ${hex3(to)}`, { timeout: 30_000 })
  }
  try {
    await open(page, `hardware/module/${cb2.guid}/settings`)
    const sugg = settings.getByRole('button', { name: /^0x[0-9A-F]{3}$/ }).first()
    const target = parseInt(await sugg.innerText(), 16)
    await move(target)
    await waitFor(async () => (await readerId()) === target + 4, 15_000, 'PDM-01 reads CB-2 at its new ID')
    expect((await deviceByName('CB-2')).connected).toBe(true)
    // and back: the link now resolves to the new ID, so it is re-pointed again
    await move(orig)
    await waitFor(async () => (await readerId()) === orig + 4, 15_000, 'PDM-01 reads CB-2 at its old ID again')
    const back = await deviceByName('CB-2')
    expect(back.baseId).toBe(orig)
    expect(back.connected).toBe(true)
  } finally {
    const cur = await deviceByName('CB-2')
    if (cur.baseId !== orig) {
      await apiJson('POST', `/api/devices/${cur.guid}/modify`, { Name: 'CB-2', BaseId: hex3(orig) })
      await waitFor(async () => { const d = await deviceByName('CB-2'); return d.connected && d.baseId === orig }, 30_000, 'CB-2 back on its ID')
    }
    await restore(snap)
  }
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- 11. cross-module functions: send, run, delete, send again
/** Sim states of an output over `ms` of wall time: the set of states seen. */
async function seen(mod, n, ms = 2500) {
  const s = new Set(), end = Date.now() + ms
  while (Date.now() < end) { s.add(await simOut(mod, n)); await new Promise((r) => setTimeout(r, 80)) }
  return s
}
const cmfSlots = async (guid) => { const f = await fns(guid); return ['canInputs', 'canOutputs', 'flashers', 'timers'].flatMap((k) => (f[k] ?? []).filter((x) => x.enabled && /^cmf\d/i.test(x.name ?? ''))) }

test('cross-module function: a CB-1 switch blinks an output on two PDMs on the Sim; deleted and sent again puts them back @exclusive', async ({ page }) => {
  test.setTimeout(420_000)
  const errors = watchErrors(page)
  const snap = await snapshot(ALL)
  const p3 = snap.find((s) => s.d.name === 'PDM-03'), p5 = snap.find((s) => s.d.name === 'PDM-05')
  const out = (s, n) => s.outputs.find((o) => o.number === n)
  const cfg = async (name, n) => { const o = (await deviceByName(name)).outputs.find((x) => x.number === n); return { enabled: o.enabled, inputVal: o.inputVal } }
  async function sendAll() {
    await page.getByTestId('cm-send').click()
    await page.getByTestId('cm-send-next').click()
    await page.getByTestId('cm-confirm-send').click()
    const res = page.getByTestId('cm-results')
    await expect(res).toBeVisible({ timeout: 180_000 })
    await expect(res).not.toContainText('■')
    await page.getByTestId('cm-send-dialog').getByText('Close', { exact: true }).click()
  }
  try {
    await simSwitch('CB-1.di5', false)
    await open(page, 'functions/cross-module')
    await page.getByTestId('cm-new').click()
    await page.getByTestId('cm-name').fill('MCPVAL c4 door blink')
    await page.getByTestId('cm-trigger').click()
    await page.getByRole('searchbox', { name: /Search Trigger signal/ }).fill('Door')
    await page.getByRole('option', { name: /^Door · CB-1/ }).first().click()
    for (const [i, t] of [[0, 'PDM-03 · O8'], [1, 'PDM-05 · O8']]) {
      await page.getByTestId('cm-add-target').click()
      await page.getByTestId('cm-target-' + i).click()
      await page.getByRole('searchbox').fill(t)
      await page.getByRole('option', { name: new RegExp(t) }).first().click()
    }
    await expect(page.getByTestId('cm-blink')).toBeChecked()
    await page.getByTestId('cm-preview-btn').click()
    await expect(page.getByTestId('cm-preview')).toBeVisible()
    await page.getByTestId('cm-save').click()
    await expect(page.getByTestId('cm-card').filter({ hasText: 'MCPVAL c4 door blink' })).toBeVisible()
    await sendAll()
    // both outputs now follow the cross-module input; nothing blinks with the door shut
    for (const s of [p3, p5]) expect((await cfg(s.d.name, 8)).enabled).toBe(true)
    await waitFor(async () => (await simOut('PDM-03', 8)) === 'Off' && (await simOut('PDM-05', 8)) === 'Off', 10_000, 'both off with the door shut')
    await simSwitch('CB-1.di5', true)
    await waitFor(async () => (await seen('PDM-03', 8, 1500)).has('On'), 15_000, 'PDM-03 o8 comes on')
    const a = await seen('PDM-03', 8), b = await seen('PDM-05', 8)
    expect([...a].sort(), 'PDM-03 o8 blinks').toEqual(['Off', 'On'])
    expect([...b].sort(), 'PDM-05 o8 blinks').toEqual(['Off', 'On'])
    await simSwitch('CB-1.di5', false)
    await waitFor(async () => (await simOut('PDM-03', 8)) === 'Off' && (await simOut('PDM-05', 8)) === 'Off', 10_000, 'both off again')

    // delete it, send the (now empty) list: the modules lose the wiring and the outputs are as before
    await page.getByRole('button', { name: 'Delete MCPVAL c4 door blink' }).click()
    await page.getByTestId('cm-confirm-delete').click()
    await expect(page.getByTestId('cm-card')).toHaveCount(0)
    await sendAll()
    for (const s of snap) expect(await cmfSlots(s.d.guid), s.d.name).toEqual([])
    for (const s of [p3, p5]) expect(await cfg(s.d.name, 8)).toEqual({ enabled: out(s, 8).enabled, inputVal: out(s, 8).inputVal })
    await simSwitch('CB-1.di5', true)
    expect([...(await seen('PDM-05', 8, 1500))]).toEqual(['Off'])
  } finally { await simSwitch('CB-1.di5', false); await restore(snap) }
  expect(errors).toEqual([])
})

// ---------------------------------------------------------------- hand-built Duplicate copies the blocks
test('a hand-built function duplicated onto a spare output gets its own copy of the blocks; removing the copy frees them @exclusive', async ({ page }) => {
  const errors = watchErrors(page)
  const snap = await snapshot(['PDM-04'])
  const pdm = snap[0].d
  const orig = pdm.outputs.find((o) => o.name === 'Left Reverse Light')
  const vmap = await vars(pdm.guid)
  const drv = vmap.find((v) => v.index === orig.inputVal)   // the "Reverse" combine block
  const out2 = async () => (await deviceByName('PDM-04')).outputs.find((o) => o.number === 2)
  try {
    await open(page, 'functions')
    await page.addStyleTag({ content: '.tw { pointer-events: none }' })
    const panel = page.getByTestId('fn-panel')
    await page.getByTestId('fn-search').fill('Reverse Light')
    await page.locator('[data-testid=fn-row]').filter({ hasText: 'Reverse Light' }).first().getByRole('button').first().click()
    await panel.getByTestId('fn-duplicate').click()
    await page.getByTestId('dup-output').click()
    await page.getByRole('option', { name: /PDM-04 · OUT2/ }).click()
    await page.getByTestId('dup-name').fill('c4 reverse copy')
    await page.getByTestId('dup-go').click()
    await waitFor(async () => (await out2()).enabled && (await out2()).inputVal > 0, 30_000, 'o2 driven by the copy')
    const now = await vars(pdm.guid)
    const o2in = (await out2()).inputVal
    const cv = now.find((v) => v.index === o2in)
    expect(cv.kind).toBe(drv.kind)
    expect(cv.number).not.toBe(drv.number)   // its own block…
    const f = await fns(pdm.guid)
    const a = f.virtualInputs.find((x) => x.number === drv.number), b = f.virtualInputs.find((x) => x.number === cv.number)
    expect([b.var0, b.var1, b.var2, b.cond0, b.cond1, b.not0, b.not1]).toEqual([a.var0, a.var1, a.var2, a.cond0, a.cond1, a.not0, a.not1])   // …reading the same inputs
    expect(b.name).toBe(a.name + ' copy')
    // remove the copy: o2 free again, the copied block switched off, the original untouched
    await page.getByTestId('fn-search').fill('c4 reverse copy')
    await page.locator('[data-testid=fn-row]').filter({ hasText: 'c4 reverse copy' }).first().getByRole('button').first().click()
    await panel.getByRole('button', { name: 'Remove' }).click()
    await page.getByTestId('confirm-remove').click()
    await waitFor(async () => !(await out2()).enabled && !(await out2()).inputVal, 30_000, 'o2 free again')
    const g = await fns(pdm.guid)
    expect(g.virtualInputs.find((x) => x.number === cv.number).enabled).toBe(false)
    expect(g.virtualInputs.find((x) => x.number === drv.number).enabled).toBe(true)
    expect((await deviceByName('PDM-04')).outputs.find((o) => o.number === orig.number).inputVal).toBe(orig.inputVal)
  } finally { await restore(snap) }
  expect(errors).toEqual([])
})
