<script>
  // Sim replay tab (board H29, tab 2): load a recorded CAN log and replay it onto the simulated bus.
  // Only works while the Sim adapter is the active connection.
  import { onMount } from 'svelte'
  import { Card, Button, Banner, Switch, Meter, LineChart, Field, StateDot } from '../../../ui/index.js'
  import { live, api, toast } from '../../../lib/live.svelte.js'
  import { ui } from '../../../shell/ui.svelte.js'

  const simOn = $derived(live.connected && live.adapter === 'Sim')
  let st = $state(null)
  let loadErr = $state('')
  let busy = $state(false)
  let fileErr = $state('')
  let fileName = $state('')
  let fps = $state(1000)
  let rates = $state([])

  async function poll() {
    try { st = await api.simStatus(); loadErr = '' } catch (e) { loadErr = e.message }
  }
  onMount(() => {
    poll()
    const a = setInterval(() => { if (simOn) poll() }, 500)
    const b = setInterval(() => { rates = [...rates, live.canRate ?? 0].slice(-120) }, 500)
    return () => { clearInterval(a); clearInterval(b) }
  })
  let lastFps = 0 // copy the module's speed into the box only when it changes, so typing is not overwritten by each poll
  $effect(() => { const v = st?.fps; if (v && v !== lastFps) { lastFps = v; fps = v } })

  const hasLog = $derived(!!st && (st.total ?? 0) > 0)
  const can = $derived(simOn && hasLog)
  const playing = $derived(st?.state === 'Playing')
  const mmss = (ms) => { const s = Math.floor((ms ?? 0) / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') }
  const stateText = $derived(!simOn ? 'Not on the Sim adapter' : !hasLog ? 'No log loaded' : playing ? `Playing · ${mmss(st.timeMs)}` : st.state === 'Paused' ? `Paused at ${mmss(st.timeMs)}` : st.state === 'Idle' ? 'Ready at the start' : `${st.state} at ${mmss(st.timeMs)}`)

  async function act(fn, ok) {
    try { await fn(); await poll(); if (ok) toast(ok, 'info', 2000) } catch (e) { toast(e.message, 'error', 6000) }
  }
  async function onFile(e) {
    const f = e.target.files?.[0]; e.target.value = ''
    if (!f) return
    busy = true; fileErr = ''
    try { const r = await api.simLoad(f); fileName = f.name; await poll(); toast(`Loaded ${r.total.toLocaleString('en-US')} frames from ${f.name}.`, 'info', 3500) }
    catch (err) { fileErr = `Could not read ${f.name}. ${err.message}`; fileName = '' } finally { busy = false }
  }
  const rateOk = $derived(Number.isInteger(+fps) && +fps >= 1 && +fps <= 100000)
</script>

{#if !simOn}
  <Banner tone="info" title="Replay needs the Sim adapter." data-testid="sim-banner">
    {live.connected ? `You are on ${live.adapter ?? 'a real adapter'} with the car's modules. Replaying a log into a real bus is not possible.` : 'You are not connected. Connect with the Sim adapter to load and replay a log.'}
    {#snippet actions()}<Button onclick={() => (ui.panel = 'connect')}>Open Connect</Button>{/snippet}
  </Banner>
{:else}
  <Banner tone="warn" title="Sim adapter active.">Programming is off while the Sim adapter is active. Replay only feeds frames onto the simulated bus.</Banner>
{/if}
{#if fileErr}<Banner tone="fault" title="The log was not loaded." data-testid="sim-file-error">{fileErr} A line in the file must be: time, Rx or Tx, id in hex, length, up to 8 data bytes.</Banner>{/if}
{#if loadErr}<Banner tone="fault" title="Could not read the replay status.">{loadErr}</Banner>{/if}

<div class="cols">
  <Card title="Log" subtitle="A CAN log saved by dingoConfig (CSV)">
    <div class="stat" role="status" data-testid="sim-status">
      <StateDot tone={playing ? 'on' : hasLog && simOn ? 'accent' : 'stale'} shape={playing ? 'dot' : 'ring'} label={stateText} />
    </div>
    <dl>
      <dt>File</dt><dd data-testid="sim-file">{st?.fileName ?? (fileName || 'none')}</dd>
      <dt>Frames</dt><dd class="mono" data-testid="sim-frames">{(st?.total ?? 0).toLocaleString('en-US')}</dd>
      <dt>Position</dt><dd class="mono">{(st?.current ?? 0).toLocaleString('en-US')} of {(st?.total ?? 0).toLocaleString('en-US')}</dd>
    </dl>
    <label class="fbtn" class:dis={!simOn || busy}>{busy ? 'Reading…' : 'Load a log…'}<input type="file" accept=".csv,text/csv" class="sr-only" onchange={onFile} disabled={!simOn || busy} data-testid="sim-file-input" /></label>
    {#if hasLog}<Meter label="Replay position" value={st.current} max={st.total} />{/if}
  </Card>

  <Card title="Controls">
    <div class="row">
      <Button variant="primary" onclick={() => act(playing ? api.simPause : api.simPlay)} disabled={!can} title={!simOn ? 'Needs the Sim adapter.' : !hasLog ? 'Load a log first.' : ''} data-testid="sim-play">{playing ? 'Pause' : 'Play'}</Button>
      <Button onclick={() => act(api.simReset, 'Back to the start.')} disabled={!can} data-testid="sim-reset">Reset to start</Button>
    </div>
    <Switch checked={!!st?.loop} label="Loop" hint="Start again when the log ends" disabled={!can} onchange={(v) => act(() => api.simLoop(v))} data-testid="sim-loop" />
    {#if st?.syntheticTiming}
      <div class="row end">
        <Field label="Speed" type="number" bind:value={fps} min="1" max="100000" unit="frames per second" disabled={!can} error={rateOk ? '' : 'Use a whole number from 1 to 100000.'} data-testid="sim-rate" />
        <Button onclick={() => act(() => api.simRate(+fps), `Speed is now ${fps} frames per second.`)} disabled={!can || !rateOk} data-testid="sim-rate-set">Set speed</Button>
      </div>
    {:else}
      <p class="muted" data-testid="sim-rate-note">{hasLog ? 'This log has real timestamps, so it plays at the recorded speed.' : 'Speed can be set for logs without timestamps once a log is loaded.'}</p>
    {/if}
  </Card>
</div>

<Card title="Bus activity" subtitle="Frames per second the app sees">
  <LineChart series={[{ label: 'Frames per second', values: rates, color: 'var(--color-series-1)', area: true }]} min={0} height={140} label={`Bus activity: ${Math.round(live.canRate ?? 0)} frames per second now.`} />
</Card>

<style>
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: var(--space-4); align-items: start; }
  .stat { font-size: var(--text-md); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px var(--space-3); margin: 0; }
  dt { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: 600; }
  dd { margin: 0; word-break: break-all; }
  .row { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: center; }
  .row.end { align-items: flex-end; }
  .fbtn { align-self: flex-start; display: inline-flex; align-items: center; min-height: var(--target-min); padding: 0 var(--space-4); border: 1px solid var(--color-line-strong); border-radius: var(--radius-md); font-weight: 600; cursor: pointer; background: var(--color-surface); }
  .fbtn:focus-within { outline: 3px solid var(--color-focus); outline-offset: 2px; }
  .fbtn.dis { opacity: 0.5; cursor: not-allowed; }
</style>
