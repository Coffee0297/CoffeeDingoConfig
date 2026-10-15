// Writes for the flow builder. Every write goes through the normal endpoints:
//   function blocks / CANBoard outputs → POST /devices/{id}/function/{kind}/{n} (partial body)
//   PDM outputs                        → POST /devices/{id}/outputconfig (partial body, PascalCase)
//   the module's own inputs            → POST /devices/{id}/device-inputs
// and returns the inverse body so the screen can Undo it.
import { api } from '../../../lib/live.svelte.js'
import { parseId, rowOf, fieldOf } from './model.js'

const OUT_MAP = { input: 'Input', dutyCycleInput: 'DutyCycleInput', freqInput: 'FreqInput', variableDutyCycle: 'VariableDutyCycle', variableFreq: 'VariableFreq', pwmEnabled: 'PwmEnabled', name: 'Name', enabled: 'Enabled' }

/** Current values of the body's keys on the block (for Undo). */
export function prevBody(dev, funcs, id, body) {
  const { kind } = parseId(id)
  const row = rowOf(id, dev, funcs) ?? {}
  const prev = {}
  for (const k of Object.keys(body)) prev[k] = kind === 'output' ? fieldOf('output', row, k) : (row[k] ?? (typeof body[k] === 'boolean' ? false : 0))
  if (kind === 'output') for (const k of Object.keys(body)) if (k !== 'input') prev[k] = row[k === 'pwmEnabled' ? 'pwmEnabled' : k] ?? prev[k]
  return JSON.parse(JSON.stringify(prev))
}

/** Send `body` to block `id` on module `guid`. Returns the API result ({ ok, written }). */
export async function writeBlock(guid, id, body) {
  const { kind, n } = parseId(id)
  if (kind === 'sys') return api.deviceInputs(guid, body)
  if (kind === 'output') {
    const b = { Number: n }
    for (const [k, v] of Object.entries(body)) { const K = OUT_MAP[k]; if (!K) throw new Error(`Output field ${k} is edited on the Output screen`); b[K] = v }
    return api.outputConfig(guid, b)
  }
  return api.setFunction(guid, kind, n, body)
}

/** Body that clears every input wired from `id`'s outputs (before removing it). */
export function clearsFor(model, id) {
  const n = model.nodes.get(id)
  if (!n) return []
  const ops = []
  for (const p of n.outs) for (const c of model.consumers.get(p.idx) ?? []) ops.push({ id: c.node, body: { [c.field]: 0 } })
  return ops
}

/** Plain result word for a toast. */
export const landed = (r, dev) => (r?.written === false ? `saved to the project only (${dev?.name ?? 'module'} is not live). Apply later to send it.` : `sent to ${dev?.name ?? 'the module'} (not stored until you Apply).`)
