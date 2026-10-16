// The car's functions, derived from what the API really has:
//  - applied templates (templateInstances): function blocks, with their picks, blocks and outputs
//  - every other enabled output, grouped by name across modules ("Left Low Beam" + "Right Low Beam" = "Low Beam"),
//    classed by what drives it: custom code (Lua), blocks (logic between), or a helper (a direct link).
// Hand-built rows are a best-effort reading of the outputs; the flow builder's groups (/api/groups) label
// blocks on one module, not whole functions.
import { get } from 'svelte/store'
import { live, api, mutate } from '../../../lib/live.svelte.js'
import { templateInstances, syncTemplates } from '../../../../lib/store.js'
import { isMod, isCb, undoTemplate, binBody } from '../../../../lib/apply.js'
import { pinFor } from '../../../../lib/pinmap.js'
import { templateByKey, templateSystem, outputSystem, functionName, remoteText, systemName } from './catalog.js'
import { isInput, blank } from '../../../../lib/templates.js'

export const KIND = { fn: 'Function block', helper: 'Helper', blocks: 'Blocks', lua: 'Custom code (Lua)' }
const SYSTEM_ORDER = ['lights', 'signals', 'wipers', 'cooling', 'fuel', 'power', 'accessories', 'other']

const keyOf = (inst, w) => (/^\d+$/.test(String(w)) ? `${inst.guid}:${w}` : String(w))

export function createModel() {
  const m = $state({ rows: [], loading: true, error: '', loadedAt: 0, custom: [], busy: false })
  let token = 0

  async function load() {
    const my = ++token
    const devices = live.devices
    const mods = devices.filter(isMod)
    try {
      const per = await Promise.all(mods.map(async (d) => {
        const [f, vars, lua] = await Promise.all([
          api.functions(d.guid).catch(() => null), api.inputs(d.guid).catch(() => []), api.luaRead(d.guid, true).catch(() => null)])
        return { d, f, vars, lua: !!(lua?.source ?? '').trim() }
      }))
      if (my !== token) return
      const info = Object.fromEntries(per.map((p) => [p.d.guid, p]))
      m.rows = buildRows(devices, info, get(templateInstances))
      m.custom = per.filter((p) => p.lua).map((p) => p.d.name)
      m.error = ''; m.loadedAt = Date.now()
    } catch (e) { m.error = e?.message ?? String(e) }
    m.loading = false
  }

  /** Outputs of the module as {number, name, input (var index), enabled}. */
  function outsOf(p) {
    return isCb(p.d) ? (p.f?.digitalOut ?? []).map((o) => ({ number: o.number, name: o.name, input: o.enabled ? o.input : 0, enabled: !!o.enabled }))
      : (p.d.outputs ?? []).map((o) => ({ number: o.number, name: o.name, input: o.inputVal ?? 0, enabled: o.enabled !== false }))
  }

  function buildRows(devices, info, instances) {
    const devOf = (g) => devices.find((d) => d.guid === g)
    const rows = []
    const taken = new Set()
    const pinText = (g, n) => { const d = devOf(g); return d ? (pinFor(d, isCb(d) ? 'digitaloutput' : 'output', n)?.label ?? '') : '' }
    const outRef = (g, n) => ({ guid: g, n, module: devOf(g)?.name ?? '?', pin: pinText(g, n), name: info[g] ? (outsOf(info[g]).find((o) => o.number === n)?.name ?? '') : '' })
    const varName = (g, idx) => info[g]?.vars?.find((v) => v.index === idx)?.name ?? ''

    for (const inst of instances) {
      const tpl = templateByKey(inst.key)
      const outs = [...new Set((inst.wired ?? []).map((w) => keyOf(inst, w)))].map((k) => { const [g, n] = k.split(':'); return outRef(g, +n) })
      outs.forEach((o) => taken.add(`${o.guid}:${o.n}`))
      const drivers = [], uses = []
      for (const f of tpl?.fields ?? []) {
        if (f.t !== 'out' && !isInput(f)) continue
        const v = inst.sel?.[f.k]
        if (blank(v)) continue
        if (f.t === 'out') { const [g, n] = String(v).split(':'); const o = outRef(g, +n); uses.push({ what: f.label, where: `${o.module} o${o.n}${o.pin ? ' · ' + o.pin : ''}` }) }
        else {
          const nm = typeof v === 'number' ? varName(inst.guid, v) || 'signal ' + v : remoteText(v, devices)
          drivers.push(nm); uses.push({ what: f.label, where: nm })
        }
      }
      uses.push({ what: 'Logic runs on', where: devOf(inst.guid)?.name ?? 'missing module' })
      if (inst.created?.length) uses.push({ what: 'Blocks created', where: String(inst.created.length) })
      const mods = [...new Set([devOf(inst.guid)?.name, ...outs.map((o) => o.module)].filter(Boolean))]
      rows.push({ id: 'inst:' + inst.id, inst, kind: 'fn', kindLabel: KIND.fn, tag: (tpl?.name ?? inst.key).toUpperCase(), name: inst.name, system: templateSystem(inst.key),
        sentence: `${drivers.length ? drivers.slice(0, 3).join(' or ') + (drivers.length > 3 ? ' …' : '') : 'Always'} → ${outs.map((o) => o.name || 'o' + o.n).join(', ') || 'no output'}`,
        modules: mods, outputs: outs, uses, logicGuid: inst.guid, editedAt: inst.at, missing: !tpl || !devOf(inst.guid) })
    }

    // hand-built: every enabled output with a driver that no template owns
    const groups = new Map()
    for (const p of Object.values(info)) {
      for (const o of outsOf(p)) {
        if (!o.enabled || !(o.input > 0) || taken.has(`${p.d.guid}:${o.number}`)) continue
        const v = p.vars.find((x) => x.index === o.input)
        const driver = v?.kind === 'lua' ? 'lua' : ['sys', 'input', 'analoginput', 'caninput'].includes(v?.kind) ? 'helper' : 'blocks'
        const label = functionName(o.name), key = outputSystem(o.name) + '|' + label.toLowerCase()
        const g = groups.get(key) ?? { system: outputSystem(o.name), name: label, outs: [], drivers: new Set(), kinds: new Set() }
        g.outs.push({ ...outRef(p.d.guid, o.number), name: o.name })
        g.drivers.add(v?.name ?? 'signal ' + o.input); g.kinds.add(driver); groups.set(key, g)
      }
    }
    for (const [key, g] of groups) {
      const kind = g.kinds.has('lua') ? 'lua' : g.kinds.has('blocks') ? 'blocks' : 'helper'
      const mods = [...new Set(g.outs.map((o) => o.module))]
      rows.push({ id: 'hand:' + key, inst: null, kind, kindLabel: KIND[kind], tag: KIND[kind].toUpperCase(), name: g.name, system: g.system,
        sentence: kind === 'lua' ? 'Switched by custom code (Lua)' : `${[...g.drivers].slice(0, 3).join(' or ')} → ${g.name}`,
        modules: mods, outputs: g.outs,
        uses: [...g.outs.map((o) => ({ what: o.name, where: `${o.module} o${o.n}${o.pin ? ' · ' + o.pin : ''}` })), ...(kind === 'lua' ? [] : [...g.drivers].map((d) => ({ what: 'Driven by', where: d })))],
        logicGuid: g.outs[0].guid, editedAt: null })
    }
    rows.sort((a, b) => SYSTEM_ORDER.indexOf(a.system) - SYSTEM_ORDER.indexOf(b.system) || a.name.localeCompare(b.name))
    return rows
  }

  /** Live state of a row from the telemetry: { on, known, enabled, text, tone }. */
  function stateOf(row) {
    let on = false, fault = false, amps = 0, known = 0, enabled = true
    for (const o of row.outputs) {
      const d = live.devices.find((x) => x.guid === o.guid)
      const out = d?.outputs?.find((x) => x.number === o.n)
      if (!out) continue
      known++
      if (out.enabled === false) enabled = false
      if (/over|fault/i.test(out.state ?? '')) fault = true
      if (/^(on|warning|openload)$/i.test(out.state ?? '')) { on = true; amps += out.current ?? 0 }
    }
    if (!live.connected) return { on: false, known: false, enabled, text: 'no connection', tone: 'stale' }
    if (!known) return { on: false, known: false, enabled: true, text: 'not reported', tone: 'stale' }
    if (fault) return { on, known, enabled, text: 'tripped', tone: 'fault' }
    if (!enabled) return { on: false, known, enabled, text: 'turned off', tone: 'off' }
    return on ? { on, known, enabled, text: `on ${amps.toFixed(1)} A`, tone: 'on' } : { on, known, enabled, text: 'off', tone: 'off' }
  }

  /** Turn every output of an applied function off (or back on). Writes each output's own config. */
  async function setEnabled(row, enable) {
    m.busy = true
    try {
      const ok = await mutate(async () => {
        for (const o of row.outputs) {
          const d = live.devices.find((x) => x.guid === o.guid); if (!d) continue
          if (isCb(d)) await api.setFunction(d.guid, 'digitaloutput', o.n, { enabled: enable })
          else {
            const out = (d.outputs ?? []).find((x) => x.number === o.n); if (!out) continue
            await api.outputConfig(d.guid, binBody(out, out.inputVal ?? 0, enable))
          }
        }
        return true
      }, enable ? `Turned “${row.name}” on.` : `Turned “${row.name}” off.`)
      await load()
      return !!ok
    } finally { m.busy = false }
  }

  /** Remove an applied function: its blocks are disabled and its outputs put back as they were. */
  async function remove(row) {
    m.busy = true
    try {
      const others = get(templateInstances).filter((i) => i.id !== row.inst.id)
      const ok = await mutate(async () => { await undoTemplate(api, live.devices, row.inst, others); templateInstances.set(others); return true }, `Removed “${row.name}”.`)
      await load()
      return !!ok
    } finally { m.busy = false }
  }

  return { m, load, stateOf, setEnabled, remove, syncTemplates }
}
export { systemName }
