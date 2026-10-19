<script>
  // Bench test card: options while idle, live current while it runs, what happens if the link drops.
  import { Card, Button, Segmented, Stepper, LineChart, Banner, Chip } from '../../../ui/index.js'
  // pwm: the module can PWM-test this output (upstream CANBoard: on only); minFreq: its lowest test frequency
  let { bench, blocker = '', modName = 'the module', limit = 0, inrush = 0, inrushTime = 0, pwm = true, minFreq = 15 } = $props()
  const b = $derived(bench.state)
  const active = $derived(b.phase === 'running' || b.phase === 'lost')
  let modeVal = $state('on')
  $effect(() => { modeVal = b.mode })
  const el = $derived(bench.elapsed())
  const series = $derived([{ label: 'Current', values: b.samples.length > 1 ? [...b.samples] : [0, 0], color: 'var(--color-on)', area: true }])
</script>

<Card title="Bench test" subtitle="switch this output on for a short, timed test" aria-label="Bench test">
  {#snippet tag()}<Chip tone="fault" symbol="▲" dashed>Switches a load</Chip>{/snippet}

  {#if active || b.phase === 'ended'}
    <div class="now" role="status" data-testid="bench-now">
      {#if b.phase === 'lost'}
        <strong class="warn">Last seen {b.samples.at(-1)?.toFixed(1) ?? '0.0'} A at {b.lostAt.toFixed(1)} s. No data since.</strong>
      {:else if b.phase === 'running'}
        <strong>Now {b.samples.at(-1)?.toFixed(1) ?? '0.0'} A · {Math.min(el, bench.holdS()).toFixed(1)} s of {bench.holdS()} s</strong>
      {:else}
        <strong>{b.endNote}</strong>
      {/if}
      <span class="muted mono">peak {b.peak.toFixed(1)} A</span>
    </div>
    <LineChart {series} min={0} height={150} label={`Current during the test: peak ${b.peak.toFixed(1)} A. Limit ${limit} A.`}
      lines={limit > 0 ? [{ value: limit, label: `limit ${limit} A`, tone: 'fault' }] : []} xLabels={['start', 'now']} />
    <p class="muted small">Limit {limit} A{#if inrushTime > 0} · inrush allowed {inrush} A for {inrushTime} ms{/if}.</p>
  {/if}

  {#if b.phase === 'running'}
    <Button variant="danger" size="lg" onclick={() => bench.stop()} data-testid="bench-stop">Stop now<span class="sub"> turns the output off at once</span></Button>
  {:else if b.phase === 'lost'}
    <Button size="lg" disabled>Stop now unavailable<span class="sub"> no link to {modName}</span></Button>
  {:else}
    <div class="opts" class:locked={active}>
      <Segmented label="Test mode" items={[{ value: 'on', label: 'On, full power' }, ...(pwm ? [{ value: 'pwm', label: 'PWM, set duty' }] : [])]} bind:value={modeVal} onchange={(v) => (bench.state.mode = v)} />
      <Stepper label="Hold" bind:value={bench.state.hold} min={1} max={30} step={1} unit="s" data-testid="bench-hold" />
      {#if b.mode === 'pwm'}
        <Stepper label="Duty" bind:value={bench.state.duty} min={0} max={100} step={5} unit="%" data-testid="bench-duty" />
        <Stepper label="Frequency" bind:value={bench.state.freq} min={minFreq} max={400} step={5} unit="Hz" data-testid="bench-freq" />
      {/if}
    </div>
    <div class="go" data-testid="bench-ready">
      {#if blocker}<span class="why" role="status">{blocker}</span>{:else}<span class="muted small">Start it with <strong>{b.mode === 'pwm' ? `Run PWM ${b.duty} % for ${bench.holdS()} s` : `Test for ${bench.holdS()} s`}</strong> at the top of the page. It pauses this output's rule while it runs. Current limits stay active.</span>{/if}
    </div>
    {#if b.phase === 'refused'}<Banner tone="fault" title="The module refused the test">{b.error}</Banner>{/if}
  {/if}

  <details>
    <summary>If the link drops during a test</summary>
    <ol class="steps">
      <li><strong>0.0 s</strong> Test starts. The module stores the {bench.holdS()} s limit.</li>
      <li><strong>Link drops</strong> No more current readings. Stop now cannot reach the module.</li>
      <li><strong>{bench.holdS()}.0 s</strong> The module turns the output off by itself. Reconnect to confirm.</li>
    </ol>
    <p class="muted small">The time limit lives in the module, so the output goes off even if the laptop, the cable or dingoConfig fails. A test runs only while connected to {modName}, needs firmware with the output test (fork 5.5.107 or newer, or upstream dingoFW with the bench test) and an output that is turned on and saved.</p>
  </details>
</Card>

<style>
  .now { display: flex; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
  .warn { color: var(--color-warn); }
  .small { font-size: var(--text-xs); }
  .sub { font-weight: 500; font-size: var(--text-xs); margin-left: var(--space-2); }
  .opts { display: flex; gap: var(--space-4); flex-wrap: wrap; align-items: flex-end; }
  .go { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start; }
  .why { color: var(--color-warn); font-weight: 600; font-size: var(--text-sm); }
  details { border-top: 1px solid var(--color-line); padding-top: var(--space-3); }
  summary { cursor: pointer; font-weight: 600; min-height: 32px; }
  .steps { margin: var(--space-2) 0; padding-left: var(--space-5); display: flex; flex-direction: column; gap: var(--space-1); }
</style>
