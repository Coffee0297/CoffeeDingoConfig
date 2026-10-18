// Tiny non-blocking toast store — replaces native alert() for hardware write feedback
// (alert freezes the 10 Hz telemetry render loop). Rendered by next/shell/Toasts.svelte.
import { writable } from 'svelte/store'

export const toasts = writable([])
let _id = 0

const timers = new Map()
const MAX = 4   // more would cover the page (a module that stops answering fails every queued write: dozens at once)

/** `group`: toasts of one group (one module's failed writes) share one toast that counts them. */
export function toast(msg, kind = 'info', ms = 4000, group = null) {
  let id = null
  toasts.update((a) => {
    const same = group && a.find((t) => t.group === group)
    if (same) { id = same.id; return a.map((t) => (t === same ? { ...t, msg, count: (t.count ?? 1) + 1 } : t)) }
    id = ++_id
    return [...a, { id, msg, kind, group }].slice(-MAX)
  })
  clearTimeout(timers.get(id))
  if (ms) timers.set(id, setTimeout(() => dismiss(id), ms))
  return id
}
export const dismiss = (id) => { clearTimeout(timers.get(id)); timers.delete(id); toasts.update((a) => a.filter((t) => t.id !== id)) }
