// Ignition (firmware 5.6) helpers shared by Power home, the dashboard, Car home and the output screens.
import { parseVersion, lacks, isUpstream, has } from '../../hardware/parts/util.js'
import { spanAfter, isModule } from '../../../../lib/canids.js'

/** The module has the ignition block: fork firmware 5.6 or newer (an unknown version is not counted), or an upstream
 *  module whose param list has 0x1E00. */
export const has56 = (d) => (isUpstream(d) || !!parseVersion(d?.version)) && !lacks(d, [5, 6, 0], 0x1E00)

/** The module that runs the ignition (its Ignition block is on, role main, or standalone on 5.7), or null. */
export const ignitionMain = (devices) => devices.find((d) => d.ignition?.enabled && (d.ignition.role === 'main' || d.ignition.role === 'standalone')) ?? null

/** Firmware 5.7 ignition parity: the module's list has the sync settings (0x1E00 sub 11; sub 10 is then the sync id). */
export const hasSync = (d) => isUpstream(d) && has(d, 0x1E00, 11)
export const DEFAULT_SYNC_ID = 0x6F1
const hx = (n) => '0x' + n.toString(16).toUpperCase().padStart(3, '0')

/** The sync frame's id: mode 0 = `value` is the id, 1 = an offset from the main's base. Mirrors the firmware: the main
 *  sends nothing for an id in its own range (PDM base .. its status frame, CANBoard .. +13) or above 0x7FF. warn: the id
 *  is another module's frame (the firmware cannot know). */
export function resolveSync(main, mode, value, devices = []) {
  const v = Number(value)
  if (!Number.isInteger(v) || v < 0 || v > 0x7FF) return { id: null, error: `The sync ${mode === 1 ? 'offset' : 'id'} must be 0 to 0x7FF.`, warn: '' }
  const id = mode === 1 ? main.baseId + v : v
  if (id > 0x7FF) return { id, error: `${hx(main.baseId)} + ${v} = ${hx(id)} is above 0x7FF.`, warn: '' }
  const own = /canboard/i.test(main.type ?? '') ? 13 : (main.ignition?.stateId ?? main.baseId + 36) - main.baseId
  if (id >= main.baseId && id <= main.baseId + own)
    return { id, error: `${hx(id)} is one of ${main.name}'s own frames (${hx(main.baseId)}..${hx(main.baseId + own)}); it would send nothing.${mode === 1 ? ` Use an offset of ${own + 1} or more.` : ''}`, warn: '' }
  const other = devices.find((d) => d.guid !== main.guid && isModule(d.type) && id >= d.baseId && id <= d.baseId + spanAfter(d.type, d))
  return { id, error: '', warn: other ? `${hx(id)} is one of ${other.name}'s frames (${hx(other.baseId)}..${hx(other.baseId + spanAfter(other.type, other))}).` : '' }
}

/** The 5.7 ignition status (DTO ignition.status) in words: dash, sleep, link. */
const DASH = ['off', 'on', 'grace (dash still on)', 'halting (dash shutting down)', 'restart (dash unpowered 2 s)']
const SLEEP = ['', 'awake', 'counting down', 'following the main', 'waiting for the dash', 'held awake (USB or config)', 'going quiet', 'asleep']
const LINK = ['', 'hears the main', 'main lost', 'sync id invalid']
export function statusWords(st) {
  if (!st) return ''
  return [`dash ${DASH[st.dash] ?? st.dash}`, st.sleep === 2 ? `sleep in ${st.sleepInS} s` : SLEEP[st.sleep], LINK[st.link]].filter(Boolean).join(' · ')
}

export const IGN_WORD = { off: 'Off', on: 'On', cranking: 'Cranking', running: 'Running' }

/** { value, sub } for a summary tile: the live state, or why there is none. */
export function ignitionTile(devices) {
  const m = ignitionMain(devices)
  if (m) return m.ignition.live ? { value: IGN_WORD[m.ignition.state] ?? m.ignition.state, sub: `from ${m.name}` } : { value: '—', sub: `${m.name} is not sending its state` }
  return devices.some(has56) ? { value: 'Not set up', sub: 'pick the switch and button' } : null
}

/** The CANBoard a migration-report fix names ("ignition-main:<guid>"), or null. */
export const fixMain = (fix) => /^ignition-main:(.+)$/.exec(fix ?? '')?.[1] ?? null

/** CANBoards that can take the main role from `main`: they have the ignition block (or are a converted 5.7 record not
 *  read yet: the backend checks) and are not it. */
export const mainCandidates = (devices, main) =>
  devices.filter((d) => /canboard/i.test(d.type ?? '') && (has56(d) || (isUpstream(d) && !d.paramRuns)) && d.guid !== main?.guid)
