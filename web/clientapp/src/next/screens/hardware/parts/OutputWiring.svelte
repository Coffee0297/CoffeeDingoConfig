<script>
  import { Card, Select, Field, Button, Banner } from '../../../ui/index.js'
  import { awgFor, awgForMm2, vDrop, WIRE_GAUGES } from '../../../../lib/store.js'

  let { f = $bindable() } = $props()

  const rec = $derived(awgFor(f.currentLimit))
  const effMm2 = $derived(Number(f.wireGaugeMm2) > 0 ? Number(f.wireGaugeMm2) : rec?.mm2)
  const effAwg = $derived(Number(f.wireGaugeMm2) > 0 ? awgForMm2(f.wireGaugeMm2) : rec?.awg)
  const vd = $derived(vDrop(f.wireLength, f.currentLimit, effMm2))
  const under = $derived(rec && effMm2 && effMm2 < rec.mm2)

  const gaugeItems = $derived([{ value: '0', label: rec ? `Auto: ${rec.mm2} mm² (recommended)` : 'Auto' },
    ...WIRE_GAUGES.map((g) => ({ value: String(g.mm2), label: `${g.mm2} mm² · ${g.awg} AWG` + (rec && g.mm2 < rec.mm2 ? ' (under recommended)' : '') }))])
  let gaugeVal = $state('0')
  $effect(() => { gaugeVal = String(Number(f.wireGaugeMm2) || 0) })
</script>

<Card title="Wiring" subtitle="notes for the harness; not sent to the module" aria-label="Wiring">
  <div class="grid">
    <Select label="Gauge" items={gaugeItems} bind:value={gaugeVal} onchange={(v) => (f.wireGaugeMm2 = Number(v))} data-testid="gauge" />
    <Field label="Length, one way" type="number" min={0} step={0.1} unit="m" bind:value={f.wireLength} data-testid="length" />
    <div class="col">
      <span class="nx-label" id="wc">Colour</span>
      <div class="row">
        <input type="color" aria-labelledby="wc" bind:value={f.wireColor} oninput={() => (f.wireSet = true)} data-testid="wire-color" />
        <span class="mono muted">{f.wireSet ? f.wireColor : 'none'}</span>
        {#if f.wireSet}<Button size="sm" variant="ghost" onclick={() => (f.wireSet = false)}>Clear</Button>{/if}
      </div>
    </div>
    <div class="col">
      <span class="nx-label" id="ws">Stripe</span>
      <div class="row">
        <input type="color" aria-labelledby="ws" bind:value={f.wireStripe} oninput={() => (f.stripeSet = true)} disabled={!f.wireSet} />
        <span class="mono muted">{f.stripeSet ? f.wireStripe : 'none'}</span>
        {#if f.stripeSet}<Button size="sm" variant="ghost" onclick={() => (f.stripeSet = false)}>Clear</Button>{/if}
      </div>
    </div>
  </div>
  {#if !rec}
    <p class="muted">Set the trip current above to get a gauge recommendation.</p>
  {:else if vd}
    <p class="sum" data-testid="vdrop">
      <strong class:ok={vd.pct <= 3} class:bad={vd.pct > 3}>{vd.pct <= 3 ? 'OK.' : 'High.'}</strong>
      {effMm2} mm² ({effAwg} AWG) over {f.wireLength} m at {f.currentLimit} A drops <strong>{vd.volts.toFixed(2)} V ({vd.pct.toFixed(1)} %)</strong>.
      Recommended at least {rec.mm2} mm² for this limit.{#if under} <strong class="bad">The gauge you chose is under that.</strong>{/if}
      {#if vd.pct > 3} Over 3 %: use a heavier wire or a shorter run.{/if}
    </p>
  {:else}
    <p class="sum" data-testid="vdrop">Recommended at least <strong>{rec.mm2} mm²</strong> ({rec.awg} AWG) for a {f.currentLimit} A limit. Enter a length to see the voltage drop.</p>
  {/if}
  <p class="muted small">Estimate only: copper wire at 13.8 V, feed and return, no connector resistance.</p>
</Card>

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--space-3); }
  .col { display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; align-items: center; gap: var(--space-2); min-height: var(--target-min); }
  input[type='color'] { width: 48px; height: 40px; padding: 2px; border: 1px solid var(--color-line-strong); border-radius: var(--radius-md); background: var(--color-raised); }
  .sum { padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--color-raised); font-size: var(--text-md); }
  .ok { color: var(--color-ok); }
  .bad { color: var(--color-fault); }
  .small { font-size: var(--text-xs); }
</style>
