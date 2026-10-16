<script>
  /**
   * Line graph (never bars). series: [{ label, values: number[], color: 'var(--color-series-1)', dash?: '6 4', area?: bool }].
   * min/max fix the y range (default: fit all series). lines: [{ value, label, tone: 'fault'|'warn' }] horizontal markers.
   * over: { value, tone } draws the part of the FIRST series above `value` in that tone.
   * label = sentence for screen readers that states the numbers (required for charts that matter).
   */
  let { series = [], min, max, height = 180, lines = [], over = null, label = '', xLabels = [] } = $props()

  const all = $derived(series.flatMap((s) => s.values ?? []).filter((v) => Number.isFinite(v)))
  const lo = $derived(min ?? Math.min(0, ...all))
  const hi = $derived(max ?? (Math.max(1, ...all) * 1.1))
  const y = (v) => 100 - ((v - lo) / ((hi - lo) || 1)) * 100
  const path = (vals) => (vals ?? []).map((v, i) => (i ? 'L' : 'M') + ((i * 1000) / Math.max(1, vals.length - 1)).toFixed(1) + ' ' + y(Math.min(hi, Math.max(lo, v))).toFixed(1)).join(' ')
  const overPath = $derived.by(() => {
    if (!over || !series[0]) return ''
    const v = series[0].values ?? [], n = Math.max(1, v.length - 1)
    return v.map((x, i) => (x > over.value ? [i - 1, i, i + 1].filter((k) => k >= 0 && k < v.length).map((k, j) => (j ? 'L' : 'M') + ((k * 1000) / n).toFixed(1) + ' ' + y(Math.min(hi, v[k])).toFixed(1)).join(' ') : '')).join(' ')
  })
  const toneVar = (t) => (t === 'warn' ? 'var(--color-warn)' : 'var(--color-fault)')
</script>

<div class="lc" style="height: {height}px">
  <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : 'true'}>
    {#each series as s, i (i)}
      {#if s.area}<path d={path(s.values) + ' L1000 100 L0 100 Z'} fill="var(--color-on-soft)" stroke="none" />{/if}
      <path d={path(s.values)} fill="none" stroke={s.color ?? 'var(--color-on)'} stroke-width="2.5" stroke-dasharray={s.dash ?? ''} vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    {/each}
    {#if overPath}<path d={overPath} fill="none" stroke={toneVar(over.tone)} stroke-width="3" vector-effect="non-scaling-stroke" stroke-linejoin="round" />{/if}
  </svg>
  {#each lines as l (l.label)}
    <span class="ln" style="bottom: {100 - y(l.value)}%; border-color: {toneVar(l.tone)}" aria-hidden="true"></span>
    <span class="ll" style="bottom: calc({100 - y(l.value)}% + 2px); color: {toneVar(l.tone)}" aria-hidden="true">{l.label}</span>
  {/each}
</div>
{#if xLabels.length}
  <div class="xl" aria-hidden="true">{#each xLabels as x (x)}<span>{x}</span>{/each}</div>
{/if}

<style>
  .lc { position: relative; border-radius: var(--radius-md); background: var(--color-raised); padding: 8px; box-sizing: border-box; }
  svg { position: absolute; inset: 8px; width: calc(100% - 16px); height: calc(100% - 16px); overflow: visible; }
  .ln { position: absolute; left: 8px; right: 8px; border-top: 2px dashed; }
  .ll { position: absolute; right: 12px; font-family: var(--font-mono); font-size: var(--text-xs); }
  .xl { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); padding: 2px 8px 0; }
</style>
