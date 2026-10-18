// Compiles a module's shutdown & sleep sequence onto existing firmware primitives (timers named "Sleep · …",
// force-sleep / mute-TX device inputs, the shutdown CAN frame, a follower's CAN input). Shared by the old
// designer (SleepSequence.svelte) and the new UI's Power page.
import { api, applyGraphConnection } from './store.js'

export const N_SLEEP = 'Sleep · off delay', N_QUIET = 'Sleep · quiet CAN', N_HOLD = 'Sleep · hold outputs', N_FRAME = 'Sleep · shutdown frame', N_MASTER = 'Sleep master'
export const tIdx = (n, v) => v.find((x) => x.kind === 'timer' && x.number === n)?.index ?? 0
export const ciIdx = (n, v) => v.find((x) => x.kind === 'caninput' && x.number === n && x.prop === 'State')?.index ?? 0
async function wireOutput(g, n, idx, cb, devs) {
  if (cb) await api.setFunction(g, 'digitaloutput', n, { enabled: true, input: idx })
  else await applyGraphConnection(g, 'output:' + n, 'input', idx, devs)
}

/**
 * What compileSequence would need on one module that it does not have: '' when it fits, else e.g. "1 more timer". Checked
 * for every module before any is changed (a missing slot found half-way left the car half on the new order).
 */
export function sequenceShortfall(f, cb, p) {
  const T = f.timers ?? [], CO = f.canOutputs ?? [], CI = f.canInputs ?? []
  const has = (arr, name) => arr.some((x) => x.enabled && x.name === name)
  const canSleep = f?.device?.canSleep ?? !cb
  const atFrame = p.role === 'follower' && p.quietOn && !p.quietS   // mutes on the frame's CAN input itself
  const names = [canSleep && !(p.role === 'follower' && p.autoSleep && !T.some((x) => !x.enabled) && !has(T, N_SLEEP)) && N_SLEEP, p.quietOn && !atFrame && N_QUIET, p.role !== 'follower' && p.holdOn && p.held?.length && N_HOLD, p.role === 'master' && N_FRAME].filter(Boolean)
  const short = []
  const t = names.filter((n) => !has(T, n)).length - T.filter((x) => !x.enabled).length
  if (t > 0) short.push(`${t} more timer${t === 1 ? '' : 's'}`)
  if (p.role === 'follower' && !has(CI, N_MASTER) && !CI.some((x) => !x.enabled)) short.push('a free CAN input')
  if (p.role === 'master' && !has(CO, N_FRAME) && !CO.some((x) => !x.enabled)) short.push('a free CAN output')
  return short.join(' and ')
}

/** One module: g guid, f its /functions, v its full var map, o its outputs [{number, inputIdx}], cb CANBoard?, p the plan. */
export async function compileSequence(g, f, v, o, cb, p, devices) {
  const T = f.timers ?? [], CO = f.canOutputs ?? [], CI = f.canInputs ?? []
  const claimed = new Set()
  const slot = (arr, name) => arr.find((t) => t.enabled && t.name === name) ?? arr.find((t) => !t.enabled && !claimed.has(t.number))
  const timer = (name) => { const t = slot(T, name); if (!t) throw new Error(`no free timer slot on ${p.name}`); claimed.add(t.number); return t.number }
  let trig = p.ign, edge = 1   // ignition: active while the input is OFF (falling edge)
  if (p.role === 'follower') {
    const c = slot(CI, N_MASTER); if (!c) throw new Error(`no free CAN input slot on ${p.name}`)
    await api.setFunction(g, 'caninput', c.number, { enabled: true, name: N_MASTER, id: p.frameId, startBit: 0, bitLength: 8, factor: 1, offset: 0, operator: 0, operand: 1, mode: 0, byteOrder: 0, signed: false, timeoutEnabled: false })   // reset a recycled slot fully
    trig = ciIdx(c.number, v); edge = 0   // active while the frame says 1
    if (!trig) throw new Error(`CAN input ${c.number} has no var-map entry on ${p.name}`)
  } else {
    const c = CI.find((x) => x.enabled && x.name === N_MASTER); if (c) await api.setFunction(g, 'caninput', c.number, { enabled: false })
  }
  // A CANBoard sleeps from firmware 5.5.111 (f.device.canSleep); an older one only goes quiet on CAN when the master says so.
  const canSleep = f?.device?.canSleep ?? !cb
  let nS = 0
  // a follower with no free timer and its own auto-sleep: quiet at the frame, then sleeps once the bus is quiet
  const autoOnly = canSleep && p.role === 'follower' && p.autoSleep && !slot(T, N_SLEEP)
  if (canSleep && !autoOnly) { nS = timer(N_SLEEP); await api.setFunction(g, 'timer', nS, { enabled: true, name: N_SLEEP, input: trig, edge, mode: 0, preset: Math.round(p.sleepS * 1000) }) }
  else { const t = T.find((x) => x.enabled && x.name === N_SLEEP); if (t) await api.setFunction(g, 'timer', t.number, { enabled: false }) }
  let mute = 0
  const tQ = T.find((t) => t.enabled && t.name === N_QUIET)
  if (p.role === 'follower' && p.quietOn && !p.quietS) { mute = trig; if (tQ) await api.setFunction(g, 'timer', tQ.number, { enabled: false }) }   // quiet the moment the frame says so: no timer
  else if (p.quietOn) { const nQ = timer(N_QUIET); await api.setFunction(g, 'timer', nQ, { enabled: true, name: N_QUIET, input: trig, edge, mode: 0, preset: Math.round(p.quietS * 1000) }); mute = tIdx(nQ, v) }
  else if (tQ) await api.setFunction(g, 'timer', tQ.number, { enabled: false })
  // Hold = off-delay on the ignition itself; the held outputs are re-pointed at the timer (and back when un-held).
  const tH = T.find((t) => t.enabled && t.name === N_HOLD); const hOld = tH ? tIdx(tH.number, v) : 0
  if (p.role !== 'follower' && p.holdOn && p.held.length) {
    const nH = timer(N_HOLD)
    await api.setFunction(g, 'timer', nH, { enabled: true, name: N_HOLD, input: trig, edge: 0, mode: 1, preset: Math.round(p.holdS * 1000) })
    const hi = tIdx(nH, v)
    for (const x of o) {
      const want = p.held.includes(x.number) ? hi : (hOld && x.inputIdx === hOld ? trig : null)
      if (want != null && want !== x.inputIdx) await wireOutput(g, x.number, want, cb, devices)
    }
  } else if (tH) {
    for (const x of o) if (hOld && x.inputIdx === hOld) await wireOutput(g, x.number, trig, cb, devices)
    await api.setFunction(g, 'timer', tH.number, { enabled: false })
  }
  // Shutdown frame: master only. Byte 0 = 1 once the ignition has been off for the grace time.
  const co = CO.find((c) => c.enabled && c.name === N_FRAME), tF = T.find((t) => t.enabled && t.name === N_FRAME)
  if (p.role === 'master') {
    const nF = timer(N_FRAME)
    await api.setFunction(g, 'timer', nF, { enabled: true, name: N_FRAME, input: trig, edge, mode: 0, preset: Math.round(p.frameS * 1000) })
    const c = co ?? CO.find((x) => !x.enabled); if (!c) throw new Error(`no free CAN output slot on ${p.name}`)
    await api.setFunction(g, 'canoutput', c.number, { enabled: true, name: N_FRAME, id: p.frameId, input: tIdx(nF, v), startBit: 0, bitLength: 8, factor: 1, offset: 0, byteOrder: 0, signed: false, interval: 100 })
  } else {
    if (co) await api.setFunction(g, 'canoutput', co.number, { enabled: false })
    if (tF) await api.setFunction(g, 'timer', tF.number, { enabled: false })
  }
  const force = canSleep && nS ? tIdx(nS, v) : 0
  await api.deviceInputs(g, canSleep ? { forceSleepInput: force, muteTxInput: mute } : { muteTxInput: mute })
  return { forceSleep: force, muteTx: mute, autoOnly }
}
