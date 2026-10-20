// Ignition (firmware 5.6) helpers shared by Power home, the dashboard, Car home and the output screens.
import { parseVersion, lacks, isUpstream } from '../../hardware/parts/util.js'

/** The module has the ignition block: fork firmware 5.6 or newer (an unknown version is not counted), or an upstream
 *  module whose param list has 0x1E00. */
export const has56 = (d) => (isUpstream(d) || !!parseVersion(d?.version)) && !lacks(d, [5, 6, 0], 0x1E00)

/** The module that runs the ignition (its Ignition block is on, role main), or null. */
export const ignitionMain = (devices) => devices.find((d) => d.ignition?.enabled && d.ignition.role === 'main') ?? null

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
