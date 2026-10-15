// Keypads: models, LED colours and the write helpers. A keypad is configured on a PDM keypad slot
// (api.functions(guid).keypads); its buttons are `keypadbutton` functions numbered (slot-1)*32 + button.
import { api, project, toast } from '../../../../lib/live.svelte.js'

// Firmware KeypadModel values -> label and button count (same table as the old UI).
export const MODELS = [
  [0, 'Blink Marine 2-key', 2], [1, 'Blink Marine 4-key', 4], [2, 'Blink Marine 5-key', 5], [3, 'Blink Marine 6-key', 6],
  [4, 'Blink Marine 8-key', 8], [5, 'Blink Marine 10-key', 10], [6, 'Blink Marine 12-key', 12], [7, 'Blink Marine 15-key', 15],
  [8, 'Blink Marine 15-key + 2 dials', 15], [10, 'Grayhill 1-key', 1], [20, 'Grayhill 6-key', 6], [21, 'Grayhill 8-key', 8],
  [22, 'Grayhill 12-key', 12], [23, 'Grayhill 15-key', 15], [24, 'Grayhill 20-key', 20],
].map(([value, label, buttons]) => ({ value, label, buttons }))
export const modelOf = (v) => MODELS.find((m) => m.value === v) ?? { value: v, label: `Model ${v}`, buttons: 12 }

export const COLORS = ['Off', 'Red', 'Green', 'Orange', 'Blue', 'Violet', 'Cyan', 'White']
// Display only: every colour is also written as a word. Tokens stand in for the LED hues.
export const SWATCH = ['--color-line-strong', '--color-fault', '--color-ok', '--color-accent', '--color-on', '--color-series-3', '--color-series-1', '--color-text']

export const pad4 = (a, fill) => { const o = Array.isArray(a) ? a.slice(0, 4) : []; while (o.length < 4) o.push(fill); return o }
export const MAX_BRIGHT = 63
export const pct = (v) => Math.round((v / MAX_BRIGHT) * 100)

/** Run a keypad write. Returns the response ({unconfirmed:true} when the module sent no confirm), or undefined after a toast on failure. */
export async function write(guid, kind, number, body) {
  try {
    const r = await api.setFunction(guid, kind, number, body)
    project.dirty = true
    if (r && r.written === false) toast('The module is offline: saved in the project, sent when it is back.', 'info', 5000)
    return r ?? {}
  } catch (e) {
    const m = e?.message ?? String(e)
    // The module did not confirm: the project record still holds the value, so say so and carry on.
    if (/not confirmed|no reply|didn't confirm/i.test(m)) {
      project.dirty = true
      toast(`Saved in the project, but the module did not confirm it. ${m}`, 'error', 9000)
      return { unconfirmed: true }
    }
    toast(m, 'error', 9000)
    return undefined
  }
}

/** All enabled keypads on all PDMs: [{ key, pdm, slot, kp }], plus free slots per PDM. */
export async function loadKeypads(pdms) {
  const pads = [], free = []
  await Promise.all(pdms.map(async (d) => {
    try {
      const f = await api.functions(d.guid)
      for (const kp of f?.keypads ?? []) {
        if (kp.enabled) pads.push({ key: `${d.guid}:${kp.number}`, pdm: d, slot: kp.number, kp })
        else free.push({ pdm: d, slot: kp.number })
      }
    } catch { /* module unreadable: skip */ }
  }))
  pads.sort((a, b) => a.pdm.name.localeCompare(b.pdm.name) || a.slot - b.slot)
  free.sort((a, b) => a.pdm.name.localeCompare(b.pdm.name) || a.slot - b.slot)
  return { pads, free }
}
