// "Build it myself" for the ignition. The Ignition block stays (it runs the state machine, the starter and the
// roles); what you build yourself is the signals it reads:
// - blocks: the flow builder opens on the main module with the Ignition block and what feeds it;
// - lua: each signal comes from a free Lua Out; a stub that computes today's rules (readVar, NOT, OR/AND, number
//   tests) is added to the module's Lua, so nothing changes until you edit it; the rule helper blocks are freed.
import { api } from '../../../lib/live.svelte.js'
import { resolveRemote } from '../../../lib/remote.js'
import { href } from '../../../router.svelte.js'
import { freeLuaOuts, withStub, saveLua } from '../../functions/parts/buildMyself.js'
import { compileRule, ruleSet } from './signalRule.js'

const LUA_OP = { 0: '==', 1: '~=', 2: '>', 3: '<', 4: '>=', 5: '<=' }

/** The flow builder on the main module: the Ignition block, its signals' blocks and the outputs that follow it
 *  (the starter and other roles). `dev` = the main module's live record. */
export function ignitionBlocksHref(dev) {
  const outs = (dev?.outputs ?? []).filter((o) => /^Ignition /.test(o.input ?? '')).map((o) => `${dev.guid}|o:${o.number}`)
  return href('functions', 'flow', dev?.guid, { fn: 'Ignition', show: [`${dev?.guid}|ignition:1`, ...outs].join(',') })
}

/** One side of a rule as a Lua expression (resolving a signal from another module or an ECU first). */
async function sideExpr(guid, s) {
  const idx = await resolveRemote(guid, s.key, s.cmp ? 'num' : 'bool')
  const e = s.cmp ? `readVar(${idx}) ${LUA_OP[s.cmp.op] ?? '>'} ${Number(s.cmp.value)}` : `readVar(${idx}) ~= 0`
  return s.not ? `not (${e})` : e
}

/** Rules -> Lua. `fields` = { ignitionInput: 'Switch', … }; returns the Lua editor's href. */
export async function ignitionToLua(guid, rules, fields, skip = []) {
  const stored = (await fetch(`/api/devices/${guid}/lua?stored=true`).then((r) => r.json()).catch(() => null))?.source ?? ''
  if (/fn_ignition\s*\(/.test(stored)) throw new Error('The Lua already has fn_ignition: edit it there.')
  const keys = Object.keys(fields).filter((k) => !skip.includes(k))
  const lua = await freeLuaOuts(guid, stored)
  if (lua.length < keys.length) throw new Error(`Not enough free Lua Outs on this module (${lua.length} free, ${keys.length} needed)`)
  const lines = ['-- Ignition signals, built by hand: each setLuaOut feeds one input of the Ignition block.',
    '-- They start as the rules set on the Ignition page; change them as you like.', 'local function fn_ignition()']
  const set = {}
  for (const [i, k] of keys.entries()) {
    const r = rules[k], out = lua[i]
    let expr = 'false'
    if (ruleSet(r)) {
      expr = await sideExpr(guid, r.a)
      if (r.join) expr = `(${expr}) ${r.join === 'and' ? 'and' : 'or'} (${await sideExpr(guid, r.b)})`
    }
    lines.push(`  setLuaOut(${out.number - 1}, (${expr}) and 1 or 0)   -- ${out.name} -> ${fields[k]}`)
    set[k] = out.index
  }
  lines.push('end', '')
  await saveLua(guid, withStub(stored, 'fn_ignition', lines.join('\n')))
  // the rule helper blocks ("Ign …") are no longer needed: free them, then point the block at the Lua Outs
  for (const [k, label] of Object.entries(fields)) if (set[k]) await compileRule(guid, label, null)
  await api.setFunction(guid, 'ignition', 1, set)
  return href('expert', 'lua', guid)
}
