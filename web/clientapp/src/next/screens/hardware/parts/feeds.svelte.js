// Live polling helpers (call inside a component's script so $effect has an owner).
import { api } from '../../../lib/live.svelte.js'

/**
 * Poll /devices/{guid}/signals. feed.get('Digital input', name) -> { value, on, enabled } | undefined.
 * `ts` changes after each successful poll; `error` holds the last failure text ('' when fine).
 * The backend keys signals by (kind, name); the same name can exist under two kinds, so always pass both.
 */
export function signalFeed(getGuid, ms = 200, getPaused = () => false) {
  const st = $state({ map: {}, ts: 0, error: '' })
  st.get = (kind, name) => st.map[kind + '|' + name]
  $effect(() => {
    const g = getGuid()
    if (!g) return
    let alive = true, busy = false
    const tick = async () => {
      if (busy || getPaused()) return
      busy = true
      try {
        const list = await api.signals(g)
        if (!alive) return
        const m = {}
        for (const s of list ?? []) m[s.kind + '|' + s.name] = { value: s.value, on: !!s.on, enabled: !!s.enabled }
        st.map = m; st.ts = Date.now(); st.error = ''
      } catch (e) { if (alive) st.error = e?.message ?? String(e) } finally { busy = false }
    }
    tick()
    const id = setInterval(tick, ms)
    return () => { alive = false; clearInterval(id) }
  })
  return st
}

/** A time-stamped ring: push(v) each tick, samples() -> [{t,v}] limited to the last windowMs. */
export function ring(windowMs) {
  let buf = []
  return {
    push(v, t = Date.now()) { buf.push({ t, v }); const cut = t - windowMs - 1000; while (buf.length && buf[0].t < cut) buf.shift() },
    samples: () => buf,
    clear() { buf = [] },
  }
}
