// Helpers for the ui-fn specs: the flow builder on one module, Apply / Read through the Apply panel (the user's path),
// and a snapshot / restore of the module's function slots and outputs.
import { expect } from '@playwright/test'
import { open } from './helpers.js'
import { apiJson, deviceByName, waitFor } from './api.js'
import { putOutput } from './b-helpers.js'

export const KIND = { virtualInputs: 'virtualinput', conditions: 'condition', timers: 'timer', flashers: 'flasher', counters: 'counter', tables: 'table', canInputs: 'caninput', canOutputs: 'canoutput', maths: 'math', canMessages: 'canmsg', comfortBlinks: 'comfortblink', curves: 'curve', latchGates: 'latchgate', pids: 'pid' }
export const fns = (g) => apiJson('GET', `/api/devices/${g}/functions`)
export const vmap = (g) => apiJson('GET', `/api/devices/${g}/inputs`)
export const node = (page, id) => page.locator(`.svelte-flow__node[data-id="${id}"]`)
export const insp = (page) => page.getByRole('complementary', { name: 'Inspector' })

/** Every function slot and output of a module, to put back in `finally`. */
export async function snapshot(name) {
  const d = await deviceByName(name)
  return { guid: d.guid, f: await fns(d.guid), outs: JSON.parse(JSON.stringify(d.outputs ?? [])) }
}
const post = async (path, body) => { for (let i = 0; ; i++) { try { return await apiJson('POST', path, body) } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 1000)) } } }
/** Put back every slot that differs from the snapshot, then write the whole module once. */
export async function restore(snap) {
  const now = await fns(snap.guid)
  for (const [arr, kind] of Object.entries(KIND))
    for (const r of snap.f[arr] ?? []) {
      const c = (now[arr] ?? []).find((x) => x.number === r.number)
      if (c && JSON.stringify(c) !== JSON.stringify(r)) { const { number, ...body } = r; await post(`/api/devices/${snap.guid}/function/${kind}/${number}`, body).catch(() => {}) }
    }
  const live = await deviceByName((await apiJson('GET', '/api/devices')).find((x) => x.guid === snap.guid).name)
  for (const o of snap.outs) {
    const c = live.outputs.find((x) => x.number === o.number)
    if (JSON.stringify({ ...c, state: 0, current: 0, duty: 0, resetCount: 0, input: 0 }) !== JSON.stringify({ ...o, state: 0, current: 0, duty: 0, resetCount: 0, input: 0 })) await putOutput(snap.guid, o).catch(() => {})
  }
  await post(`/api/devices/${snap.guid}/writeall`).catch(() => {})
}

export async function openFlow(page, name, fn) {
  const d = await deviceByName(name)
  await open(page, `functions/flow/${d.guid}${fn ? '/' + fn : ''}`)
  await expect(page.getByRole('heading', { level: 1, name: `${name} · blocks` })).toBeVisible()
  await expect(page.getByTestId('canvas').locator('.svelte-flow__node').first()).toBeVisible({ timeout: 15_000 })
  return d
}
export async function settle(page) {
  await page.locator('.fb[data-busy="true"]').waitFor({ timeout: 1500 }).catch(() => {})
  await expect(page.locator('.fb[data-busy="false"]')).toBeVisible({ timeout: 60_000 })
}
/** "+ Add" a block; returns the slot number it claimed (the one that was off before and is on now). */
export async function addBlock(page, guid, label, arr) {
  const before = new Set((await fns(guid))[arr].filter((x) => x.enabled).map((x) => x.number))
  await page.getByTestId('tool-add').click()
  const dlg = page.getByRole('dialog', { name: 'Add a block' })
  await dlg.getByTestId('add-' + label).click()
  await expect(dlg).toHaveCount(0)
  await settle(page)
  return waitFor(async () => (await fns(guid))[arr].find((x) => x.enabled && !before.has(x.number))?.number, 15_000, `${label} added`)
}
export async function pickSource(page, field, optionText) {
  await insp(page).getByTestId('src-' + field).click()
  await page.getByRole('option', { name: optionText, exact: false }).first().click()
}
/** A Select in the inspector by its label (the trigger is a button named after it). */
export async function choose(page, label, option) {
  await insp(page).getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option }).first().click()
}
export async function save(page) {
  await insp(page).getByTestId('insp-save').click()
  await settle(page)
  await expect(insp(page).getByTestId('insp-save')).toBeDisabled({ timeout: 15_000 })
}
/** Save must refuse with this message and leave the draft unsaved. */
export async function saveRefused(page, msg) {
  await insp(page).getByTestId('insp-save').click()
  await expect(insp(page).getByRole('alert').filter({ hasText: msg })).toBeVisible()
  await expect(insp(page).getByTestId('insp-save')).toBeEnabled()
}

/** Apply (write) or Read one module through the Apply panel, and wait until it is done. */
async function panelAct(page, act, name) {
  // the flow builder's own button (it checks for unfinished blocks first), else the top bar's
  if (await page.getByTestId('tool-apply').isVisible()) await page.getByTestId('tool-apply').click()
  else await page.getByTestId('apply-pill').click()
  const ask = page.getByRole('dialog', { name: 'Apply with unfinished blocks?' })
  if (await ask.waitFor({ timeout: 1500 }).then(() => true, () => false)) await ask.getByRole('button', { name: 'Apply anyway' }).click()
  const panel = page.getByRole('dialog', { name: 'Apply to car' })
  await expect(panel).toBeVisible()
  const quiet = panel.getByTestId('apply-quiet'), btn = panel.getByRole('button', { name: `${act} ${name}`, exact: true }).first()
  if (!(await btn.isVisible()) && await quiet.isVisible()) await quiet.click()   // a module with nothing waiting is folded away
  await btn.click()
  // Apply always asks; Read asks only when it would replace edits still waiting
  const yes = page.getByTestId('apply-confirm-yes')
  if (act === 'Apply' || await yes.waitFor({ timeout: 2500 }).then(() => true, () => false)) await yes.click()
  await page.getByRole('button', { name: /Reading…|Applying…|Storing…/ }).waitFor({ timeout: 3000 }).catch(() => {})
  await expect(page.getByRole('button', { name: /Reading…|Applying…|Storing…/ })).toHaveCount(0, { timeout: 180_000 })
  if (act === 'Read') await waitFor(async () => { const d = await deviceByName(name); return d.paramsRead && !d.reading }, 60_000, name + ' read')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
}
export const applyModule = (page, name) => panelAct(page, 'Apply', name)
export const readModule = (page, name) => panelAct(page, 'Read', name)

/** Live state of an output from the module's telemetry ('On', 'Off', ...). */
export const outState = async (name, n) => (await deviceByName(name)).outputs.find((o) => o.number === n)?.state
