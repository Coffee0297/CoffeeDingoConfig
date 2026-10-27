<script>
  /** Fuse curve: the trip thresholds (inrush, then trip current) against an example load, through the firmware's
   *  trip and reset logic (fuse.js). Follows the protection settings as they are edited. */
  import { Segmented, Stepper, LineChart } from '../../../ui/index.js'
  import { LOADS, loadFromName, simulate, windowMs, thin, summary } from './fuse.js'

  let { f, measured = 0 } = $props()
  let load = $state('steady')
  let runA = $state(1)
  // first guess, once: the load type from the name, the running current from the module or 60 % of the limit
  let seeded = false
  $effect(() => {
    if (seeded || !f) return
    seeded = true
    load = loadFromName(f.name)
    runA = Number(measured) > 0.2 ? Math.round(measured * 10) / 10 : Math.max(0.5, Math.round((Number(f.currentLimit) || 5) * 6) / 10)
  })

  const ms = $derived(windowMs(f))
  const sim = $derived(simulate(f, load, Number(runA) || 0, ms))
  const text = $derived(summary(sim, load, Number(runA) || 0, f))
  const hard = $derived(Number(f.hardShortLimit) || 0)
  const ramp = $derived(f.pwmEnabled && f.softStart ? Number(f.softStartRamp) || 0 : 0)
  const yMax = $derived(Math.max(1, hard, ...sim.limit, ...sim.demand) * 1.1)
  const xLabels = $derived([0, 0.25, 0.5, 0.75, 1].map((k) => { const t = ms * k; return t >= 1000 ? (t / 1000).toFixed(t % 1000 ? 1 : 0) + ' s' : Math.round(t) + ' ms' }))
</script>

<div class="fc" data-testid="fuse-curve">
  <div class="ctl">
    <Segmented label="Example load" size="sm" items={Object.entries(LOADS).map(([value, l]) => ({ value, label: l.label }))} bind:value={load} data-testid="fuse-load" />
    <Stepper label="Running current" bind:value={runA} min={0} max={100} step={0.5} decimals={1} unit="A" data-testid="fuse-run" />
  </div>
  <LineChart min={0} max={yMax} height={170} {xLabels} lines={hard > 0 ? [{ value: hard, label: `dead short ${hard} A`, tone: 'fault' }] : []}
    series={[
      { label: 'Trips above', values: thin(sim.limit), color: 'var(--color-fault)', dash: '6 4' },
      { label: 'The load would draw', values: thin(sim.demand), color: 'var(--color-text-muted)', dash: '2 3' },
      { label: 'Flows', values: thin(sim.flow), color: 'var(--color-on)', area: true },
    ]}
    label={`Fuse curve over ${xLabels[4]}. ${text}`} />
  <ul class="key" aria-hidden="true">
    <li><span class="sw dash"></span>Trips above (inrush allowed, then trip current)</li>
    <li><span class="sw dot"></span>What the {LOADS[load].label.toLowerCase()} would draw · {LOADS[load].sub}</li>
    <li><span class="sw solid"></span>What flows</li>
    {#if hard > 0}<li><span class="sw dash"></span>Dead short: latches off above {hard} A, even during inrush</li>{/if}
    {#if ramp > 0}<li>Soft start: the current ramps up over {ramp} ms</li>{/if}
  </ul>
  <p class="sum" class:bad={sim.trips.length > 0} data-testid="fuse-summary">{sim.trips.length ? '■ ' : '● '}{text}</p>
</div>

<style>
  .fc { display: flex; flex-direction: column; gap: var(--space-2); }
  .ctl { display: flex; gap: var(--space-4); flex-wrap: wrap; align-items: flex-end; }
  .key { display: flex; flex-wrap: wrap; gap: 4px var(--space-4); margin: 0; padding: 0; list-style: none; font-size: var(--text-xs); color: var(--color-text-muted); }
  .key li { display: inline-flex; align-items: center; gap: 6px; }
  .sw { width: 20px; border-top: 2px solid var(--color-on); }
  .sw.dash { border-top: 2px dashed var(--color-fault); }
  .sw.dot { border-top: 2px dotted var(--color-text-muted); }
  .sum { margin: 0; font-size: var(--text-sm); }
  .sum.bad { color: var(--color-fault); font-weight: 600; }
</style>
