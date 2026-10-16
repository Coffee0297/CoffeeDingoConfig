<script>
  // One dashboard tile: name, module, big value, optional usage bar, sparkline, sub text.
  // The whole tile links to where the thing is configured; "Graph" opens it in Plot.
  import { LineChart } from '../../../ui/index.js'
  let { name, mod = '', value, pct = null, sub = '', tone = 'on', spark = [], href = '', graph = '', unit = '' } = $props()
  const shape = $derived({ fault: '■', warn: '▲', off: '○', stale: '○' }[tone] ?? '●')
  const color = $derived(tone === 'fault' ? 'var(--color-fault)' : tone === 'off' || tone === 'stale' ? 'var(--color-line-strong)' : 'var(--color-on)')
  const bar = $derived(pct == null ? null : Math.max(0, Math.min(100, pct)))
</script>

<div class="tile" data-tone={tone} data-testid="tile">
  <div class="top">
    <span class="mk" aria-hidden="true">{shape}</span>
    {#if href}<a class="nm" {href}>{name}</a>{:else}<span class="nm">{name}</span>{/if}
    <span class="mod">{mod}</span>
  </div>
  <span class="val mono">{value}{#if unit}<small> {unit}</small>{/if}</span>
  {#if bar != null}<div class="bar" aria-hidden="true"><span class:hot={bar > 80} style="width: {bar}%"></span></div>{/if}
  {#if spark.length > 1}<div class="sp" aria-hidden="true"><LineChart series={[{ label: name, values: spark, color }]} height={32} /></div>{/if}
  <div class="bot"><span class="sub">{sub}</span>{#if graph}<a class="gr" href={graph} aria-label={'Graph ' + name}>Graph it</a>{/if}</div>
</div>

<style>
  .tile { position: relative; border-radius: var(--radius-lg); border: 1px solid var(--color-line); background: var(--color-surface); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .tile[data-tone='fault'] { border-color: var(--color-fault); background: var(--color-fault-soft); }
  .tile[data-tone='warn'] { border-color: var(--color-warn); }
  .top { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .mk { font-size: 11px; color: var(--color-on); }
  .tile[data-tone='fault'] .mk { color: var(--color-fault); }
  .tile[data-tone='warn'] .mk { color: var(--color-warn); }
  .tile[data-tone='off'] .mk, .tile[data-tone='stale'] .mk { color: var(--color-text-muted); }
  .nm { font-weight: 600; flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--color-text); text-decoration: none; }
  a.nm::after { content: ''; position: absolute; inset: 0; border-radius: var(--radius-lg); }
  a.nm:hover { text-decoration: underline; }
  .mod { font-size: 11px; color: var(--color-text-muted); white-space: nowrap; flex: none; }
  .val { font-size: 26px; line-height: 1.1; }
  .val small { font-size: var(--text-sm); color: var(--color-text-muted); }
  .bar { height: 6px; border-radius: 3px; background: var(--color-raised); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--color-on); }
  .bar span.hot { background: var(--color-warn); }
  .sp :global(.lc) { background: transparent; padding: 0; }
  .sp :global(svg) { inset: 0; width: 100%; height: 100%; }
  .bot { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 32px; }
  .sub { font-size: 11px; color: var(--color-text-muted); }
  .gr { position: relative; z-index: 1; display: inline-flex; align-items: center; min-height: 32px; font-size: 13px; font-weight: 600; padding: 0 8px; margin: 0 -8px; white-space: nowrap; }
</style>
