<script>
  // Bench test strip (firmware ≥ 5.5.107, MsgCmd 48), shared by the PDM output editor and the CANBoard
  // digital-output editor. The module holds a forced state for `hold` seconds per command, so while a test
  // runs we re-send every 2 s and release on Stop / unmount — a dropped link or a crashed tab releases by
  // itself when the hold runs out. On a PDM the current limits and fault handling stay active on the module.
  import { api } from './store.js'
  import { toast } from './toast.js'
  // amps = null on a board without current sensing (CANBoard); duty is only shown while the output has a PWM frame.
  let { guid, number, connected = false, enabled = false, pwmEnabled = false, status = '', amps = null, duty = null } = $props()
  const HOLD_S = 5
  let testing = $state(false), pwm = $state(false), dutyPct = $state(50), freqHz = $state(100)
  let timer = null
  const mode = () => (pwm ? 'pwm' : 'on')
  const send = (m) => api.outputTest(guid, number, { mode: m, duty: Number(dutyPct) || 0, freq: Number(freqHz) || 0, hold: HOLD_S })
  async function start() {
    try {
      await send(mode())
      testing = true
      timer = setInterval(() => send(mode()).catch((e) => { toast('Test lost: ' + e.message, 'error'); stop() }), 2000)
    } catch (e) { toast('Test refused: ' + e.message, 'error') }
  }
  async function stop() {
    clearInterval(timer); timer = null
    if (!testing) return
    testing = false
    try { await send('off') } catch { toast(`Could not send the release — the module lets go by itself within ${HOLD_S} s`, 'error') }
  }
  // Duty/frequency edits during a PWM test apply at once (the 2 s re-send would pick them up anyway).
  const retune = () => { if (testing && pwm) send('pwm').catch(() => {}) }
  $effect(() => { if (!connected && testing) stop() })
  $effect(() => () => { if (testing) stop() })
</script>

<div class="testbox" role="group" aria-label="Test output">
  <b>⚡ Test</b>
  {#if !connected}
    <span class="hint">Connect the module to force this output on / PWM for a wiring check.</span>
  {:else if !enabled}
    <span class="hint">Enable the output{amps != null ? ', set its current limit' : ''} and Save first — the test only runs on an enabled output{amps != null ? ', under that protection' : ''}.</span>
  {:else}
    <label><input type="checkbox" bind:checked={pwm} disabled={testing} /> PWM</label>
    {#if pwm}
      <label>duty <input class="in" type="number" min="0" max="100" step="1" bind:value={dutyPct} onchange={retune} style="width:64px" /> %</label>
      <label>freq <input class="in" type="number" min="15" max="400" step="1" bind:value={freqHz} onchange={retune} style="width:72px" /> Hz</label>
    {/if}
    {#if testing}
      <button class="btn primary" onclick={stop}>■ Stop</button>
      <span class="live">now <b>{status}</b>{#if amps != null} · <b>{Number(amps).toFixed(1)} A</b>{/if}{#if pwm && pwmEnabled} · <b>{duty ?? 0}%</b>{/if}</span>
    {:else}
      <button class="btn" onclick={start}>{pwm ? `Run PWM ${Number(dutyPct) || 0}%` : 'Turn ON'}</button>
      <span class="hint">Ignores the rule while it runs; releases on Stop, on close, or by itself {HOLD_S} s after the link drops.</span>
    {/if}
  {/if}
</div>

<style>
  .testbox { display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; margin:0 0 6px; padding:8px 12px; border:1px dashed var(--line-2); border-radius:8px; font-size:13px }
  .testbox label { display:inline-flex; align-items:center; gap:5px; color:var(--muted) }
  .testbox .hint { margin:0; color:var(--muted) }
  .testbox .live { color:var(--muted) }
  .testbox .live b { color:var(--ink) }
</style>
