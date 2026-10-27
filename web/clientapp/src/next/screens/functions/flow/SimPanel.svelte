<script>
  /**
   * Simulate panel: switch the inputs this module's logic reads, inject faults, and see what the outputs
   * do. Everything runs in the browser (sim.js); nothing is sent to the car.
   */
  import { Banner, Segmented } from '../../../ui/index.js'
  import { SOURCE_KINDS } from './sim.js'
  import { fmt } from './livevals.js'

  let { model, sim, lv, onchange } = $props()   // onchange: the builder recomputes its live values (lv is read only here)
  // sources that something on this module actually reads
  const sources = $derived([...model.nodes.values()].filter((n) => (SOURCE_KINDS.has(n.kind) || n.disabledSource) && n.outs.some((p) => model.consumers.has(p.idx))))
  const outputs = $derived([...model.nodes.values()].filter((n) => n.kind === 'output' || n.kind === 'digitaloutput' || n.kind === 'canoutput').filter((n) => n.enabled))
  const canIns = $derived([...model.nodes.values()].filter((n) => n.kind === 'caninput' && n.enabled && n.outs.some((p) => model.consumers.has(p.idx))))
  let faultSel = $state({})

  function range(n, p) {
    if (n.kind === 'analoginput') return p.prop === 'Rotary Position' ? [0, Math.max(1, (n.row?.rotary?.numPos ?? 2) - 1), 1] : [0, 5000, 10]
    if (n.kind === 'sys') return p.prop === 'Value' && /Battery/.test(p.label) ? [8, 16, 0.1] : [-20, 120, 1]
    return [0, 1000, 1]
  }
  const posName = (n, v) => n.row?.rotary?.positionNames?.[v] ?? null
  function setBool(p, v) { sim.set(p.idx, v); sim.step(0); onchange() }
  function setNum(p, v) { sim.set(p.idx, Number(v) || 0); onchange() }
  function setCan(n, v) { sim.setCan(n.id, Number(v) || 0); onchange() }
  function setFault(n, f) { faultSel[n.id] = f; sim.fault(n.id, f); onchange() }
  const canMax = (n) => Math.min(100000, Math.max(1, (2 ** Math.min(20, n.row?.bitLength ?? 8) - 1) * (n.row?.factor || 1)))
  const OUT_FAULTS = [{ value: 'none', label: '○ No fault' }, { value: 'oc', label: '■ Overcurrent' }, { value: 'open', label: '▲ Open load' }]
  // only where an undercurrent limit is set (upstream output subs 27-29)
  const faultsOf = (n) => (n.row?.underLimit > 0 ? [...OUT_FAULTS, { value: 'under', label: '▼ Too little current' }] : OUT_FAULTS)
</script>

<section class="sim" aria-label="Simulate inputs">
  <Banner tone="warn" title="Simulating: nothing is sent to the car">Change the inputs below; blocks, wires and outputs update in the browser only.</Banner>

  <span class="sec">INPUTS THIS LOGIC READS</span>
  {#if !sources.length && !canIns.length}<p class="muted">Nothing on this module reads an input yet.</p>{/if}
  <div class="grid">
    {#each canIns as n (n.id)}
      {@const vIdx = n.outs.find((p) => p.prop === 'Value')?.idx}
      {@const sIdx = n.outs.find((p) => p.prop === 'State')?.idx}
      {#if (n.row?.bitLength ?? 8) <= 1}
        <button type="button" class="tg" aria-pressed={lv.v[sIdx] === true} onclick={() => setCan(n, lv.v[vIdx] ? 0 : 1)}>{n.title}: {lv.v[sIdx] ? 'on' : 'off'}</button>
      {:else}
        <label class="rg"><span>{n.title} <span class="mono">{fmt(lv.v[vIdx])}</span> <span class="muted">→ {lv.v[sIdx] ? 'on' : 'off'}</span></span>
          <input type="range" min="0" max={canMax(n)} step={n.row?.factor && n.row.factor < 1 ? n.row.factor : 1} value={lv.v[vIdx] ?? 0} oninput={(e) => setCan(n, e.currentTarget.value)} aria-label={n.title + ' value'} /></label>
      {/if}
    {/each}
    {#each sources as n (n.id)}
      {#each n.outs.filter((p) => model.consumers.has(p.idx)) as p (p.id)}
        {#if p.type === 'bool'}
          <button type="button" class="tg" aria-pressed={lv.v[p.idx] === true} onclick={() => setBool(p, !(lv.v[p.idx] === true))}>{n.kind === 'sys' || n.kind === 'lua' ? p.label : n.title}{n.outs.length > 1 && n.kind !== 'sys' && n.kind !== 'lua' ? ' ' + p.label.toLowerCase() : ''}: {lv.v[p.idx] ? 'on' : 'off'}</button>
        {:else}
          {@const [lo, hi, st] = range(n, p)}
          <label class="rg"><span>{n.kind === 'sys' || n.kind === 'lua' ? p.label : n.title + ' ' + p.label.toLowerCase()} <span class="mono">{fmt(lv.v[p.idx])}</span>{#if posName(n, lv.v[p.idx])} <span class="muted">({posName(n, lv.v[p.idx])})</span>{/if}</span>
            <input type="range" min={lo} max={hi} step={st} value={lv.v[p.idx] ?? lo} oninput={(e) => setNum(p, e.currentTarget.value)} aria-label={n.title + ' ' + p.label} /></label>
        {/if}
      {/each}
    {/each}
  </div>

  <span class="sec">INJECT A FAULT</span>
  {#each outputs.filter((n) => n.kind !== 'canoutput') as n (n.id)}
    <div class="fr"><span class="fn">{n.title}</span><Segmented label={'Fault on ' + n.title} items={faultsOf(n)} value={faultSel[n.id] ?? 'none'} onchange={(v) => setFault(n, v)} size="sm" /></div>
  {/each}
  {#each canIns as n (n.id)}
    <div class="fr"><span class="fn">{n.title}</span><Segmented label={'Fault on ' + n.title} items={[{ value: 'none', label: '○ Frames arrive' }, { value: 'timeout', label: '◇ CAN timeout' }]} value={faultSel[n.id] ?? 'none'} onchange={(v) => setFault(n, v)} size="sm" /></div>
  {/each}

  <span class="sec">WHAT THE OUTPUTS DO</span>
  {#each outputs as n (n.id)}
    {@const st = lv.st[n.id]}
    <div class="oc" data-tone={st?.tone ?? 'off'} role="status">
      <span class="sym" aria-hidden="true">{st?.tone === 'fault' ? '■' : st?.tone === 'warn' ? '▲' : st?.tone === 'on' ? '●' : '○'}</span>
      <span class="ot"><strong>{n.title}</strong> <span class="mono">{st?.text ?? '—'}</span><span class="muted why">{st?.why ?? ''}</span></span>
    </div>
  {/each}
</section>

<style>
  .sim { display: flex; flex-direction: column; gap: var(--space-2); }
  .sec { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--color-warn); margin-top: var(--space-2); }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .tg { min-height: 44px; border-radius: var(--radius-md); border: 1px solid var(--color-line-strong); background: var(--color-raised); color: var(--color-text); font-weight: 600; padding: 4px 8px; text-align: left; }
  .tg[aria-pressed='true'] { background: var(--color-on-soft); border-color: var(--color-on); }
  .rg { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 4px; font-weight: 600; }
  .rg input { accent-color: var(--color-accent); min-height: 28px; }
  .fr { display: flex; flex-direction: column; gap: 4px; }
  .fn { font-size: var(--text-xs); font-weight: 600; }
  .oc { display: flex; gap: 8px; padding: 8px 10px; border-radius: var(--radius-md); border: 1px solid var(--color-line); background: var(--color-raised); }
  .oc[data-tone='fault'] { border-color: var(--color-fault); background: var(--color-fault-soft); }
  .oc[data-tone='warn'] { border-color: var(--color-warn); background: var(--color-warn-soft); }
  .oc[data-tone='on'] .sym { color: var(--color-on); }
  .oc[data-tone='fault'] .sym { color: var(--color-fault); }
  .oc[data-tone='warn'] .sym { color: var(--color-warn); }
  .ot { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .why { font-size: var(--text-xs); }
</style>
