// Ignition (firmware 5.6) helpers shared by Power home, the dashboard, Car home and the output screens.
import { parseVersion, olderThan } from '../../hardware/parts/util.js'

/** The module reported firmware 5.6 or newer (an unknown version is not counted). */
export const has56 = (d) => !!parseVersion(d?.version) && !olderThan(d.version, [5, 6, 0])

/** The module that runs the ignition (its Ignition block is on, role main), or null. */
export const ignitionMain = (devices) => devices.find((d) => d.ignition?.enabled && d.ignition.role === 'main') ?? null

export const IGN_WORD = { off: 'Off', on: 'On', cranking: 'Cranking', running: 'Running' }

/** { value, sub } for a summary tile: the live state, or why there is none. */
export function ignitionTile(devices) {
  const m = ignitionMain(devices)
  if (m) return m.ignition.live ? { value: IGN_WORD[m.ignition.state] ?? m.ignition.state, sub: `from ${m.name}` } : { value: '—', sub: `${m.name} is not sending its state` }
  return devices.some(has56) ? { value: 'Not set up', sub: 'pick the switch and button' } : null
}
