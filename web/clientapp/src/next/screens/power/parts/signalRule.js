// A signal rule for the ignition setup: "[NOT] signal [is above 300] [OR / AND [NOT] signal [...]]". The Ignition
// block takes one on/off signal per field, so a rule that needs more is built from helper blocks on the main
// module, named "Ign <field>…" so the page can read them back and reuse their slots: a Compare per number side,
// a Combine for NOT / OR / AND.
import { api } from '../../../lib/live.svelte.js'
import { resolveRemote } from '../../../lib/remote.js'

export const OPS = [{ value: '2', label: 'is above' }, { value: '4', label: 'is at least' }, { value: '3', label: 'is below' },
  { value: '5', label: 'is at most' }, { value: '0', label: 'equals' }, { value: '1', label: 'is not' }]
const PFX = 'Ign '
export const emptySide = () => ({ key: '0', not: false, cmp: null })
export const emptyRule = () => ({ a: emptySide(), join: '', b: emptySide() })
export const ruleSet = (r) => !!r && r.a.key !== '0'
const stateIdx = (vmap, kind, n) => vmap.find((v) => v.kind === kind && v.number === n && v.type === 'bool')?.index ?? 0

/** A field's var index -> its rule; helper blocks this page made are read back into the rule. */
export function decodeRule(idx, funcs, vmap) {
  const r = emptyRule()
  const side = (i, not) => {
    const w = vmap.find((x) => x.index === i)
    const c = w?.kind === 'condition' ? (funcs?.conditions ?? []).find((x) => x.number === w.number) : null
    if (c?.name?.startsWith(PFX)) return { key: String(c.input), not, cmp: { op: String(c.operator), value: c.arg } }
    return { key: String(i || 0), not, cmp: null }
  }
  const v = vmap.find((x) => x.index === idx)
  const vi = v?.kind === 'virtualinput' ? (funcs?.virtualInputs ?? []).find((x) => x.number === v.number) : null
  if (vi?.name?.startsWith(PFX)) {
    r.a = side(vi.var0, !!vi.not0)
    if (vi.var1 && !(vi.var1 === vi.var0 && !!vi.not1 === !!vi.not0)) { r.join = vi.cond0 === 1 ? 'or' : 'and'; r.b = side(vi.var1, !!vi.not1) }
    return r
  }
  r.a = side(idx, false)
  return r
}

/** Rule -> the one var index the Ignition block reads, writing (or reusing) the helper blocks it needs. */
export async function compileRule(guid, label, rule) {
  const own = PFX + label
  const funcs = await api.functions(guid), vmap = await api.inputs(guid)
  const used = { conditions: new Set(), virtualInputs: new Set() }
  const slot = (arr, name) => {
    const list = funcs?.[arr] ?? []
    const s = list.find((x) => x.name === name) ?? list.find((x) => !x.enabled && !used[arr].has(x.number) && !x.name?.startsWith(PFX))
    if (!s) throw new Error(`No free ${arr === 'conditions' ? 'Compare' : 'Combine'} block on the main module for ${label}. Free one in the flow builder.`)
    used[arr].add(s.number)
    return s.number
  }
  const side = async (s, tag) => {
    const idx = await resolveRemote(guid, s.key, s.cmp ? 'num' : 'bool')
    if (!s.cmp) return idx
    const name = `${own} ${tag}`.slice(0, 32), n = slot('conditions', name)
    await api.setFunction(guid, 'condition', n, { enabled: true, name, input: idx, operator: Number(s.cmp.op), arg: Number(s.cmp.value), argOff: Number(s.cmp.value) })
    return stateIdx(vmap, 'condition', n)
  }
  let out = 0
  if (ruleSet(rule)) {
    const a = await side(rule.a, 'A')
    if (!rule.join && !rule.a.not) out = a
    else {
      // NOT alone: the Combine needs two inputs, so it reads the same signal twice ("NOT A or NOT A")
      const b = rule.join ? await side(rule.b, 'B') : a
      const name = own.slice(0, 32), n = slot('virtualInputs', name)
      await api.setFunction(guid, 'virtualinput', n, { enabled: true, name, var0: a, not0: !!rule.a.not, cond0: rule.join === 'and' ? 0 : 1,
        var1: b, not1: rule.join ? !!rule.b.not : !!rule.a.not, cond1: 0, var2: 0, not2: false, mode: 0 })
      out = stateIdx(vmap, 'virtualinput', n)
    }
  }
  // helper blocks of this field the rule no longer needs are switched off
  for (const [arr, kind] of [['conditions', 'condition'], ['virtualInputs', 'virtualinput']])
    for (const x of funcs?.[arr] ?? []) if (x.enabled && x.name?.startsWith(own) && !used[arr].has(x.number)) await api.setFunction(guid, kind, x.number, { enabled: false })
  return out
}
