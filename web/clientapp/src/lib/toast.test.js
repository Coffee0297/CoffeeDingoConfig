// node src/lib/toast.test.js — one module's failed writes share one toast; never more than 4 on screen
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { toast, toasts, dismiss } from './toast.js'

for (let i = 0; i < 30; i++) toast(`PDM-04: No reply — Write ${i}`, 'error', 0, 'notify:PDM-04')
let a = get(toasts)
assert.equal(a.length, 1)
assert.equal(a[0].count, 30)
assert.match(a[0].msg, /Write 29/)
for (let i = 0; i < 6; i++) toast(`other ${i}`, 'info', 0)
a = get(toasts)
assert.equal(a.length, 4)
assert.equal(a.at(-1).msg, 'other 5')
for (const t of a) dismiss(t.id)
assert.equal(get(toasts).length, 0)
console.log('toast ok')
