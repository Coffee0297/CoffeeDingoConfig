// Tiny non-blocking toast store — replaces native alert() for hardware write feedback
// (alert freezes the 10 Hz telemetry render loop). Rendered by the Toaster in App.svelte.
import { writable } from 'svelte/store'

export const toasts = writable([])
let _id = 0

export function toast(msg, kind = 'info', ms = 4000) {
  const id = ++_id
  toasts.update((a) => [...a, { id, msg, kind }])
  if (ms) setTimeout(() => dismiss(id), ms)
  return id
}
export const dismiss = (id) => toasts.update((a) => a.filter((t) => t.id !== id))
