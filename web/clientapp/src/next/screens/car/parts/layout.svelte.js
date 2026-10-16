// One car layout for every map (Car home, first run). Positions are percentages of the car outline, kept in
// this browser under "pinpos" (the old UI's key, saved with the project file's client section). A module with
// no position sits in the tray beside the car: that, and only that, is "not placed".
const KEY = 'pinpos'
const read = () => { try { return localStorage.getItem(KEY) || '{}' } catch { return '{}' } }
const parse = (s) => { try { return JSON.parse(s) ?? {} } catch { return {} } }
let raw = read()
export const layout = $state({ pos: parse(raw) })

function save() { raw = JSON.stringify(layout.pos); try { localStorage.setItem(KEY, raw) } catch { /* private mode: keep in memory */ } }
/** Re-read storage: opening a project (or the old UI) rewrites it behind our back. */
export function refreshLayout() { const r = read(); if (r !== raw) { raw = r; layout.pos = parse(r) } }
export function setPos(guid, p, persist = true) { layout.pos = { ...layout.pos, [guid]: p }; if (persist) save() }
export function unplace(guid, persist = true) { const n = { ...layout.pos }; delete n[guid]; layout.pos = n; if (persist) save() }
export const persistLayout = save

const SPOTS = [[22, 20], [78, 20], [22, 80], [78, 80], [50, 52], [50, 9], [50, 92], [50, 34], [22, 52], [78, 52]]
/** Default spot, by base ID order so every screen agrees whatever order it lists the modules in. */
export function defaultSpot(devices, guid) {
  const i = Math.max(0, [...devices].sort((a, b) => a.baseId - b.baseId).findIndex((d) => d.guid === guid))
  const s = SPOTS[i % SPOTS.length]
  return { x: s[0], y: s[1] }
}
export function placeAt(devices, guids) {
  const n = { ...layout.pos }
  for (const g of guids) n[g] = defaultSpot(devices, g)
  layout.pos = n; save()
}
