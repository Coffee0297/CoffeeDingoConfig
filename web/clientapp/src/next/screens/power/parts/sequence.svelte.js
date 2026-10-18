// Reads the sleep setup back from the modules' own config: the blocks are named "Sleep · …" (lib/sleepPlan.js),
// so the configuration IS the setup. Reads /functions per module (and the master's signal names); no writes.
import { api, live } from '../../../lib/live.svelte.js'
import { readSleep } from '../../../../lib/sleepPlan.js'

export function watchSequence(everyMs = 15000) {
  const state = $state({ perModule: {}, names: {}, loaded: false })
  let stopped = false, timer
  async function load() {
    const list = live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? ''))
    if (list.length) {
      const pairs = await Promise.all(list.map((d) => api.functions(d.guid).then((f) => [d.guid, f]).catch(() => [d.guid, null])))
      const perModule = Object.fromEntries(pairs.map(([g, f]) => [g, readSleep(f)]))
      const m = Object.keys(perModule).find((g) => perModule[g].master)
      const v = m ? await api.inputs(m).catch(() => []) : []
      state.names = Object.fromEntries(v.map((x) => [x.index, x.name]))
      state.perModule = perModule
      state.loaded = true
    }
    if (!stopped) timer = setTimeout(load, list.length ? everyMs : 700)
  }
  load()
  return { state, stop() { stopped = true; clearTimeout(timer) } }
}
