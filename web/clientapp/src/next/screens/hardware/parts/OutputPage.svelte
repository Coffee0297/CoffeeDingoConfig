<script>
  // One output of one module: PDM smart output (current sensing, limits, wiring) or CANBoard low-side output.
  import { untrack } from 'svelte'
  import { Page, PageHeader, Card, Button, Chip, StateDot, Banner, Empty, LineChart } from '../../../ui/index.js'
  import { live, defs, api, device, moduleState, isCanboard, project } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import { pinFor, boardOf } from '../../../../lib/pinmap.js'
  import { outputRatingA } from '../../../../lib/apply.js'
  import OutputChain from './OutputChain.svelte'
  import OutputProtection from './OutputProtection.svelte'
  import OutputDrive from './OutputDrive.svelte'
  import OutputWiring from './OutputWiring.svelte'
  import OutputBench from './OutputBench.svelte'
  import BenchBanner from './BenchBanner.svelte'
  import SaveBar from './SaveBar.svelte'
  import { createBench } from './bench.svelte.js'
  import { signalFeed, ring } from './feeds.svelte.js'
  import { resample, olderThan, isUpstream, has } from './util.js'

  let { guid, n } = $props()

  const dev = $derived(device(guid))
  const isCb = $derived(isCanboard(dev))
  const pdmOut = $derived(dev?.outputs?.find((o) => o.number === n) ?? null)
  const connected = $derived(live.connected && !!dev?.connected)

  // CANBoard outputs live in /functions (digitalOut), not in telemetry.
  let cbRow = $state(null), cbErr = $state(''), cbLoaded = $state(false)
  async function loadCb() {
    try { const fx = await api.functions(guid); cbRow = (fx?.digitalOut ?? []).find((x) => x.number === n) ?? null; cbErr = '' } catch (e) { cbErr = e?.message ?? String(e) } finally { cbLoaded = true }
  }
  $effect(() => { if (isCb) loadCb() })

  const feed = signalFeed(() => (dev ? guid : ''), 250)
  const src = $derived(isCb ? cbRow : pdmOut)

  // ---- form ----
  let f = $state(null), snap = $state(''), saving = $state(false), saveErr = $state(''), savedNote = $state('')
  function seedFrom(o) {
    return isCb ? {
      name: o.name ?? '', enabled: !!o.enabled, input: o.input ?? 0,
      pwmEnabled: !!o.pwmEnabled, freq: o.frequency ?? 100, fixedDuty: o.fixedDutyCycle ?? 100, minDuty: o.minDutyCycle ?? 0,
      softStart: !!o.softStartEnabled, softStartRamp: o.softStartRampTime ?? 0,
      variableDutyCycle: !!o.variableDutyCycle, dutyCycleInput: o.dutyCycleInput ?? 0, dutyCycleDenom: o.dutyCycleDenominator ?? 100,
      variableFreq: !!o.variableFreq, freqInput: o.freqInput ?? 0, freqInputDenom: o.freqInputDenom ?? 1, rampDutyChanges: !!o.rampDutyChanges,
    } : {
      name: o.name ?? '', wireColor: o.wireColor || '#3a7bd5', wireSet: !!o.wireColor, wireStripe: o.wireStripe || '#ffffff', stripeSet: !!o.wireStripe,
      wireLength: o.wireLength ?? 0, wireGaugeMm2: o.wireGaugeMm2 ?? 0,
      input: o.inputVal ?? 0, enabled: !!o.enabled,
      currentLimit: o.currentLimit, inrushLimit: o.inrushLimit, inrushTime: o.inrushTime,
      resetMode: o.resetMode, resetTime: o.resetTime, resetCountLimit: o.resetCountLimit,
      pwmEnabled: !!o.pwmEnabled, freq: o.freq, fixedDuty: o.fixedDuty, minDuty: o.minDuty, softStart: !!o.softStart, softStartRamp: o.softStartRamp,
      variableDutyCycle: !!o.variableDutyCycle, dutyCycleInput: o.dutyCycleInput ?? 0, dutyCycleDenom: o.dutyCycleDenom ?? 100,
      variableFreq: !!o.variableFreq, freqInput: o.freqInput ?? 0, freqInputDenom: o.freqInputDenom ?? 1, rampDutyChanges: !!o.rampDutyChanges,
      primaryOutput: o.primaryOutput ?? -1, warnLimit: o.warnLimit ?? 0, openLoadLimit: o.openLoadLimit ?? 0, openLoadTime: o.openLoadTime ?? 1000,
      softStopTime: o.softStopTime ?? 0,
    }
  }
  // Seed once per output so the 10 Hz telemetry never overwrites an edit in progress.
  $effect(() => { if (!f && src) { f = seedFrom(src); snap = JSON.stringify(f) } })
  const dirty = $derived(!!f && JSON.stringify(f) !== snap)
  function revert() { if (src) { f = seedFrom(src); snap = JSON.stringify(f); saveErr = '' } }

  const rating = $derived(!isCb && dev ? outputRatingA(defs, dev.type, n) : null)
  const overRating = $derived(rating != null && Number(f?.currentLimit) > rating)

  function validate() {
    if (!f) return 'Not loaded yet.'
    if (!isCb && overRating) return `The trip current (${f.currentLimit} A) is above the ${rating} A rating of this pin. Lower it.`
    if (f.pwmEnabled) {
      const minD = Math.round(+f.minDuty || 0)
      if (minD < 0 || minD > 100) return 'Lowest duty must be 0 to 100 %.'
      if (!f.variableFreq) { const fr = Math.round(+f.freq || 0); if (fr < 15 || fr > 400) return 'PWM frequency must be 15 to 400 Hz.' }
      if (!f.variableDutyCycle) {
        const d = Math.round(+f.fixedDuty || 0)
        if (d < 0 || d > 100) return 'Duty must be 0 to 100 %.'
        if (minD > d) return `Lowest duty (${minD} %) cannot be above the duty (${d} %).`
      }
      if (f.variableDutyCycle && !Number(f.dutyCycleInput)) return 'Choose the signal the duty comes from.'
      if (f.variableFreq && !Number(f.freqInput)) return 'Choose the signal the frequency comes from.'
    }
    return ''
  }
  const problem = $derived(dirty ? validate() : '')

  async function save() {
    const v = validate()
    if (v) { saveErr = v; return }
    saving = true; saveErr = ''; savedNote = ''
    try {
      let r
      if (isCb) {
        r = await api.setFunction(guid, 'digitaloutput', n, {
          name: f.name, enabled: f.enabled, input: Number(f.input), pwmEnabled: f.pwmEnabled, softStartEnabled: f.softStart, softStartRampTime: Number(f.softStartRamp),
          fixedDutyCycle: Math.round(Number(f.fixedDuty)), frequency: Math.round(Number(f.freq)), minDutyCycle: Math.round(Number(f.minDuty)),
          variableDutyCycle: !!f.variableDutyCycle, dutyCycleInput: Number(f.dutyCycleInput) || 0, dutyCycleDenominator: Math.max(1, Number(f.dutyCycleDenom) || 1),
          variableFreq: !!f.variableFreq, freqInput: Number(f.freqInput) || 0, freqInputDenom: Math.max(1, Number(f.freqInputDenom) || 1), rampDutyChanges: !!f.rampDutyChanges })
        await loadCb()
      } else {
        r = await api.outputConfig(guid, {
          Number: n, Name: f.name, WireColor: f.wireSet ? f.wireColor : '', WireStripe: f.stripeSet ? f.wireStripe : '',
          WireLength: Number(f.wireLength) || 0, WireGaugeMm2: Number(f.wireGaugeMm2) || 0, Enabled: f.enabled, Input: Number(f.input),
          CurrentLimit: Number(f.currentLimit), InrushLimit: Number(f.inrushLimit), InrushTime: Math.round(Number(f.inrushTime)),
          ResetMode: Number(f.resetMode), ResetTime: Math.round(Number(f.resetTime)), ResetCountLimit: Math.round(Number(f.resetCountLimit)),
          PwmEnabled: f.pwmEnabled, Freq: Math.round(Number(f.freq)), FixedDuty: Math.round(Number(f.fixedDuty)), MinDuty: Math.round(Number(f.minDuty)),
          SoftStart: f.softStart, SoftStartRamp: Math.round(Number(f.softStartRamp)),
          VariableDutyCycle: !!f.variableDutyCycle, DutyCycleInput: Number(f.dutyCycleInput) || 0, DutyCycleDenom: Math.max(1, Number(f.dutyCycleDenom) || 1),
          VariableFreq: !!f.variableFreq, FreqInput: Number(f.freqInput) || 0, FreqInputDenom: Math.max(1, Number(f.freqInputDenom) || 1),
          RampDutyChanges: !!f.rampDutyChanges, PrimaryOutput: Number(f.primaryOutput ?? -1),
          WarnLimit: Number(f.warnLimit), OpenLoadLimit: Number(f.openLoadLimit), OpenLoadTime: Math.round(Number(f.openLoadTime)),
          SoftStopTime: Math.round(Number(f.softStopTime) || 0),
        })
      }
      project.dirty = true
      snap = JSON.stringify(f)
      savedNote = r?.staged ? 'Kept in the project. Not on the car yet.' : r?.written ? 'Kept in the project and sent to the module.' : 'Kept in the project. Not on the car yet: the module is offline, apply to car when it is back.'
    } catch (e) { saveErr = e?.message ?? String(e) } finally { saving = false }
  }

  // ---- live state + 60 s current history ----
  const sig = $derived(isCb ? feed.get('Digital output', cbRow?.name) : undefined)
  const state = $derived(isCb ? (sig ? (sig.on ? 'On' : 'Off') : '') : (pdmOut?.state ?? ''))
  const amps = $derived(isCb ? null : Number(pdmOut?.current ?? 0))
  const hist = ring(60_000)
  let tick = $state(0), peak = $state(0)
  $effect(() => {
    if (isCb || !pdmOut || !live.connected) return
    const a = Number(pdmOut.current ?? 0)
    untrack(() => { hist.push(a); if (a > peak) peak = a; tick++ })
  })
  // a steady scale: up to the limit (or the peak, if higher), so the limit line shows and the chart does not rescale every update
  const yMax = $derived(Math.max(Number(f?.currentLimit) || 0, peak, 1) * 1.1)
  const series = $derived.by(() => { tick; return resample(hist.samples(), 60_000, 150, Date.now(), 'max') })   // peak per bin: spikes stay visible
  const tone = $derived(state === 'On' ? 'on' : state === 'Fault' || state === 'Overcurrent' ? 'fault' : state === 'Warning' || state === 'OpenLoad' ? 'warn' : 'off')

  // ---- bench test ----
  const bench = createBench({ guid: () => guid, n: () => n, connected: () => connected, current: () => (isCb ? 0 : pdmOut?.current ?? 0) })

  // Trip count: read once per module + connection. Reading the trip log talks to the module, and doing it
  // while a bench test runs cancels the test on the module, so it is never read during a test.
  let trips = $state(null), tripErr = $state('')
  const hasDev = $derived(!!dev)
  const testing = $derived(bench.state.phase === 'running' || bench.state.phase === 'lost')
  $effect(() => {
    if (isCb || !hasDev || !connected || testing) return
    let alive = true
    untrack(() => api.overloads(guid)).then((r) => { if (alive) { trips = (r?.events ?? []).filter((e) => e.output === n).length; tripErr = '' } }).catch((e) => { if (alive) tripErr = e?.message ?? String(e) })
    return () => { alive = false }
  })
  $effect(() => () => bench.dispose())
  const blocker = $derived.by(() => {
    if (!live.connected) return 'Connect to the car first. Tests run only while connected.'
    if (!live.programmingAllowed) return 'Sim adapter: programming is turned off.'
    if (!dev?.connected) return `${dev?.name ?? 'The module'} is not answering on the bus.`
    if (isUpstream(dev)) return 'Upstream dingoFW has no output test command.'
    if (olderThan(dev?.version, [5, 5, 107])) return 'Needs firmware 5.5.107 or newer.'
    if (!src?.enabled) return 'Turn the output on and save first. The test only runs on an enabled output.'
    if (dirty) return 'Save your changes first. The test uses what is on the module.'
    // G2: saved changes wait for Apply; the module still runs what it had
    if (dev?.pendingEdits > 0) return 'Apply to car first. The test uses what is on the module, and this module has changes waiting.'
    return ''
  })

  const title = $derived((f?.name ?? src?.name ?? '').trim() || `Output ${n}`)
  const pin = $derived(dev ? pinFor(dev, 'output', n) : null)
  const driver = $derived(dev ? boardOf(dev)?.drivers?.[n - 1] ?? null : null)   // G21: driver chip per output
  const modState = $derived(dev ? moduleState(dev) : null)
</script>

<Page>
  {#if !dev}
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: 'Module not found' }]} title="Module not found" />
    <Empty title="This module is not in the project" text="It may have been removed. Open Hardware to pick another.">
      {#snippet actions()}<Button href={href('hardware')}>Back to Hardware</Button>{/snippet}
    </Empty>
  {:else if !src && isCb && !cbLoaded}
    <p class="muted" role="status">Reading the output…</p>
  {:else if !src}
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: dev.name, href: href('hardware', 'module', guid) }, { label: `Out ${n}` }]} title={`Output ${n} not found`} />
    <Empty title={`${dev.name} has no output ${n}`} text={cbErr || 'Check the number in the address.'}>
      {#snippet actions()}<Button href={href('hardware', 'outputs')}>See every output</Button>{/snippet}
    </Empty>
  {:else if f}
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: dev.name, href: href('hardware', 'module', guid) }, { label: 'Outputs', href: href('hardware', 'outputs') }, { label: `Out ${n}` }]}
      title={title}>
      {#snippet tag()}
        <span class="pin mono">{isCb ? 'DO' : 'OUT'} {n}{#if pin} · {pin.label}{/if}</span>
        {#if state}<span class="pill" data-tone={tone} role="status" data-testid="out-state"><StateDot tone={tone} shape={tone === 'on' ? 'dot' : tone === 'off' ? 'ring' : tone === 'warn' ? 'triangle' : 'square'} label={state + (amps != null ? ' · ' + amps.toFixed(1) + ' A' : '')} /></span>{/if}
      {/snippet}
      {#snippet actions()}
        <Button variant="test" disabled={!!blocker || bench.state.phase === 'running' || bench.state.phase === 'lost'} busy={bench.state.busy} title={blocker || 'Switch this output on for a timed test'} onclick={() => bench.start()} data-testid="header-test">{bench.state.mode === 'pwm' ? `Run PWM ${bench.state.duty} % for ${bench.holdS()} s` : `Test for ${bench.holdS()} s`}</Button>
        <Button href={href('live', 'plot', { signal: `out:${guid}:${n}` })}>Graph it</Button>
      {/snippet}
    </PageHeader>

    {#if !live.connected}
      <Banner tone="warn" title="Not connected to the car">You can still edit the project. Changes reach the module when you apply them.</Banner>
    {:else if !dev.connected}
      <Banner tone="warn" title={`${dev.name} is not answering`}>Edits are kept in the project and sent when it is back. {modState?.word}.</Banner>
    {/if}

    <BenchBanner {bench} name={title} modName={dev.name} outNo={n} />

    <div class="cols">
      <div class="col">
        <OutputChain {guid} {dev} bind:f {feed} {connected} raw={src} />
        {#if !isCb}
          <OutputProtection bind:f {rating} />
        {:else}
          <Card title="Protection"><p class="muted">The CANBoard switches this load to ground and cannot measure or limit current. Put a fuse in the load wire.</p></Card>
        {/if}
        <OutputDrive {guid} bind:f softStop={!isCb && isUpstream(dev) && has(dev, 0x1000 + n - 1, 31)} />
      </div>
      <div class="col">
        <OutputBench {bench} {blocker} modName={dev.name} limit={isCb ? 0 : Number(f.currentLimit) || 0} inrush={Number(f.inrushLimit) || 0} inrushTime={Number(f.inrushTime) || 0} />
        {#if !isCb}
          <Card title="Current, last 60 s" aria-label="Current history">
            {#snippet actions()}<span class="mono muted" data-testid="peak">peak {peak.toFixed(1)} A · now {amps?.toFixed(1)} A</span>{/snippet}
            {#if !live.connected}
              <p class="muted" role="status">No live data while disconnected.</p>
            {:else}
              <LineChart series={[{ label: 'Current', values: series.length ? series : [0, 0], color: 'var(--color-on)', area: true }]} min={0} max={yMax} height={190}
                over={Number(f.currentLimit) > 0 ? { value: Number(f.currentLimit), tone: 'warn' } : null}
                lines={[...(Number(f.currentLimit) > 0 ? [{ value: Number(f.currentLimit), label: `limit ${f.currentLimit} A`, tone: 'fault' }] : []), ...(Number(f.warnLimit) > 0 ? [{ value: Number(f.warnLimit), label: `warn ${f.warnLimit} A`, tone: 'warn' }] : [])]}
                label={`Current over the last 60 seconds. Now ${amps?.toFixed(1)} A, peak ${peak.toFixed(1)} A. Limit ${f.currentLimit} A.`} xLabels={['−60 s', '−45 s', '−30 s', '−15 s', 'now']} />
            {/if}
            <p class="muted small">History starts when this page opens and can miss spikes shorter than 100 ms.</p>
            <p class="small" data-testid="trips">
              {#if tripErr}Trip log not available: {tripErr}
              {:else if trips == null}{connected ? 'Reading the trip log…' : 'Trip log needs a live module.'}
              {:else}{trips} trip{trips === 1 ? '' : 's'} on this output in the module's log. The log has no dates yet.{/if}
              <a href={href('live', 'trips')}>Open the trip log</a>
            </p>
          </Card>
          <OutputWiring bind:f />
          <Card title="Module limits for this pin">
            <p class="muted">{#if rating != null}OUT{n} is rated <strong>{rating} A</strong> continuous on the {dev.type}{#if driver} (driver <span class="mono" data-testid="out-driver">{driver}</span>){/if}. The trip current cannot be set above it.{:else}No rating is known for this pin.{/if}</p>
          </Card>
        {:else}
          <Card title="Live state"><p class="muted" data-testid="cb-live">{state ? `Right now this output is ${state.toLowerCase()}${sig && cbRow?.pwmEnabled && sig.on ? ' at ' + sig.value + ' %' : ''}.` : 'No live value yet.'}</p></Card>
        {/if}
      </div>
    </div>

    <SaveBar {dirty} {saving} {problem} err={saveErr} note={savedNote} {connected} onsave={save} onrevert={revert} />
  {/if}
</Page>

<style>
  /* room under the last cards for the sticky save bar, so it never hides Retries or Wiring */
  .cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); align-items: start; padding-bottom: 96px; }
  .col { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  .pin { font-size: var(--text-md); padding: 4px 10px; border-radius: var(--radius-sm); background: var(--color-raised); }
  .pill { display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 999px; background: var(--color-raised); font-weight: 600; }
  .pill[data-tone='on'] { background: var(--color-on-soft); }
  .pill[data-tone='fault'] { background: var(--color-fault-soft); }
  .pill[data-tone='warn'] { background: var(--color-warn-soft); }
  .small { font-size: var(--text-xs); }
</style>
