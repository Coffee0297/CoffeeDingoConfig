// Firmware: which path a module takes, which file fits which board, and file checks.
// The module itself refuses a wrong-board image (DINGO_BOARD marker); the name check here only warns earlier.

/** File-name prefix of release images per board. */
export const BOARDS = {
  canboard: { key: 'canboard', label: 'CANBoard' },
  pdmmax: { key: 'dingopdmmax', label: 'dingoPDM-Max' },
  pdm: { key: 'dingopdm_v7', label: 'dingoPDM' },
}

export const boardOf = (d) => (/canboard/i.test(d.type ?? '') ? BOARDS.canboard : /max/i.test(d.type ?? '') ? BOARDS.pdmmax : BOARDS.pdm)

/** Board a file name says it is for, or null when the name does not say. */
export function boardOfFile(name) {
  const n = (name ?? '').toLowerCase()
  if (n.startsWith('canboard')) return BOARDS.canboard
  if (n.startsWith('dingopdmmax') || n.startsWith('dingopdm-max')) return BOARDS.pdmmax
  if (n.startsWith('dingopdm')) return BOARDS.pdm
  return null
}

/** Version in a release file name: dingopdm_v7-v5-5-112.srec -> 5.5.112 */
export const fileVersion = (name) => (name ?? '').match(/v(\d+)[.-](\d+)[.-](\d+)\.[a-z0-9]+$/i)?.slice(1).join('.') ?? null   // _FW_v5-6-4.bin or _v5.6.4.bin
export const cleanVersion = (v) => String(v ?? '').replace(/^v/i, '')

/**
 * Which flash path a module takes: 'can' | 'usb' | null (cannot be flashed here).
 * CANBoard: CAN. dingoPDM: USB when it is the link module (bridges USB to CAN), otherwise CAN.
 */
export function flashPath(d, busConnected) {
  if (/canboard/i.test(d.type ?? '')) return d.canBootloader ? 'can' : null
  if (!/pdm/i.test(d.type ?? '')) return null
  if (!busConnected || !d.canBootloader) return 'usb'
  return d.isGateway ? 'usb' : 'can'
}
export const pathLabel = (p) => (p === 'can' ? 'CAN' : p === 'usb' ? 'USB (link module)' : 'not flashable here')
export const extFor = (path) => (path === 'can' ? '.srec' : '.bin')

/** Does this file fit this module? { ok, reason } */
export function checkFile(d, file, path) {
  if (!file) return { ok: false, reason: 'Choose a file first.' }
  const ext = extFor(path)
  if (!file.name.toLowerCase().endsWith(ext)) return { ok: false, reason: `A ${pathLabel(path)} update needs a ${ext} file.` }
  const guess = boardOfFile(file.name)
  if (guess && guess.key !== boardOf(d).key) return { ok: false, reason: `${file.name} is for a ${guess.label}, but ${d.name} is a ${boardOf(d).label}.` }
  return { ok: true, reason: guess ? '' : 'The file name does not say which board it is for. The module checks the image itself and refuses a wrong one.' }
}

/** Last meaningful line of a flash log. */
export const lastLine = (log) => String(log ?? '').trimEnd().split('\n').filter(Boolean).at(-1) ?? ''

/** Compare dotted versions numerically: <0 when a is older than b. Non-numeric (testing-latest) sorts last. */
export function cmpVersion(a, b) {
  const p = (v) => cleanVersion(v).split('.').map(Number)
  const x = p(a), y = p(b)
  if (x.some(isNaN) || y.some(isNaN)) return x.some(isNaN) === y.some(isNaN) ? 0 : x.some(isNaN) ? -1 : 1
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** A release against the versions the modules run: 'older' | 'same' | 'newer' | 'mixed' | null (nothing known). */
export function relationTo(version, installed) {
  const known = installed.filter((v) => /^\d+(\.\d+)*$/.test(cleanVersion(v)))
  if (!known.length || !/^\d+(\.\d+)*$/.test(cleanVersion(version))) return null
  const c = known.map((v) => Math.sign(cmpVersion(version, v)))
  if (c.every((x) => x < 0)) return 'older'
  if (c.every((x) => x === 0)) return 'same'
  if (c.every((x) => x > 0)) return 'newer'
  return c.some((x) => x < 0) ? 'mixed' : 'newer'
}
export const relationLabel = { older: 'older than installed', same: 'same as installed', newer: 'newer', mixed: 'older than some modules' }
