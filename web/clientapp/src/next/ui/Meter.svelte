<script>
  /** Labelled usage bar: value of max (+ unit). Warns at `warnAt` fraction (default 0.85) with a ▲ and words. */
  let { label, value = 0, max = 1, unit = '', warnAt = 0.85 } = $props()
  const frac = $derived(max ? Math.min(1, value / max) : 0)
  const near = $derived(frac >= warnAt)
</script>

<div class="m">
  <div class="top"><span>{label}</span><span class="mono" class:near>{near ? '▲ ' : ''}{value} of {max}{unit ? ' ' + unit : ''}{near ? ' · ' + Math.max(0, max - value) + ' left' : ''}</span></div>
  <div class="bar" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin="0" aria-valuemax={max}><span style="width: {frac * 100}%" class:near></span></div>
</div>

<style>
  .m { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-xs); }
  .top { display: flex; justify-content: space-between; gap: var(--space-2); }
  .near { color: var(--color-warn); font-weight: 700; }
  .bar { height: 6px; border-radius: 3px; background: var(--color-raised); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--color-on); }
  .bar span.near { background: var(--color-warn); }
</style>
