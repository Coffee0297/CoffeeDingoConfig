// Wake frame (upstream dingoFW feat/wake-on-frame, param 0x0100 subs 0-7). Pure helpers for the Sleep & wake card.
// While enabled, only a frame with this id/IDE, at least minLength bytes and (data & mask) == (value & mask) keeps
// the module awake (counts as bus activity for the sleep timer). Any CAN edge still wakes it from sleep.
export const INDEX = 0x0100

const pack = (b, from) => ((b[from] & 0xff) | (b[from + 1] & 0xff) << 8 | (b[from + 2] & 0xff) << 16 | (b[from + 3] & 0xff) << 24) >>> 0

/** Byte text in hex ("FF", "0x1a") -> 0..255, or null. */
export function parseByte(s) {
  const t = String(s ?? '').trim().replace(/^0x/i, '')
  if (!/^[0-9a-f]{1,2}$/i.test(t)) return null
  return parseInt(t, 16)
}
export const byteText = (n) => (n & 0xff).toString(16).toUpperCase().padStart(2, '0')

/** What is wrong with a wake frame draft, or ''. */
export function problem(wf) {
  if (!Number.isInteger(wf.id) || wf.id < 0 || wf.id > (wf.ext ? 0x1fffffff : 0x7ff)) return wf.ext ? 'An extended ID is 0 to 1FFFFFFF.' : 'A standard ID is 0 to 7FF.'
  if (!Number.isInteger(wf.minLength) || wf.minLength < 0 || wf.minLength > 8) return 'The length is 0 to 8 bytes.'
  if ([...wf.mask, ...wf.value].some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return 'Each byte is 00 to FF.'
  return ''
}

/** The param writes [sub, value] for a draft; enable goes last, so the module never matches half a frame. */
export const writes = (wf) => [[1, wf.id], [2, wf.ext ? 1 : 0], [3, wf.minLength], [4, pack(wf.mask, 0)], [5, pack(wf.mask, 4)],
  [6, pack(wf.value, 0)], [7, pack(wf.value, 4)], [0, wf.enabled ? 1 : 0]]

/** Fill id, IDE, length and the value bytes from a frame seen on the bus ({ id, ext, len, data: "AA 01 .." }); masks stay. */
export function fromFrame(wf, f) {
  const bytes = String(f.data ?? '').trim().split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16))
  return { ...wf, id: f.id, ext: !!f.ext, minLength: f.len ?? bytes.length, value: Array.from({ length: 8 }, (_, i) => bytes[i] ?? 0) }
}

/** Does a seen frame keep the module awake under this wake frame (firmware IsWakeActivity)? Bytes past its length read 0. */
export function matches(wf, f) {
  if (f.id !== wf.id || !!f.ext !== !!wf.ext || (f.len ?? 0) < wf.minLength) return false
  const bytes = String(f.data ?? '').trim().split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16))
  return wf.mask.every((m, i) => (((i < f.len ? bytes[i] : 0) ?? 0) & m) === (wf.value[i] & m))
}
