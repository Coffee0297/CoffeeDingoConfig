<script>
  // Digital input (H18): switch or PWM measurement, pull, debounce, invert, live level and a press test.
  import { untrack } from 'svelte'
  import { Page, PageHeader, Card, Button, Chip, StateDot, Banner, Segmented, Switch, Stepper, Field, Checkbox, LineChart, Empty } from '../../../ui/index.js'
  import { live, moduleState, isCanboard } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import { pinFor, ioTag } from '../../../../lib/pinmap.js'
  import { inputModel } from './input.svelte.js'
  import { signalFeed, ring } from './feeds.svelte.js'
  import { resample, has, isUpstream } from './util.js'
  import SaveBar from './SaveBar.svelte'
  import UsedBy from './UsedBy.svelte'

  let { guid, n } = $props()
  const M = inputModel(() => guid, () => 'input', () => n)
  const dev = $derived(M.dev)
  const row = $derived(M.row)
  const feed = signalFeed(() => guid, 200)

  // ---- form ----
  let f = $state(null), snap = $state('')
  const seed = (r) => ({ name: r.name ?? '', enabled: !!r.enabled, pwm: !!r.pwm, mode: r.mode ?? 0, pull: r.pull ?? 0, debounceTime: r.debounceTime ?? 20, invert: !!r.invert, pwmFreq: r.pwmFreq ?? 0, pwmMinPulseUs: r.pwmMinPulseUs ?? 0 })
  $effect(() => { if (!f && row) { f = seed(row); snap = JSON.stringify(f) } })
  const dirty = $derived(!!f && JSON.stringify(f) !== snap)
  function revert() { if (row) { f = seed(row); snap = JSON.stringify(f); M.state.saveErr = '' } }

  const pwmIn = $derived(isCanboard(dev)
    ? { board: 'CANBoard', maxHz: 5000, text: 'A 10 kΩ series resistor and no filter capacitor, so up to about 5 kHz. Nothing filters noise on a long wire: a glitch filter of 20 to 50 µs is a good start.' }
    : { board: 'dingoPDM', maxHz: 1000, text: 'A 4.7 kΩ and 10 nF filter, so up to about 1 kHz from a driven source and about 100 Hz from an open-collector one. The filter already removes short spikes.' })
  // upstream dingoFW: PWM measurement only where the module has 0x1200 sub 5 (feat/digital-input-pwm; the CANBoard from 5.7)
  const pwmOk = $derived(has(dev, 0x1200, 5))
  const problem = $derived.by(() => {
    if (!f || !dirty) return ''
    if (!String(f.name).trim()) return 'Give the input a name.'
    if (f.pwm && (Number(f.pwmFreq) < 0 || Number(f.pwmFreq) > pwmIn.maxHz)) return `Expected frequency must be 0 to ${pwmIn.maxHz} Hz.`
    return ''
  })
  async function save() {
    const body = { name: String(f.name).trim(), enabled: f.enabled, pwm: f.pwm, mode: Number(f.mode), pull: Number(f.pull), debounceTime: Math.max(0, Math.round(Number(f.debounceTime) || 0)),
      invert: f.invert, pwmFreq: Math.max(0, Math.min(pwmIn.maxHz, Math.round(Number(f.pwmFreq) || 0))), pwmMinPulseUs: Math.max(0, Math.min(10000, Math.round(Number(f.pwmMinPulseUs) || 0))) }
    if (await M.save(body)) snap = JSON.stringify(f)
  }

  // ---- live level (last 10 s) ----
  const sig = $derived(row ? feed.get('Digital input', row.name) : undefined)
  const hist = ring(10_000)
  let tick = $state(0), lastChange = $state(0), prev = null
  $effect(() => {
    feed.ts
    const s = untrack(() => sig)
    if (!s || !untrack(() => M.connected)) return
    untrack(() => {
      const v = s.on ? 1 : 0
      if (prev !== null && prev !== v) lastChange = Date.now()
      prev = v
      hist.push(v)
      tick++
    })
  })
  const series = $derived.by(() => { tick; return resample(hist.samples(), 10_000, 100) })
  const edges = $derived.by(() => { tick; const s = hist.samples(); let c = 0; for (let i = 1; i < s.length; i++) if (s[i].v !== s[i - 1].v) c++; return c })
  let now = $state(Date.now())
  $effect(() => { const id = setInterval(() => (now = Date.now()), 500); return () => clearInterval(id) })
  const ago = $derived(lastChange ? Math.max(0, (now - lastChange) / 1000) : null)

  // ---- press test ----
  let test = $state({ phase: 'idle', start: 0, base: false, left: 10, at: 0 })
  let timer = null
  function stopTimer() { if (timer) { clearInterval(timer); timer = null } }
  function startTest() {
    stopTimer()
    test = { phase: 'waiting', start: Date.now(), base: !!sig?.on, left: 10, at: 0 }
    timer = setInterval(() => {
      const left = Math.max(0, 10 - (Date.now() - test.start) / 1000)
      test.left = Math.ceil(left)
      if (left <= 0) { stopTimer(); test.phase = 'none' }
    }, 250)
  }
  function stopTest() { stopTimer(); test.phase = 'idle' }
  $effect(() => {
    feed.ts
    untrack(() => {
      if (test.phase === 'waiting' && sig && !!sig.on !== test.base) { stopTimer(); test.at = (Date.now() - test.start) / 1000; test.phase = 'seen'; lastChange = Date.now() }   // the change the test saw is the last change too
    })
  })
  $effect(() => () => stopTimer())

  const ioText = $derived(dev ? ioTag(dev, 'input', n) : '')
  const pin = $derived(dev ? pinFor(dev, 'input', n) : null)
  const online = $derived(M.connected)
  const state = $derived.by(() => {
    if (!live.connected) return { t: 'No connection', tone: 'stale', shape: 'ring' }
    if (!dev?.connected) return { t: 'Module offline', tone: 'stale', shape: 'square' }
    if (!row?.enabled) return { t: 'Not in use', tone: 'off', shape: 'ring' }
    if (!sig) return { t: 'Reading…', tone: 'stale', shape: 'ring' }
    return sig.on ? { t: 'ON · ' + (f?.mode === 1 ? 'latched on' : 'pressed'), tone: 'on', shape: 'dot' } : { t: 'OFF', tone: 'off', shape: 'ring' }
  })
  const PULL = [{ value: '1', label: 'Pull-up' }, { value: '2', label: 'Pull-down' }, { value: '0', label: 'None' }]
  const pullHint = { 1: 'The pin reads high until the switch pulls it to ground. Normal for a switch to ground.', 2: 'The pin reads low until the switch connects it to 12 V.', 0: 'No resistor. Use only when the sender drives the pin both ways.' }
  let useVal = $state('switch'), typeVal = $state('0'), pullVal = $state('0')
  $effect(() => { if (f) { useVal = f.pwm ? 'pwm' : 'switch'; typeVal = String(f.mode); pullVal = String(f.pull) } })
  const label = $derived(f?.name?.trim() || `Digital input ${n}`)
</script>

<Page>
  {#if !M.state.loaded}
    <p class="muted" role="status">Reading the input…</p>
  {:else if M.state.err && !row}
    <Banner tone="fault" title="Could not read this module">{M.state.err}</Banner>
  {:else if !row}
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: dev.name, href: href('hardware', 'module', guid) }, { label: `Digital ${n}` }]} title={`${dev.name} has no digital input ${n}`} />
    <Empty title="No such input" text="Check the number in the address." />
  {:else if f}
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: dev.name, href: href('hardware', 'module', guid) }, { label: 'Inputs' }, { label: `Digital ${n}` }]} title={label}>
      {#snippet tag()}
        <span class="pin mono">{ioText}{#if pin} · {pin.label}{/if}</span>
        <span class="pill" data-tone={state.tone} role="status" data-testid="in-state"><StateDot tone={state.tone} shape={state.shape} label={state.t} /></span>
      {/snippet}
      {#snippet actions()}
        <Switch bind:checked={f.enabled} label="Input in use" />
      {/snippet}
    </PageHeader>

    {#if !live.connected}
      <Banner tone="warn" title="Not connected to the car">Settings are kept in the project and sent when you apply them.</Banner>
    {:else if !dev.connected}
      <Banner tone="warn" title={`${dev.name} is not answering`}>Values here are the last ones it sent. Settings are kept in the project and sent when it is back.</Banner>
    {/if}
    {#if test.phase === 'none'}
      <Banner tone="fault" title="Wiring check: nothing changed in 10 s">The pin did not change. Check the wire, the switch and the pull resistor, then test again.</Banner>
    {/if}

    {#if pwmOk || f.pwm}<Segmented label="Use this input as" items={[{ value: 'switch', label: 'On / off switch' }, { value: 'pwm', label: 'PWM measurement' }]} bind:value={useVal} onchange={(v) => { f.pwm = v === 'pwm'; if (!f.enabled) f.enabled = true }} />{/if}

    <div class="cols">
      <div class="col">
        <Card title={f.pwm ? 'Duty over time' : 'State over time'} subtitle={'last 10 s · ' + (online ? 'live, 5 updates a second' : 'stopped')} aria-label="Live level">
          <div class="reads">
            <div><span class="nx-label">Function sees</span><strong data-testid="sees"><StateDot tone={sig?.on ? 'on' : 'off'} shape={sig?.on ? 'dot' : 'ring'} label={!sig || !online ? '—' : sig.on ? 'ON' : 'OFF'} /></strong><span class="muted small">{f.invert ? 'inverted: low = ON' : 'not inverted'}</span></div>
            <div><span class="nx-label">Last change</span><strong>{ago == null ? 'none yet' : ago.toFixed(1) + ' s ago'}</strong><span class="muted small">since this page opened</span></div>
            <div><span class="nx-label">Changes in 10 s</span><strong>{edges}</strong><span class="muted small">more than a few a second means flicker</span></div>
          </div>
          {#if f.pwm}
            <Banner tone="info" title="Live duty and frequency are not shown yet">The backend reports only on / off for this pin. Functions still get the duty and frequency as numbers. The graph shows on / off.</Banner>
          {/if}
          <LineChart series={[{ label: 'State', values: series.length ? series : [0, 0], color: 'var(--color-on)', area: true }]} min={-0.1} max={1.1} height={150} xLabels={['−10 s', '−7.5 s', '−5 s', '−2.5 s', 'now']}
            label={`Line graph of the input state over the last 10 seconds. It is ${sig?.on ? 'on' : 'off'} now, with ${edges} change${edges === 1 ? '' : 's'} in that time.`} />
          <p class="muted small">Top of the graph is ON, bottom is OFF.</p>
        </Card>

        <Card title={f.pwm ? 'Test: run the signal now' : 'Test: press the switch now'} aria-label="Test">
          <p role="status" data-testid="test-status">
            {#if !online}<strong>Not available while {dev.name} is offline.</strong>
            {:else if test.phase === 'waiting'}<strong>Waiting… {f.pwm ? 'start the signal source' : 'press the switch now'} · {test.left} s left</strong>
            {:else if test.phase === 'seen'}<strong class="ok">✓ Change seen after {test.at.toFixed(1)} s.</strong> The input went {sig?.on ? 'ON' : 'OFF'}. Release it and test again to check both directions.
            {:else if test.phase === 'none'}<strong class="bad">■ No change in 10 s.</strong>
            {:else}This page watches the input for 10 s and tells you if it changed.{/if}
          </p>
          {#if test.phase === 'waiting'}
            <Button onclick={stopTest} data-testid="test-stop">Stop</Button>
          {:else}
            <Button variant="primary" disabled={!online || !row.enabled} onclick={startTest} data-testid="test-start">{test.phase === 'idle' ? 'Start test' : 'Test again'}</Button>
            {#if online && !row.enabled}<span class="muted small">Turn the input on and save first.</span>{/if}
          {/if}
        </Card>
      </div>

      <div class="col">
        <Card title="How it reads" aria-label="How it reads">
          <Field label="Name" bind:value={f.name} data-testid="name" />
          {#if !f.pwm}
            <div class="grp"><span class="nx-label" id="lt">Switch type</span>
              <Segmented label="Switch type" items={[{ value: '0', label: 'Momentary' }, { value: '1', label: 'Latching (toggle)' }]} bind:value={typeVal} onchange={(v) => (f.mode = Number(v))} />
              <span class="muted small">{f.mode === 1 ? 'Each press flips the state, like a toggle. The module remembers it.' : 'Pressed = on, released = off. Right for a brake pedal.'}</span></div>
          {/if}
          <div class="grp"><span class="nx-label">Pull resistor</span>
            <Segmented label="Pull resistor" items={PULL} bind:value={pullVal} onchange={(v) => (f.pull = Number(v))} />
            <span class="muted small">{pullHint[f.pull] ?? ''}</span></div>
          {#if !f.pwm}
            <Stepper label="Debounce" bind:value={f.debounceTime} min={0} max={5000} step={5} unit="ms" data-testid="debounce" />
            <span class="muted small">Ignores flicker shorter than this. Debounce adds delay: at 20 ms a pedal press still feels instant.</span>
            <Checkbox bind:checked={f.invert} label="Invert" hint="A switch to ground pulls the pin low when pressed, so low means pressed." data-testid="invert" />
          {:else}
            <Field label={`Expected frequency (0 = find it, max ${pwmIn.maxHz})`} type="number" min={0} max={pwmIn.maxHz} unit="Hz" bind:value={f.pwmFreq} />
            <Stepper label="Glitch filter" bind:value={f.pwmMinPulseUs} min={0} max={10000} step={10} unit="µs" data-testid="glitch" />
            <span class="muted small">Ignores pulses shorter than this. Keep it well under the shortest real pulse (1 % at 1 kHz is 10 µs).</span>
            <Checkbox bind:checked={f.invert} label="Invert (duty = time low)" />
            <p class="muted small"><strong>{pwmIn.board} input.</strong> {pwmIn.text} In this mode the pin no longer works as an on / off switch{isUpstream(dev) ? ': its own variable means "signal present".' : '.'}</p>
          {/if}
        </Card>
        <UsedBy {guid} items={M.usedBy} hint="Edits here change every function that uses this input." />
      </div>
    </div>

    <SaveBar {dirty} saving={M.state.saving} {problem} err={M.state.saveErr} note={M.state.note} connected={online} onsave={save} onrevert={revert} />
  {/if}
</Page>

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: var(--space-4); align-items: start; }
  .col { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  .pin { font-size: var(--text-md); padding: 4px 10px; border-radius: var(--radius-sm); background: var(--color-raised); }
  .pill { display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 999px; background: var(--color-raised); font-weight: 600; }
  .pill[data-tone='on'] { background: var(--color-on-soft); }
  .reads { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
  .reads > div { display: flex; flex-direction: column; gap: 2px; }
  .reads strong { font-size: var(--text-lg); }
  .small { font-size: var(--text-xs); }
  .grp { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start; }
  .ok { color: var(--color-ok); }
  .bad { color: var(--color-fault); }
</style>
