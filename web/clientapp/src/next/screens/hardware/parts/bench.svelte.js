// Bench test of one output: POST /devices/{guid}/output/{n}/test { mode: 'on'|'pwm'|'off', duty, freq, hold }.
// The module stores the hold time (1-30 s) when the test starts and lets go by itself, so the output goes
// off even if this page, the laptop or the cable fails. We send the command once, count down on our own
// clock, and send "off" on Stop now, on leaving the page, and when the countdown ends.
import { api, toast } from '../../../lib/live.svelte.js'

export function createBench(ctx) {
  // phase: idle | running | lost | ended | refused
  const b = $state({ phase: 'idle', mode: 'on', hold: 5, duty: 50, freq: 100, startedAt: 0, now: 0, samples: [], peak: 0, error: '', busy: false, lostAt: 0, endNote: '' })
  let timer = null

  const holdS = () => Math.max(1, Math.min(30, Math.round(Number(b.hold) || 5)))
  const body = (mode) => ({ mode, duty: Math.max(0, Math.min(100, Number(b.duty) || 0)), freq: Math.max(15, Math.min(400, Number(b.freq) || 100)), hold: holdS() })

  function stopTimer() { if (timer) { clearInterval(timer); timer = null } }

  function tick() {
    b.now = Date.now()
    const el = (b.now - b.startedAt) / 1000
    if (b.phase === 'running') {
      const a = Number(ctx.current()) || 0
      b.samples.push(a)
      if (a > b.peak) b.peak = a
      if (!ctx.connected()) { b.phase = 'lost'; b.lostAt = el; return }
    }
    if (el >= holdS()) {
      const was = b.phase
      stopTimer()
      b.phase = 'ended'
      b.endNote = was === 'lost'
        ? 'The link dropped during the test. The module turns the output off by itself; reconnect to confirm it is off.'
        : 'The test ran its full time and the module turned the output off.'
      if (was === 'running') api.outputTest(ctx.guid(), ctx.n(), body('off')).catch(() => {})
    }
  }

  return {
    state: b,
    holdS,
    elapsed: () => Math.max(0, (b.now - b.startedAt) / 1000),
    remaining: () => Math.max(0, holdS() - (b.now - b.startedAt) / 1000),
    async start() {
      if (b.busy || b.phase === 'running' || b.phase === 'lost') return
      b.busy = true; b.error = ''
      try {
        await api.outputTest(ctx.guid(), ctx.n(), body(b.mode))
        b.samples = []; b.peak = 0; b.endNote = ''
        b.startedAt = Date.now(); b.now = b.startedAt; b.phase = 'running'
        stopTimer(); timer = setInterval(tick, 100)
      } catch (e) {
        b.phase = 'refused'; b.error = e?.message ?? String(e)
        toast('Test refused: ' + b.error, 'error', 8000)
      } finally { b.busy = false }
    },
    async stop() {
      if (b.phase !== 'running') return
      stopTimer()
      b.phase = 'ended'
      try {
        await api.outputTest(ctx.guid(), ctx.n(), body('off'))
        b.endNote = 'Stopped. The output is off.'
      } catch (e) {
        b.endNote = 'Could not send the stop. The module turns the output off by itself when its timer ends.'
        toast('Could not send the stop: ' + (e?.message ?? e), 'error', 8000)
      }
    },
    /** Duty / frequency edits while a PWM test runs take effect at once. */
    retune() { if (b.phase === 'running' && b.mode === 'pwm') api.outputTest(ctx.guid(), ctx.n(), body('pwm')).catch(() => {}) },
    reset() { if (b.phase === 'ended' || b.phase === 'refused') { b.phase = 'idle'; b.error = '' } },
    /** Called when the screen goes away: release the output if a test is running. */
    dispose() {
      stopTimer()
      if (b.phase === 'running') api.outputTest(ctx.guid(), ctx.n(), body('off')).catch(() => {})
    },
  }
}
