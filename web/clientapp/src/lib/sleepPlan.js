// Sleep: one module (the master) keeps the car awake while any of its keep-awake signals is on and for a set time
// after, raises a pre-sleep signal x s before the end (a Pi halts on it; used again in that window, a wake pulse),
// then goes quiet. Every other module watches the master's own status frame: when it stops, they go quiet too. Then
// each one sleeps on its own auto-sleep once the bus has been quiet for its sleep delay. Nothing forces a sleep: with
// another device still talking (an ECU on its own supply) a forced sleep was woken by its next frame, restarted, saw
// "not in use" and slept again, over and over; now the modules stay awake but silent until it stops.
// Built from existing firmware blocks named "Sleep · …", so the configuration is the setup.
//
// Master (keepS, preS, pulseS = 0 held, wakeS = 0 none)        every other module
//   in use     = OR of the keep-awake signals (VI)               "Sleep · master quiet" CAN input: the master's status
//   awake      = off-delay keepS on in use                         frame, silent 2 s (timeout) = its mute input. 2 s: a
//                                                                  follower woken first (a door on it) keeps talking until
//                                                                  the master is awake and has heard it
//   pre start  = off-delay keepS-preS on in use                  auto-sleep on, no force-sleep input
//   window     = awake AND NOT pre start (VI)
//   halt       = pulseS pulse at the window's start (if pulseS)
//   wake       = wakeS pulse when in use comes back in the window: (in use AND awake AND NOT pre start) rises
//   pre-sleep  = (halt or window) OR wake: wire it to the Pi's halt line
//   asleep     = NOT awake (VI) = its mute input: its frames stop, the others go quiet; auto-sleep on, no force-sleep
// Virtual inputs update before timers each loop, so the wake term sees the timers of the loop before: it is true for one
// loop when the car is used again inside the window, never at a boot or outside the window (it would halt a running Pi).
import { api, applyGraphConnection } from './store.js'

export const N = {
  inUse: 'Sleep · in use', awake: 'Sleep · awake', preStart: 'Sleep · pre-sleep start', window: 'Sleep · window', halt: 'Sleep · halt',
  wakeIf: 'Sleep · wake if', wake: 'Sleep · wake', pre: 'Sleep · pre-sleep', asleep: 'Sleep · asleep',
  quiet: 'Sleep · master quiet',
}
// blocks of the earlier shut-down order and of the frame version of this setup: cleared when the sleep is set up
const OLD = { timers: ['Sleep · off delay', 'Sleep · quiet CAN', 'Sleep · hold outputs', 'Sleep · shutdown frame'], canOutputs: ['Sleep · shutdown frame'], canInputs: ['Sleep master'] }

const idx = (v, kind, n, prop = 'State') => v.find((x) => x.kind === kind && x.number === n && x.prop === prop)?.index ?? 0
const ours = (x) => x.enabled && x.name.startsWith('Sleep ·')

/** What the master needs: timers and virtual inputs, by name. */
function masterBlocks(plan) {
  const held = !plan.pulseS, wake = !!plan.wakeS
  return {
    timers: [N.awake, N.preStart, ...(held ? [] : [N.halt]), ...(wake ? [N.wake] : [])],
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
  await api.deviceInputs(g, { forceSleepInput: 0, muteTxInput: asleep })
}

/** A module that goes quiet when the master does (its status frame silent 2 s), then sleeps on its own auto-sleep. */
export async function compileFollower(g, f, v, master) {
  const c = (f.canInputs ?? []).find((x) => !x.enabled)
  // the master's first status frame (base + 2), sent all the time: the compare never matches real data (a byte is
  // never > 255), only the timeout value does, so the input is on exactly while the master is silent
  await api.setFunction(g, 'caninput', c.number, { enabled: true, name: N.quiet, id: master.baseId + 2, ide: false, startBit: 0, bitLength: 8, factor: 1, offset: 0, operator: 2, operand: 255, mode: 0, byteOrder: 0, signed: false, timeoutEnabled: true, timeout: 2000, timeoutValue: 256 })
  const s = idx(v, 'caninput', c.number)
  // an output on the master's "Sleep · awake" over CAN would hold the last frame's 1 once the master goes quiet and
  // keep this module awake for good: read 0 when the master is silent
  for (const x of f.canInputs ?? [])
    if (x.enabled && x.name?.includes(' Sleep · ') && x.id >= master.baseId && x.id < master.baseId + 8 && !(x.timeoutEnabled && x.timeoutValue === 0))
      await api.setFunction(g, 'caninput', x.number, { ...x, timeoutEnabled: true, timeout: 2000, timeoutValue: 0 })
  await api.deviceInputs(g, f.device?.canSleep === false ? { muteTxInput: s } : { forceSleepInput: 0, muteTxInput: s })
}

/** The module's "Sleep · …" signals before a re-stage: var index -> name. */
export const sleepSignals = (v) => new Map(v.filter((x) => x.prop === 'State' && x.name.startsWith('Sleep ·')).map((x) => [x.index, x.name]))

/**
 * After a re-stage the blocks can sit in other slots (with the wake pulse on, "Sleep · pre-sleep" is a virtual input
 * instead of a timer), so whatever used a "Sleep · …" signal before now reads another block. Point it at the block of
 * the same name again; a halt or window signal that is gone is now "Sleep · pre-sleep".
 */
export async function repointSleep(g, before, devices) {
  if (!before.size) return
  const v = await api.inputs(g)
  const now = new Map(v.filter((x) => x.prop === 'State' && x.name.startsWith('Sleep ·')).map((x) => [x.name, x.index]))
  const to = (i) => { const n = before.get(i); return n == null ? null : now.get(n) ?? (/halt|window/.test(n) ? now.get(N.pre) : null) ?? null }
  const f = await api.functions(g)
  const dev = (devices ?? []).find((d) => d.guid === g)
  for (const o of dev?.outputs ?? []) { const t = to(o.inputVal); if (t && t !== o.inputVal) await applyGraphConnection(g, 'output:' + o.number, 'input', t, devices) }
  for (const o of f.digitalOut ?? []) { const t = to(o.input); if (t && t !== o.input) await api.setFunction(g, 'digitaloutput', o.number, { input: t }) }
  for (const [arr, kind] of [['canOutputs', 'canoutput'], ['timers', 'timer']])
    for (const x of f[arr] ?? []) { if (!x.enabled || x.name.startsWith('Sleep ·')) continue; const t = to(x.input); if (t && t !== x.input) await api.setFunction(g, kind, x.number, { input: t }) }
  for (const x of f.virtualInputs ?? []) {
    if (!x.enabled || x.name.startsWith('Sleep ·')) continue
    const ch = {}
    for (const k of ['var0', 'var1', 'var2']) { const t = to(x[k]); if (t && t !== x[k]) ch[k] = t }
    if (Object.keys(ch).length) await api.setFunction(g, 'virtualinput', x.number, ch)
  }
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
