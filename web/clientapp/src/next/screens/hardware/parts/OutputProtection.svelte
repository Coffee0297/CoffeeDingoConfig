<script>
  import { Card, Stepper, Select } from '../../../ui/index.js'
  // warn / openLoad: the firmware has the warning / open-load limits (output subs 18-20; on upstream by its param list)
  // under: the undercurrent limit (upstream output subs 27-29, upstream modules only)
  let { f = $bindable(), rating = null, warn = true, openLoad = true, under = false } = $props()
  const UNDER = [{ value: '0', label: 'Report only' }, { value: '1', label: 'Switch the output off' }]

  const RESET = [{ value: '0', label: 'Stay off (latch)' }, { value: '1', label: 'Retry a few times' }, { value: '2', label: 'Retry for ever' }]
  let rm = $state('0')
  $effect(() => { rm = String(f.resetMode ?? 0) })
  let ut = $state('0')
  $effect(() => { ut = f.underTrip ? '1' : '0' })

  const over = $derived(rating != null && Number(f.currentLimit) > rating)
  const num = (x) => Number(x) || 0
  const afterTrip = $derived(num(f.resetMode) === 0 ? 'stays off until the module is power-cycled'
    : num(f.resetMode) === 1 ? `retries ${num(f.resetCountLimit)} time${num(f.resetCountLimit) === 1 ? '' : 's'}, ${num(f.resetTime)} ms apart, then stays off`
    : `retries for ever, ${num(f.resetTime)} ms apart`)
</script>

<Card title="Protection" aria-label="Protection">
  <div class="grid">
    <div>
      <Stepper label="Trips above" bind:value={f.currentLimit} min={0} max={100} step={0.5} decimals={1} unit="A" data-testid="limit" />
      {#if rating != null}<span class="hint" class:bad={over}>{over ? '■ ' : ''}max {rating} A on this pin</span>{/if}
    </div>
    <div>
      <Stepper label="Inrush allowed" bind:value={f.inrushLimit} min={0} max={100} step={1} decimals={1} unit="A" data-testid="inrush" />
      <span class="hint">motors and lamps start high</span>
    </div>
    <Stepper label="Inrush time" bind:value={f.inrushTime} min={0} max={10000} step={50} unit="ms" data-testid="inrush-time" />
    <Select label="After a trip" items={RESET} bind:value={rm} onchange={(v) => (f.resetMode = Number(v))} data-testid="reset-mode" />
    <Stepper label="Retries" bind:value={f.resetCountLimit} min={0} max={100} step={1} disabled={num(f.resetMode) !== 1} />
    <Stepper label="Wait between retries" bind:value={f.resetTime} min={0} max={60000} step={100} unit="ms" disabled={num(f.resetMode) === 0} />
    {#if warn}
      <div>
        <Stepper label="Warn at" bind:value={f.warnLimit} min={0} max={100} step={0.5} decimals={1} unit="A" data-testid="warn" />
        <span class="hint">reported, keeps running. 0 = off</span>
      </div>
    {/if}
    {#if openLoad}
      <div>
        <Stepper label="Load missing below" bind:value={f.openLoadLimit} min={0} max={100} step={0.1} decimals={1} unit="A" data-testid="openload" />
        <span class="hint">open load. 0 = off</span>
      </div>
      <Stepper label="Load missing for" bind:value={f.openLoadTime} min={0} max={10000} step={100} unit="ms" disabled={!num(f.openLoadLimit)} />
    {/if}
    {#if under}
      <div>
        <Stepper label="Too little current below" bind:value={f.underLimit} min={0} max={100} step={0.1} decimals={1} unit="A" data-testid="under" />
        <span class="hint">undercurrent: one of two bulbs out, a pump running dry. 0 = off</span>
      </div>
      <Stepper label="Too little current for" bind:value={f.underTime} min={0} max={60000} step={100} unit="ms" disabled={!num(f.underLimit)} />
      <div>
        <Select label="On too little current" items={UNDER} bind:value={ut} onchange={(v) => (f.underTrip = v === '1')} disabled={!num(f.underLimit)} data-testid="under-trip" />
        {#if f.underTrip && num(f.underLimit)}<span class="hint bad">latches Fault: only where losing this load is safe (not a fuel pump)</span>{/if}
      </div>
    {/if}
  </div>
  <p class="sum" data-testid="protection-summary">
    Trips above <strong>{f.currentLimit} A</strong>{#if num(f.inrushTime) > 0}, or <strong>{f.inrushLimit} A</strong> during the first <strong>{f.inrushTime} ms</strong>{/if}; {afterTrip}.
    {#if warn}{#if num(f.warnLimit) > 0}Warns at <strong>{f.warnLimit} A</strong>.{:else}No early warning.{/if}{/if}
    {#if openLoad}{#if num(f.openLoadLimit) > 0}Reports "load missing?" below <strong>{f.openLoadLimit} A</strong> for <strong>{f.openLoadTime} ms</strong>.{:else}Missing load is not checked.{/if}{/if}
    {#if under && num(f.underLimit) > 0}Below <strong>{f.underLimit} A</strong> for <strong>{f.underTime} ms</strong> it {f.underTrip ? 'switches off and latches Fault' : 'reports Undercurrent'}.{/if}
  </p>
</Card>

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: var(--space-3); }
  .hint { display: block; font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 4px; }
  .hint.bad { color: var(--color-fault); font-weight: 700; }
  .sum { padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--color-raised); font-size: var(--text-md); }
</style>
