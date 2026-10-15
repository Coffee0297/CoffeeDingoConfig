// Shared model of one input function (digital / analog / CAN input) on one module: its /functions row,
// the module's var map, who uses it, and the one place that writes it.
import { api, device, live, project } from '../../../lib/live.svelte.js'
import { funcArray, consumersOf } from './util.js'

export function inputModel(getGuid, getKind, getN) {
  const m = $state({ funcs: null, varmap: [], loaded: false, err: '', saving: false, saveErr: '', note: '' })

  async function reload() {
    const g = getGuid()
    try {
      const [fx, vm] = await Promise.all([api.functions(g), api.inputs(g)])
      m.funcs = fx; m.varmap = vm ?? []; m.err = ''
    } catch (e) { m.err = e?.message ?? String(e) } finally { m.loaded = true }
  }
  $effect(() => { getGuid(); reload() })

  const api2 = {
    state: m,
    reload,
    get dev() { return device(getGuid()) },
    get connected() { return live.connected && !!device(getGuid())?.connected },
    get row() { return funcArray(m.funcs, getKind()).find((x) => x.number === getN()) ?? null },
    get pin() { return m.varmap.filter((v) => v.kind === getKind() && v.number === getN()) },
    get usedBy() {
      const d = device(getGuid())
      return consumersOf(m.varmap.filter((v) => v.kind === getKind() && v.number === getN()).map((v) => v.index), m.funcs, d?.outputs, d?.name ?? '', d)
    },
    /** POST /devices/{guid}/function/{kind}/{n} with a (partial) body. Returns true when it went through. */
    async save(body) {
      m.saving = true; m.saveErr = ''; m.note = ''
      try {
        const r = await api.setFunction(getGuid(), getKind(), getN(), body)
        project.dirty = true
        m.note = r?.written ? 'Saved to the module.' : 'Saved to the project. The module did not get it (offline). Apply to car when it is back.'
        await reload()
        return true
      } catch (e) { m.saveErr = e?.message ?? String(e); return false } finally { m.saving = false }
    },
  }
  return api2
}
