// Reads the power-down sequence back from the modules' own config. The old designer names its blocks
// ("Sleep · off delay" ...), so the configuration IS the sequence. Reads /functions per module; no writes.
import { api, live } from '../../../lib/live.svelte.js'

const N = { sleep: 'Sleep · off delay', quiet: 'Sleep · quiet CAN', hold: 'Sleep · hold outputs', frame: 'Sleep · shutdown frame', master: 'Sleep master' }

export function watchSequence(everyMs = 15000) {
  const state = $state({ perModule: {}, loaded: false })
  let stopped = false, timer
  async function load() {
    const list = live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? ''))
    if (list.length) {
      const pairs = await Promise.all(list.map((d) => api.functions(d.guid).then((f) => [d.guid, f]).catch(() => [d.guid, null])))
      const perModule = {}
      for (const [g, f] of pairs) {
        const on = (arr, name) => (arr ?? []).find((x) => x.enabled && x.name === name)
        const sec = (t) => (t ? Math.round(t.preset / 1000) : null)
        const fo = on(f?.canOutputs, N.frame)
        perModule[g] = {
          sleepS: sec(on(f?.timers, N.sleep)),
          quietS: sec(on(f?.timers, N.quiet)),
          holdS: sec(on(f?.timers, N.hold)),
          frameS: sec(on(f?.timers, N.frame)),
          frame: fo ? { id: fo.id, intervalMs: fo.interval } : null,
          follows: !!on(f?.canInputs, N.master),
        }
      }
      state.perModule = perModule
      state.loaded = true
    }
    if (!stopped) timer = setTimeout(load, list.length ? everyMs : 700)
  }
  load()
  return { state, stop() { stopped = true; clearTimeout(timer) } }
}
