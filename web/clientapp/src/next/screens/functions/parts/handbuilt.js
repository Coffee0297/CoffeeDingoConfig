// Duplicate / remove for functions built by hand in the flow builder (no template record). A function is its
// outputs plus every block that feeds them (the same set its own page in the flow builder shows).
import { api, live } from '../../../lib/live.svelte.js'
import { buildModel, KINDS, isCb } from '../flow/model.js'
import { upstreamOf } from '../flow/flowgraph.js'
import { writeBlock } from '../flow/ops.js'

const outId = (dev, n) => (isCb(dev) ? 'digitaloutput:' : 'output:') + n
// blocks a copy gets its own slot for; inputs, CAN inputs and outputs (a copy would send the same id twice), Lua outs and
// the module itself are shared
const COPYABLE = new Set(['virtualinput', 'condition', 'counter', 'flasher', 'timer', 'table', 'math', 'pid'])

async function moduleOf(guid) {
  const dev = live.devices.find((d) => d.guid === guid)
  const [funcs, vmap] = await Promise.all([api.functions(guid), api.inputs(guid)])
  return { dev, funcs, vmap, model: buildModel(dev, funcs, vmap) }
}

/** What the function holds on one module: its output ids and the set of blocks that feed them. */
function partOn(m, row, guid) {
  const roots = row.outputs.filter((o) => o.guid === guid).map((o) => outId(m.dev, o.n))
  return { roots, set: upstreamOf(m.model, roots) }
}

/** Blocks of `set` that nothing outside it reads (safe to switch off with the function). */
function ownBlocks(model, set) {
  return [...set].filter((id) => {
    const n = model.nodes.get(id)
    if (!n?.deletable || !n.enabled) return false
    return n.outs.every((p) => (model.consumers.get(p.idx) ?? []).every((c) => set.has(c.node)))
  })
}

/** Remove: switch the outputs off (no input) and switch off the blocks only this function uses. */
export async function removeHandBuilt(row) {
  for (const guid of new Set(row.outputs.map((o) => o.guid))) {
    const m = await moduleOf(guid)
    const { roots, set } = partOn(m, row, guid)
    for (const id of roots) await writeBlock(guid, id, { input: 0, enabled: false })
    for (const id of ownBlocks(m.model, set)) await writeBlock(guid, id, { enabled: false })
  }
}

/** Spare outputs a copy can drive: switched off and not wired, on the modules the function runs on. */
export function spareOutputs(row) {
  const out = []
  for (const guid of new Set(row.outputs.map((o) => o.guid))) {
    const d = live.devices.find((x) => x.guid === guid)
    for (const o of d?.outputs ?? []) if (o.enabled === false && !(o.inputVal > 0)) out.push({ guid, n: o.number, label: `${d.name} · OUT${o.number}${o.name && !/^output\d+$/i.test(o.name) ? ' · ' + o.name : ''}` })
  }
  return out
}

/**
 * Duplicate: copy the function's blocks on the target's module into free slots (the copies read each other,
 * the shared inputs stay shared) and drive the spare output from the copy. Returns the number of blocks copied.
 */
export async function duplicateHandBuilt(row, target, name) {
  const m = await moduleOf(target.guid)
  const { roots, set } = partOn(m, row, target.guid)
  if (!roots.length) throw new Error(`${row.name} has no output on that module`)
  const copy = [...set].filter((id) => COPYABLE.has(m.model.nodes.get(id)?.kind) && m.model.nodes.get(id)?.enabled)
  // a free slot per copied block
  const claimed = new Set(), newN = new Map()
  for (const id of copy) {
    const n = m.model.nodes.get(id)
    const free = (m.funcs[KINDS[n.kind].arr] ?? []).find((r) => !r.enabled && !claimed.has(`${n.kind}:${r.number}`))
    if (!free) throw new Error(`No free ${KINDS[n.kind].label.toLowerCase()} slot on ${m.dev.name} for the copy`)
    claimed.add(`${n.kind}:${free.number}`); newN.set(id, free.number)
  }
  // var index of a copied block's output = the same port on its new slot
  const remap = (idx) => {
    const v = m.model.byIdx.get(idx)
    const id = v ? `${v.kind}:${v.number}` : null
    if (!id || !newN.has(id)) return idx
    return m.vmap.find((x) => x.kind === v.kind && x.number === newN.get(id) && x.prop === v.prop)?.index ?? idx
  }
  for (const id of copy) {
    const n = m.model.nodes.get(id)
    const { number, ...body } = JSON.parse(JSON.stringify(n.row))
    for (const p of n.ins) if (p.src) body[p.id] = remap(p.src)
    if ('name' in body) body.name = `${body.name} copy`.slice(0, 32)
    await api.setFunction(target.guid, n.kind, newN.get(id), { ...body, enabled: true })
  }
  // the spare output follows what drives the original's first output on this module
  const src = m.model.nodes.get(roots[0])?.ins.find((p) => p.id === 'input')?.src ?? 0
  await writeBlock(target.guid, outId(m.dev, target.n), { input: remap(src), enabled: true, ...(name ? { name } : {}) })
  return copy.length
}
