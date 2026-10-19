// Cross-module functions — the plain logic shared by the old System view and the new UI's
// Functions ▸ Cross-module screen. The definitions live in the `crossFns` store (browser + project
// state); compile/deploy live in store.js (compileCrossModule, deployCrossModule). This file holds
// the bits that used to be buried in SystemView.svelte, plus a read-only per-module preview.
import { get } from 'svelte/store'
import { api, crossFns, compileCrossModule, cmfIsLua, cmfSlotOf, nextCmfSlot, cmfTrigId, cmfClkId, deviceHasLua } from './store.js'

/** A new, empty function definition. */
export function blankCrossFn() {
  return { name: '', mode: 'rule', blink: true, blinkRateMs: 350,
    trigger: { guid: '', varIndex: null, varName: '' },
    targets: [], clockMaster: '', clockBackup: '', luaByModule: {} }
}

/** Modules a function touches (trigger owner + clock master + backup + targets). */
export function involvedOf(fn) {
  const s = new Set()
  if (fn?.trigger?.guid) s.add(fn.trigger.guid)
  if (fn?.clockMaster) s.add(fn.clockMaster)
  if (fn?.blink && fn?.clockBackup) s.add(fn.clockBackup)
  for (const t of fn?.targets ?? []) if (t.guid) s.add(t.guid)
  return [...s]
}

/**
 * compileCrossModule() (the Lua path) takes `clockMaster` literally, so a blinking Lua function with the
 * default "trigger module" clock ('') would get its clock compiled for no module and never blink. The native
 * path already falls back to the trigger module; make that explicit for Lua functions. Returns `f` itself when
 * nothing needs changing, otherwise a fixed copy.
 */
export function normalizeCrossFn(f) {
  if (!f || !f.blink || f.clockMaster || !f.trigger?.guid || !cmfIsLua(f)) return f
  return { ...f, clockMaster: f.trigger.guid }
}

/** Definitions deployed via the backend (MCP `deploy_cross_module`) that the list does not have yet (matched by name). */
export function backendCrossFnsToAdd(list, backend) {
  if (!Array.isArray(backend)) return []
  const have = new Set((list ?? []).map((f) => f?.name))
  let slot = nextCmfSlot(list)
  return backend
    .filter((f) => f && f.name && f.trigger?.guid && !have.has(f.name))
    .map((f) => normalizeCrossFn({
      name: f.name, mode: 'lua', blink: !!f.blink, blinkRateMs: f.blinkRateMs ?? 350,
      trigger: { guid: f.trigger?.guid ?? '', varIndex: f.trigger?.varIndex ?? null, varName: f.trigger?.varName ?? '' },
      targets: Array.isArray(f.targets) ? f.targets : [],
      clockMaster: f.clockMaster ?? '', clockBackup: f.clockBackup ?? '', luaByModule: {}, slot: slot++,
    }))
}

/** Pull MCP-deployed functions into the `crossFns` list. Returns how many were added. */
export async function importBackendCrossFns() {
  const backend = await api.crossModuleGet()
  if (!Array.isArray(backend) || !backend.length) return 0
  let added = 0
  crossFns.update((list) => {
    const add = backendCrossFnsToAdd(list, backend)
    added = add.length
    return add.length ? [...(list ?? []), ...add] : list
  })
  return added
}

/**
 * Put an edited function into the list (editIdx -1 = new). Names an unnamed function, sets the mode
 * (any hand-written Lua → 'lua', else a native rule) and gives a new function its stable CAN-ID slot.
 * Stores a plain copy (no reactive proxy). Returns the new list.
 */
export function commitCrossFn(list, f, editIdx = -1) {
  const next = [...(list ?? [])]
  let g = JSON.parse(JSON.stringify(f))
  if (!g.name?.trim()) g.name = 'Function ' + (editIdx >= 0 ? editIdx + 1 : next.length + 1)
  g.mode = Object.values(g.luaByModule || {}).some((t) => t && t.trim()) ? 'lua' : 'rule'
  if (g.trigger?.varIndex != null) g.trigger.varIndex = Number(g.trigger.varIndex)
  g = normalizeCrossFn(g)
  if (editIdx >= 0) next[editIdx] = g
  else { if (typeof g.slot !== 'number') g.slot = nextCmfSlot(next); next.push(g) }
  return next
}

// compileCrossModule() reads the crossFns store. To preview a list that is not saved yet (a draft),
// swap it in for the synchronous compile and put the saved list straight back.
function compileList(fns) {
  const saved = get(crossFns)
  if (fns === saved) return compileCrossModule()
  crossFns.set(fns)
  try { return compileCrossModule() } finally { crossFns.set(saved) }
}

const hx = (n) => '0x' + Number(n).toString(16).toUpperCase()

/**
 * What a deploy of `fns` would do to each module — read-only, nothing is sent.
 * Mirrors deployCrossModule(): native rules → CAN send/receive + flasher + output wiring; Lua functions
 * (hand-written, or with a backup clock) → a generated or hand-written script per PDM.
 * Returns [{ guid, name, steps: [text], lua, outputs: [n], errors: [text] }] plus `skipped` functions.
 */
export function previewCrossModule(fns, devices) {
  const dev = (g) => (devices ?? []).find((d) => d.guid === g)
  const nm = (g) => dev(g)?.name ?? 'a module not in the project'
  const outNm = (g, n) => { const o = [...(dev(g)?.outputs ?? []), ...(dev(g)?.digitalOut ?? [])].find((x) => x.number === n); return `O${n}${o?.name?.trim() ? ' ' + o.name.trim() : ''}` }
  const mods = new Map()
  const M = (g) => { if (!mods.has(g)) mods.set(g, { guid: g, name: nm(g), steps: [], lua: '', outputs: [], errors: [] }); return mods.get(g) }
  const skipped = []
  const list = fns ?? []

  list.forEach((f, i) => {
    if (!f || f.disabled) return
    for (const g of involvedOf(f)) M(g)   // every involved module gets its old cross-module CAN slots cleared
    if (cmfIsLua(f)) return
    const slot = cmfSlotOf(f, i), TRIG = hx(cmfTrigId(slot)), CLK = hx(cmfClkId(slot)), rate = f.blinkRateMs || 350
    const owner = f.trigger?.guid, sig = f.trigger?.varName || (f.trigger?.varIndex != null ? `signal #${f.trigger.varIndex}` : '')
    if (!owner || f.trigger?.varIndex == null || !(f.targets ?? []).length) { skipped.push({ name: f.name, why: 'it needs a trigger signal and at least one output' }); return }
    const tag = `“${f.name}”: `
    if (!f.blink) {
      M(owner).steps.push(`${tag}sends “${sig}” on CAN ID ${TRIG} every 100 ms`)
      for (const t of f.targets) M(t.guid).steps.push(`${tag}listens to CAN ID ${TRIG} and switches ${outNm(t.guid, t.output)}`)
      return
    }
    const master = f.clockMaster || owner
    if (master !== owner) {
      M(owner).steps.push(`${tag}sends “${sig}” on CAN ID ${TRIG} every 100 ms`)
      M(master).steps.push(`${tag}listens to CAN ID ${TRIG} for “${sig}”`)
    }
    M(master).steps.push(`${tag}flashes ${rate} ms on / ${rate} ms off while “${sig}” is on, and sends the lamp state on CAN ID ${CLK} every 50 ms`)
    for (const t of f.targets) M(t.guid).steps.push(`${tag}follows the lamp state on CAN ID ${CLK} with ${outNm(t.guid, t.output)}`)
  })

  // Lua: generated per module, unless someone wrote it by hand for that module (all hand-written parts joined).
  const compiled = compileList(list)
  const luaFns = list.filter((f) => f && !f.disabled && cmfIsLua(f))
  const luaGuids = new Set([...Object.keys(compiled), ...luaFns.flatMap((f) => Object.keys(f.luaByModule ?? {}).filter((g) => f.luaByModule[g]?.trim()))])
  for (const g of luaGuids) {
    const m = M(g), c = compiled[g]
    const own = luaFns.map((f) => f.luaByModule?.[g]).filter((s) => s && s.trim())
    m.lua = own.length ? own.join('\n\n') : (c?.lua ?? '')
    m.outputs = (c?.bindings ?? []).map((b) => b.output)
    if (!deviceHasLua(dev(g))) { m.errors.push(`${m.name} cannot run Lua (a CANBoard, or upstream firmware without Lua). Make this a plain rule (no backup clock, no own Lua), or run it on a PDM.`); continue }
    m.steps.push(own.length ? 'gets your own Lua for these functions' : 'gets a generated Lua script for these functions')
    for (const n of m.outputs) m.steps.push(`${outNm(g, n)} is driven by the script (Lua Out ${n})`)
  }
  mods.delete('')   // never a real module (an unset clock / target)
  for (const m of mods.values()) if (!dev(m.guid)?.connected) m.errors.push(`${m.name} is not on the bus — the change is saved to the project only.`)
  return { modules: [...mods.values()].sort((a, b) => a.name.localeCompare(b.name)), skipped }
}
