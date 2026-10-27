// Device param (index 0) numbering of the sleep settings per firmware family. Pure: node-testable (sleepParams.test.js).
import { isUpstream, lacks } from '../../hardware/parts/util.js'

export const SUB = { enabled: 2, timeout: 5, ignoreAlwaysOn: 9, forceSleep: 10, muteTx: 11, wakeMask: 12, wakeCan: 13 }

/** Upstream module with feat/sleep-config: device sub 9 timeout, 10 ignore always-on, 11 per-pin wake mask (known after a Read). */
export const upSub = (d, sub) => isUpstream(d) && !lacks(d, [0, 0, 0], 0, sub)

/** The writes for one fork-numbered device setting on module d: [[sub, value], …]; [] = the module has no such setting.
 *  Upstream dingoFW numbers its device params differently and has bools where the fork has a wake mask; the timeout,
 *  ignore-always-on and per-pin mask only with feat/sleep-config (else 30 s fixed, all/no inputs wake). */
export function upstreamWrite(d, sub, value) {
  if (!isUpstream(d)) return [[sub, value]]
  switch (sub) {
    case SUB.enabled: return [[2, value]]
    case SUB.muteTx: return [[7, value]]
    case SUB.forceSleep: return [[8, value]]
    case SUB.wakeCan: return [[5, value ? 0 : 1]]   // bDisableCanWake
    // bDisableDigInWake stays the master switch: on with no input ticked, else off + the mask
    case SUB.wakeMask: return !upSub(d, 11) ? [[4, value ? 0 : 1]] : value ? [[4, 0], [11, value]] : [[4, 1]]
    case SUB.timeout: return upSub(d, 9) ? [[9, value]] : []
    case SUB.ignoreAlwaysOn: return upSub(d, 10) ? [[10, value]] : []
    default: return []
  }
}
