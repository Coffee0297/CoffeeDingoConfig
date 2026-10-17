// "Build it myself" for any function: the template's inputs and outputs are set up exactly as Apply would (pins
// enabled, signals from other modules / ECUs as CAN inputs, outputs taken over), but the logic is left to you:
// - blocks: the outputs are not wired; the flow builder opens on this function's page with the inputs and
//   outputs on the canvas, ready to wire;
// - lua: each output is driven by a free Lua Out, and a stub that reads every input and sets those Lua Outs is
//   added to the module's Lua (before its onTick, which calls it); the Lua editor opens on it.
import { api, live } from '../../../lib/live.svelte.js'
import { applyTemplate } from '../../../../lib/apply.js'
import { buildModel } from '../flow/model.js'
import { href } from '../../../router.svelte.js'

const blank = (v) => v == null || v === ''
const ident = (s, used) => {
  let b = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x'
  if (/^\d/.test(b)) b = 'x_' + b
  let n = b, i = 2
  while (used.has(n)) n = `${b}_${i++}`
  used.add(n)
  return n
}

/** Lua Out var indexes on `guid` that nothing reads and the module's Lua does not set. */
async function freeLuaOuts(guid, source) {
  const dev = live.devices.find((d) => d.guid === guid)
  const [funcs, vmap] = await Promise.all([api.functions(guid), api.inputs(guid)])
  const model = buildModel(dev, funcs, vmap)
  const set = new Set()
  for (const m of source.matchAll(/setLuaOut\s*\(\s*(\d+)/g)) set.add(+m[1] + 1)     // setLuaOut(n) drives Lua Out n+1
  for (const m of source.matchAll(/\bout\s*\(\s*(\d+)/g)) set.add(+m[1])               // the common out(n) helper
  return vmap.filter((v) => v.kind === 'lua' && !set.has(v.number) && !(model.consumers.get(v.index)?.length)).sort((a, b) => a.number - b.number)
}

export async function buildMyself(mode, { tpl, sel, relays, name, inOpt, outOpts, logicGuid, others }) {
  const fnName = (name ?? '').trim() || tpl.name
  const outsF = tpl.fields.filter((f) => f.t === 'out' && !blank(sel[f.k]))
  const insF = tpl.fields.filter((f) => f.t !== 'out' && f.t !== 'number' && f.t !== 'op' && f.t !== 'check' && !blank(sel[f.k]))
  if (mode === 'lua' && live.devices.find((d) => d.guid === logicGuid)?.type?.match(/canboard/i)) throw new Error('Lua runs on a dingoPDM: pick the outputs on a PDM for a Lua function')
  if (mode === 'lua' && outsF.some((f) => !String(sel[f.k]).startsWith(logicGuid + ':'))) throw new Error('For Lua, every output has to be on the module that runs it. Pick outputs on one PDM.')
  const stored = (await fetch(`/api/devices/${logicGuid}/lua?stored=true`).then((r) => r.json()).catch(() => null))?.source ?? ''
  const lua = mode === 'lua' ? await freeLuaOuts(logicGuid, stored) : []
  if (mode === 'lua' && lua.length < outsF.length) throw new Error(`Not enough free Lua Outs on this module (${lua.length} free, ${outsF.length} needed)`)
  const luaFor = Object.fromEntries(outsF.map((f, i) => [f.k, lua[i]]))
  let resolved = null
  const custom = { ...tpl, build: async (ctx, s) => {
    resolved = s
    if (mode === 'lua') for (const f of outsF) await ctx.wireOutput(sel[f.k], luaFor[f.k].index)
  } }
  await applyTemplate(api, { devices: live.devices, tpl: custom, sel, relays, name: fnName, id: crypto.randomUUID(), others, inOpt, outOpts })
  const vmap = await api.inputs(logicGuid)
  const varOf = (i) => vmap.find((v) => v.index === i)
  if (mode === 'blocks') {
    // the function's page: its outputs and the input blocks, so they are on the canvas to wire
    const show = [...outsF.map((f) => { const [g, n] = String(sel[f.k]).split(':'); return `${g}|o:${n}` }),
      ...insF.map((f) => varOf(resolved[f.k])).filter((v) => v && v.kind !== 'sys').map((v) => `${logicGuid}|${v.kind}:${v.number}`)]
    return href('functions', 'flow', logicGuid, { fn: fnName, show: show.join(',') })
  }
  // Lua: a stub per function, called from onTick
  const used = new Set()
  const fn = 'fn_' + ident(fnName, new Set())
  const lines = [`-- ${fnName}: built by hand (inputs and outputs from the "${tpl.name}" setup)`, `local function ${fn}()`]
  for (const f of insF) {
    const v = varOf(resolved[f.k]), id = ident(f.label, used)
    lines.push(f.t === 'bool' ? `  local ${id} = readVar(${resolved[f.k]}) ~= 0   -- ${f.label}: ${v?.name ?? ''} (on/off)` : `  local ${id} = readVar(${resolved[f.k]})   -- ${f.label}: ${v?.name ?? ''} (a number)`)
  }
  lines.push('  -- your logic: drive each output with setLuaOut (1 = on, 0 = off)')
  for (const f of outsF) lines.push(`  setLuaOut(${luaFor[f.k].number - 1}, 0)   -- ${luaFor[f.k].name} -> ${outOpts.find((o) => o.value === sel[f.k])?.label?.split(' · ').slice(0, 2).join(' · ') ?? f.label} (${f.label})`)
  lines.push('end', '')
  const stub = lines.join('\n')
  let src
  if (/^\s*function\s+onTick\s*\(\s*\)\s*$/m.test(stored))
    src = stored.replace(/^(\s*)function\s+onTick\s*\(\s*\)\s*$/m, (m) => `${stub}\n${m}\n  ${fn}()`)
  else if (/onTick/.test(stored)) src = `${stored.replace(/\s*$/, '\n\n')}${stub}-- call ${fn}() from your onTick\n`   // an onTick this can't edit safely
  else src = `${stored ? stored.replace(/\s*$/, '\n\n') : ''}${stub}\nfunction onTick()\n  ${fn}()\nend\n${/setTickRate/.test(stored) ? '' : 'setTickRate(50)\n'}`
  const r = await fetch(`/api/devices/${logicGuid}/lua`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(location.hash.startsWith('#/next') ? { 'X-Dingo-Stage': '1' } : {}) }, body: JSON.stringify({ Source: src }) })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `Lua not saved (HTTP ${r.status})`)
  return href('expert', 'lua', logicGuid)
}
