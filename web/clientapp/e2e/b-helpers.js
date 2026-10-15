// Helpers for the b- specs (output / input screens). Writes use only the assigned targets and restore in finally.
import { expect } from '@playwright/test'
import { apiJson, deviceByName, waitFor } from './api.js'

export { apiJson, deviceByName, waitFor }

/** Current output record from telemetry. */
export async function outputOf(name, n) {
  const d = await deviceByName(name)
  return { d, o: d.outputs.find((x) => x.number === n) }
}

/** Write a full output record back (PascalCase body of POST outputconfig). Retries: the shared bus drops frames under load (409 noReply). */
export async function putOutput(guid, o, tries = 5) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await putOutputOnce(guid, o) } catch (e) { last = e; await new Promise((r) => setTimeout(r, 2500)) }
  }
  throw last
}
function putOutputOnce(guid, o) {
  return apiJson('POST', `/api/devices/${guid}/outputconfig`, {
    Number: o.number, Name: o.name, WireColor: o.wireColor ?? '', WireStripe: o.wireStripe ?? '', WireLength: o.wireLength ?? 0, WireGaugeMm2: o.wireGaugeMm2 ?? 0,
    Enabled: o.enabled, Input: o.inputVal, CurrentLimit: o.currentLimit, InrushLimit: o.inrushLimit, InrushTime: o.inrushTime,
    ResetMode: o.resetMode, ResetTime: o.resetTime, ResetCountLimit: o.resetCountLimit, PwmEnabled: o.pwmEnabled, Freq: o.freq, FixedDuty: o.fixedDuty, MinDuty: o.minDuty,
    SoftStart: o.softStart, SoftStartRamp: o.softStartRamp, VariableDutyCycle: o.variableDutyCycle, DutyCycleInput: o.dutyCycleInput, DutyCycleDenom: o.dutyCycleDenom,
    VariableFreq: o.variableFreq, FreqInput: o.freqInput, FreqInputDenom: o.freqInputDenom, RampDutyChanges: o.rampDutyChanges, PrimaryOutput: o.primaryOutput,
    WarnLimit: o.warnLimit, OpenLoadLimit: o.openLoadLimit, OpenLoadTime: o.openLoadTime,
  })
}

/** Run fn with the output restored afterwards. */
export async function withOutput(name, n, fn) {
  const { d, o } = await outputOf(name, n)
  const before = JSON.parse(JSON.stringify(o))
  try { return await fn(d, before) } finally {
    try { await apiJson('POST', `/api/devices/${d.guid}/output/${n}/test`, { mode: 'off', duty: 0, freq: 100, hold: 1 }).catch(() => {}) } catch {}
    await putOutput(d.guid, before)
  }
}

/** One function row from /functions. */
export async function funcRow(guid, arr, number) {
  const f = await apiJson('GET', `/api/devices/${guid}/functions`)
  return (f[arr] ?? []).find((x) => x.number === number)
}
/** Write a function row back as it was (partial body works; send the whole record). */
export async function putFunc(guid, kind, number, row, tries = 5) {
  let last
  for (let i = 0; i < tries; i++) {
    try { return await apiJson('POST', `/api/devices/${guid}/function/${kind}/${number}`, row) } catch (e) { last = e; await new Promise((r) => setTimeout(r, 2500)) }
  }
  throw last
}
export async function withFunc(guid, kind, arr, number, fn) {
  const before = JSON.parse(JSON.stringify(await funcRow(guid, arr, number)))
  try { return await fn(before) } finally { await putFunc(guid, kind, number, before) }
}

/** Live telemetry of one output (state / duty / current). */
export async function outState(name, n) { return (await outputOf(name, n)).o }

export const stepper = (page, label) => ({
  input: page.getByLabel(label, { exact: true }),
  more: page.getByRole('button', { name: 'More ' + label, exact: true }),
  less: page.getByRole('button', { name: 'Less ' + label, exact: true }),
})

/** Pick an option in the kit Select whose trigger is labelled `label`. */
export async function pickSelect(page, label, option) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.getByRole('option', { name: option, exact: false }).first().click()
}

export async function saveAndWait(page) {
  const save = page.getByTestId('save')
  await expect(save).toBeEnabled()
  await save.dispatchEvent('click')
  await expect(page.getByTestId('save-status')).toContainText(/Saved to/, { timeout: 20_000 })
}

/** Show a patched /functions in the page (no write): patch(json) mutates the parsed body. */
export async function mockFunctions(page, guid, patch) {
  await page.route(`**/api/devices/${guid}/functions`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const r = await route.fetch()
    const json = await r.json()
    patch(json)
    await route.fulfill({ response: r, json })
  })
}
