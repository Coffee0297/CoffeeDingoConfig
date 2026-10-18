// Sleep: one module (the master) keeps the car awake while any of its keep-awake signals is on and for a set time
// after, raises a pre-sleep signal x s before the end (a Pi halts on it; used again in that window, a wake pulse),
// then goes quiet. Every other module watches the master's own status frame: when it stops, they go quiet and sleep.
// Built from existing firmware blocks named "Sleep · …", so the configuration is the setup.
//
// Master (keepS, preS, pulseS = 0 held, wakeS = 0 none)        every other module
//   in use     = OR of the keep-awake signals (VI)               "Sleep · master quiet" CAN input: the master's status
//   awake      = off-delay keepS on in use                         frame, silent 2 s (timeout) = its mute input. 2 s: a
//                                                                  follower woken first (a door on it) keeps talking until
//                                                                  the master is awake and has heard it
//   pre start  = off-delay keepS-preS on in use                  "Sleep · go" = 2 s after that = its force-sleep input
//   window     = awake AND NOT pre start (VI)                      (no free timer: its own auto-sleep instead)
//   halt       = pulseS pulse at the window's start (if pulseS)
//   wake       = wakeS pulse when in use comes back in the window: (in use AND awake AND NOT pre start) rises
//   pre-sleep  = (halt or window) OR wake: wire it to the Pi's halt line
//   asleep     = NOT awake (VI) = its mute input: its frames stop, the others go
//   master off = 5 s after awake ends = its force-sleep input (the others are asleep by then: 2 s + 2 s)
// Virtual inputs update before timers each loop, so the wake term sees the timers of the loop before: it is true for one
// loop when the car is used again inside the window, never at a boot or outside the window (it would halt a running Pi).
import { api } from './store.js'

export const N = {
  inUse: 'Sleep · in use', awake: 'Sleep · awake', preStart: 'Sleep · pre-sleep start', window: 'Sleep · window', halt: 'Sleep · halt',
  wakeIf: 'Sleep · wake if', wake: 'Sleep · wake', pre: 'Sleep · pre-sleep', asleep: 'Sleep · asleep', off: 'Sleep · master off',
  quiet: 'Sleep · master quiet', go: 'Sleep · go',
}
// blocks of the earlier shut-down order and of the frame version of this setup: cleared when the sleep is set up
const OLD = { timers: ['Sleep · off delay', 'Sleep · quiet CAN', 'Sleep · hold outputs', 'Sleep · shutdown frame'], canOutputs: ['Sleep · shutdown frame'], canInputs: ['Sleep master'] }

const idx = (v, kind, n, prop = 'State') => v.find((x) => x.kind === kind && x.number === n && x.prop === prop)?.index ?? 0
const ours = (x) => x.enabled && x.name.startsWith('Sleep ·')

/** What the master needs: timers and virtual inputs, by name. */
function masterBlocks(plan) {
  const held = !plan.pulseS, wake = !!plan.wakeS
  return {
    timers: [N.awake, N.preStart, N.off, ...(held ? [] : [N.halt]), ...(wake ? [N.wake] : [])],
    vis: [...(plan.inputs.length > 1 ? [N.inUse] : []), N.asleep, N.window, ...(wake ? [N.wakeIf, N.pre] : [])],
  }
}

/** Slots one module needs that it does not have: '' when it fits. A follower's timer is optional (auto-sleep). */
export function shortfall(f, plan, isMaster) {
  const old = [...OLD.timers, ...OLD.canOutputs, ...OLD.canInputs]
  const free = (arr, names) => names.length - (arr ?? []).filter((x) => !x.enabled || ours(x) || old.includes(x.name)).length
  const short = []
  if (isMaster) {
    const b = masterBlocks(plan)
    const t = free(f.timers, b.timers), vi = free(f.virtualInputs, b.vis)
    if (t > 0) short.push(`${t} more timer${t === 1 ? '' : 's'}`)
    if (vi > 0) short.push(`${vi} more virtual input${vi === 1 ? '' : 's'}`)
  } else if (free(f.canInputs, [N.quiet]) > 0) short.push('a free CAN input')
  return short.join(' and ')
}

/** Take every "Sleep · …" block (and the earlier designs') off one module, and its force-sleep/mute if they pointed at them. */
export async function clearSleep(g, f, v) {
  const gone = new Set()
  const off = async (kind, arr, names) => {
    for (const x of arr ?? []) if (x.enabled && (ours(x) || names.includes(x.name))) {
      await api.setFunction(g, kind, x.number, { enabled: false })
      gone.add(idx(v, kind, x.number))
    }
  }
  await off('timer', f.timers, OLD.timers)
  await off('virtualinput', f.virtualInputs, [])
  await off('canoutput', f.canOutputs, OLD.canOutputs)
  await off('caninput', f.canInputs, OLD.canInputs)
  const d = f.device ?? {}
  const reset = {}
  if (d.forceSleepInput && gone.has(d.forceSleepInput)) reset.forceSleepInput = 0
  if (d.muteTxInput && gone.has(d.muteTxInput)) reset.muteTxInput = 0
  if (Object.keys(reset).length) await api.deviceInputs(g, reset)
}

/**
 * plan: { inputs: [var index on the master, up to 3], keepS, preS, pulseS (0 = held until sleep), wakeS (0 = none) }.
 * Assumes clearSleep ran on this module and shortfall said it fits.
 */
export async function compileMaster(g, f, v, plan) {
  const claimed = new Map()   // per kind: timer 4 and virtual input 4 are different slots
  const slot = (arr) => {
    const used = claimed.get(arr) ?? claimed.set(arr, new Set()).get(arr)
    const x = (arr ?? []).find((s) => !s.enabled && !used.has(s.number))
    used.add(x.number)
    return x.number
  }
  const timer = async (name, input, mode, edge, ms) => { const n = slot(f.timers); await api.setFunction(g, 'timer', n, { enabled: true, name, input, mode, edge, preset: Math.round(ms) }); return idx(v, 'timer', n) }
  // a virtual input needs two variables: a single one is used twice
  const vi = async (name, [a, na], [b, nb], cond, c) => {
    const n = slot(f.virtualInputs)
    await api.setFunction(g, 'virtualinput', n, { enabled: true, name, mode: 0, var0: a, not0: !!na, cond0: cond, var1: b, not1: !!nb, cond1: c ? c[2] : 0, var2: c ? c[0] : 0, not2: c ? !!c[1] : false })
    return idx(v, 'virtualinput', n)
  }
  const AND = 0, OR = 1
  const [a, b, c] = plan.inputs
  // timers come after the virtual inputs in slot order only by allocation; the loop order is what matters (see top)
  const inUse = plan.inputs.length > 1 ? await vi(N.inUse, [a], [b], OR, c ? [c, false, OR] : null) : a
  const awake = await timer(N.awake, inUse, 1, 0, plan.keepS * 1000)                         // off-delay
  const preStart = await timer(N.preStart, inUse, 1, 0, (plan.keepS - plan.preS) * 1000)
  const asleep = await vi(N.asleep, [awake, true], [awake, true], AND)
  const win = await vi(plan.wakeS || plan.pulseS ? N.window : N.pre, [awake], [preStart, true], AND)
  const halt = plan.pulseS ? await timer(plan.wakeS ? N.halt : N.pre, win, 2, 0, plan.pulseS * 1000) : win
  if (plan.wakeS) {
    const wakeIf = await vi(N.wakeIf, [inUse], [awake], AND, [preStart, true, AND])
    const wake = await timer(N.wake, wakeIf, 2, 0, plan.wakeS * 1000)
    await vi(N.pre, [halt], [wake], OR)
  }
  const off = await timer(N.off, awake, 0, 1, 5000)                                         // after the followers
  await api.deviceInputs(g, f.device?.canSleep === false ? { muteTxInput: asleep } : { forceSleepInput: off, muteTxInput: asleep })
}

/** A module that sleeps when the master goes quiet: muted 2 s after its status frame stops, asleep 2 s later.
 * Returns true when it has no timer for that and sleeps on its own auto-sleep instead. */
export async function compileFollower(g, f, v, master) {
  const c = (f.canInputs ?? []).find((x) => !x.enabled)
  // the master's first status frame (base + 2), sent all the time: the compare never matches real data (a byte is
  // never > 255), only the timeout value does, so the input is on exactly while the master is silent
  await api.setFunction(g, 'caninput', c.number, { enabled: true, name: N.quiet, id: master.baseId + 2, ide: false, startBit: 0, bitLength: 8, factor: 1, offset: 0, operator: 2, operand: 255, mode: 0, byteOrder: 0, signed: false, timeoutEnabled: true, timeout: 2000, timeoutValue: 256 })
  const s = idx(v, 'caninput', c.number)
  if (f.device?.canSleep === false) { await api.deviceInputs(g, { muteTxInput: s }); return false }
  const t = (f.timers ?? []).find((x) => !x.enabled)
  if (!t) { await api.deviceInputs(g, { forceSleepInput: 0, muteTxInput: s }); return true }
  await api.setFunction(g, 'timer', t.number, { enabled: true, name: N.go, input: s, mode: 0, edge: 0, preset: 2000 })
  await api.deviceInputs(g, { forceSleepInput: idx(v, 'timer', t.number), muteTxInput: s })
  return false
}

/** Read the setup back from one module's /functions: the master's plan, or that it follows. */
export function readSleep(f) {
  const on = (arr, name) => (arr ?? []).find((x) => x.enabled && x.name === name)
  const aw = on(f?.timers, N.awake)
  if (aw) {
    const ps = on(f?.timers, N.preStart), iu = on(f?.virtualInputs, N.inUse), wk = on(f?.timers, N.wake)
    const pulse = on(f?.timers, N.halt) ?? on(f?.timers, N.pre)
    const keepS = Math.round(aw.preset / 1000)
    return { master: true, keepS, preS: ps ? keepS - Math.round(ps.preset / 1000) : null, pulseS: pulse ? pulse.preset / 1000 : 0, wakeS: wk ? wk.preset / 1000 : 0, inputs: iu ? [iu.var0, iu.var1, iu.var2].filter(Boolean) : [aw.input] }
  }
  return { master: false, follows: !!on(f?.canInputs, N.quiet) }
}
