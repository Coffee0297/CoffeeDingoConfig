// Config lock (upstream dingoFW feat/config-lock, param 0x0200): password + installer contact text.
import { isUpstream } from './util.js'

// The module never reads the password back, so the project keeps it and every write sends it again.

/** The password as typed: 1..4294967295, decimal or 0x hex. { value } or { error }. */
export function parsePassword(s) {
  const t = String(s ?? '').trim()
  if (!t) return { error: 'Type a password.' }
  const v = /^0x[0-9a-f]{1,8}$/i.test(t) ? parseInt(t, 16) : /^\d{1,10}$/.test(t) ? Number(t) : NaN
  if (!Number.isInteger(v)) return { error: 'Use digits (or a 0x hex number): the module stores a 32-bit number.' }
  if (v === 0) return { error: '0 means "no password". Use "Remove the password" instead.' }
  if (v > 0xffffffff) return { error: 'At most 4294967295 (0xFFFFFFFF).' }
  return { value: v }
}

/** Why the contact text can't be stored, or '' (32 plain ASCII chars, like the firmware's 8 × 4 bytes). */
export function contactProblem(s) {
  const t = s ?? ''
  if (t.length > 32) return `At most 32 characters (${t.length} now).`
  if (/[^\x20-\x7e]/.test(t)) return 'Plain letters, digits, spaces and punctuation only (no accents or emoji).'
  return ''
}

/** What the module page says about the lock: null when the module's firmware has none. */
export function lockSummary(dev) {
  const l = dev?.lock
  if (!l?.has || !isUpstream(dev)) return null   // fork 5.x has no lock
  if (l.locked) return { tone: 'warn', title: `${dev.name} is locked by its installer`, text: l.contact ? `Contact: ${l.contact}` : 'No contact text was left.' }
  if (l.passwordSet) return { tone: 'info', title: 'Password set in the project', text: 'Every write sends it. Once stored and the module has restarted, it refuses reads and changes without it.' }
  return { tone: 'info', title: 'Not locked', text: 'Anyone on the bus can read and change this module\'s configuration.' }
}
