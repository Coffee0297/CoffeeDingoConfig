<script>
  // Record the bus to a file, or play a recorded file back through the live views as if the car were connected
  // (the Sim adapter feeds the frames through the same decode path; programming is off while it plays).
  // The file is the app's CAN-log CSV (Logs > CAN traffic records the same file; SavvyCAN logs also play).
  // shortcut: playback decodes with the open project's modules, so their base IDs must match the recording.
  import { Button, Banner, Dialog } from '../../../ui/index.js'
  import { live, api, toast } from '../../../lib/live.svelte.js'

  const isSim = $derived(live.connected && /^sim$/i.test(live.adapter ?? ''))
  let rec = $state(null), pb = $state(null), busy = $state(false), ask = $state(null)

  async function poll() {
    try { rec = await api.canRecStatus() } catch { /* unknown */ }
    try { pb = isSim ? await api.simStatus() : null } catch { pb = null }
  }
  $effect(() => { void isSim; poll(); const id = setInterval(poll, 1000); return () => clearInterval(id) })

  async function run(fn) { busy = true; try { await fn() } catch (e) { toast(e?.message ?? String(e), 'error', 8000) } finally { busy = false; await poll() } }
  const toggleRec = () => run(async () => {
    if (rec?.recording) { const r = await api.canRecStop(); toast(`Recording stopped: ${r.frames.toLocaleString('en-US')} frames. Download it to keep it.`, 'info', 4000) }
    else await api.canRecStart()
  })

  // A real connection is closed first, so ask; the car's connection stays remembered for Stop playback.
  function pick(e) { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; if (live.connected && !isSim) ask = f; else play(f) }
  const play = (f) => run(async () => {
    ask = null
    if (rec?.recording) await api.canRecStop()
    if (!isSim) {
      if (live.connected) await api.disconnect()
      const c = await api.connect('Sim', '', '500K')
      if (!c?.ok) throw new Error(c?.error ?? 'The playback adapter did not open.')
    }
    const r = await api.simLoad(f)
    await api.simPlay()
    toast(`Playing ${f.name}: ${r.total.toLocaleString('en-US')} frames.`, 'info', 3500)
  })
  const stop = () => run(async () => {
    const last = (await api.adapters().catch(() => null))?.last
    await api.disconnect()
    if (last?.adapter && last.adapter !== 'Sim') {
      const c = await api.connect(last.adapter, last.port ?? '', last.bitrate ?? '500K').catch(() => null)
      toast(c?.ok ? `Playback stopped. Connected to the car again through ${last.adapter}.` : `Playback stopped. Could not reconnect through ${last.adapter}: open Connect.`, c?.ok ? 'info' : 'error', 5000)
    } else toast('Playback stopped.', 'info', 3000)
  })

  const mmss = (ms) => { const s = Math.floor((ms ?? 0) / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') }
  const playing = $derived(pb?.state === 'Playing')
  const loaded = $derived(isSim && (pb?.total ?? 0) > 0)
  const hasFile = $derived(!!rec && rec.frames > 0 && !!rec.fileName)
</script>

{#if isSim}
  <Banner tone="warn" title={loaded ? `PLAYBACK · read-only · ${pb.fileName ?? 'log'}` : 'PLAYBACK · read-only · no log loaded'} data-testid="playback-banner">
    <span role="status" data-testid="playback-status">{loaded
      ? `${playing ? 'Playing' : pb.state === 'Stopped' ? 'Ended' : 'Paused'} at ${mmss(pb.timeMs)}, frame ${pb.current.toLocaleString('en-US')} of ${pb.total.toLocaleString('en-US')}.`
      : 'Choose a log to play.'} The values below come from the file, not the car. Nothing can be written to modules.</span>
    {#snippet actions()}
      {#if loaded}<Button size="sm" busy={busy} onclick={() => run(playing ? api.simPause : api.simPlay)} data-testid="playback-toggle">{playing ? 'Pause' : 'Play'}</Button>
        <Button size="sm" disabled={busy} onclick={() => run(api.simReset)}>Back to start</Button>{/if}
      <label class="fbtn" class:dis={busy}>Play another log…<input type="file" accept=".csv,text/csv" class="sr-only" onchange={pick} disabled={busy} /></label>
      <Button size="sm" variant="danger" disabled={busy} onclick={stop} data-testid="playback-stop">Stop playback</Button>
    {/snippet}
  </Banner>
{:else}
  <section class="bar" aria-label="Record or play a log">
    <Button size="sm" variant={rec?.recording ? 'danger' : 'secondary'} busy={busy} disabled={!rec?.recording && !live.connected} onclick={toggleRec}
      title={live.connected ? 'Records every frame on the bus to a file you can play back here.' : 'Connect a CAN adapter to record.'} data-testid="live-rec">{rec?.recording ? '■ Stop recording' : '● Record'}</Button>
    <span role="status" class="muted" data-testid="live-rec-status">{rec?.recording ? `Recording ${mmss(rec.sinceMs)} · ${rec.frames.toLocaleString('en-US')} frames` : hasFile ? `Recorded ${rec.frames.toLocaleString('en-US')} frames` : ''}</span>
    {#if hasFile}<Button size="sm" href="/api/canlog/record/download" download data-testid="live-rec-dl">Download log</Button>{/if}
    <label class="fbtn" class:dis={busy}>Play a log…<input type="file" accept=".csv,text/csv" class="sr-only" onchange={pick} disabled={busy} data-testid="live-play-file" /></label>
  </section>
{/if}

<Dialog open={!!ask} title="Play a log instead of the car?" onclose={() => (ask = null)}>
  <p>Playing <strong>{ask?.name}</strong> closes the connection to the car. The live views then show the file, and nothing can be written to modules until you press Stop playback, which connects to the car again.</p>
  {#snippet footer()}
    <Button onclick={() => (ask = null)}>Cancel</Button>
    <Button variant="primary" onclick={() => play(ask)} data-testid="live-play-confirm">Disconnect and play</Button>
  {/snippet}
</Dialog>

<style>
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
  .fbtn { display: inline-flex; align-items: center; min-height: 36px; padding: 0 var(--space-3); border: 1px solid var(--color-line-strong); border-radius: var(--radius-md); font-weight: 600; cursor: pointer; background: var(--color-surface); }
  .fbtn:focus-within { outline: 3px solid var(--color-focus); outline-offset: 2px; }
  .fbtn.dis { opacity: 0.5; cursor: not-allowed; }
</style>
