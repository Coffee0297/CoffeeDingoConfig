<script>
  // CAN map tab (board H28, tab 1): who owns which CAN id, how often it appears, and what clashes.
  import { onMount } from 'svelte'
  import { Card, Button, Chip, Banner, StateDot, Empty } from '../../../ui/index.js'
  import { live, api } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import { buildRows, STATUS, hx } from './canmap.js'

  let map = $state(null)
  let log = $state([])
  let rates = $state({}) // key -> { hz, last }
  let loadErr = $state('')
  let filter = $state('all')
  let selId = $state(null)
  let now = $state(Date.now())

  const prev = {}
  async function poll() {
    try {
      const [m, l] = await Promise.all([api.canIdMap(), api.canlog()])
      map = m; loadErr = ''
      const t = Date.now()
      const next = { ...rates }
      const total = {}
      for (const e of l ?? []) {
        const k = (e.ide ? 'x' : '') + e.id
        total[k] = (total[k] ?? 0) + e.count
      }
      for (const [k, c] of Object.entries(total)) {
        const p = prev[k]
        if (p) {
          const dt = (t - p.t) / 1000
          if (dt > 0.2) {
            const hz = Math.max(0, (c - p.c) / dt)
            next[k] = { hz: next[k]?.hz != null ? next[k].hz * 0.5 + hz * 0.5 : hz, last: c > p.c ? t : (next[k]?.last ?? null) }
            prev[k] = { c, t }
          }
        } else prev[k] = { c, t }
      }
      rates = next
      log = l ?? []
    } catch (e) { loadErr = e.message }
  }
  onMount(() => {
    poll()
    const a = setInterval(poll, 2000)
    const b = setInterval(() => (now = Date.now()), 1000)
    return () => { clearInterval(a); clearInterval(b) }
  })

  const rows = $derived(map ? buildRows({ map, log, devices: live.devices, rates }) : [])
  const shown = $derived(rows.filter((r) => filter === 'all' || (filter === 'clash' ? r.status === 'clash' : r.kind === filter)))
  const sel = $derived(rows.find((r) => r.rid === selId) ?? rows.find((r) => r.status === 'clash') ?? rows[0])
  const clashes = $derived(rows.filter((r) => r.status === 'clash').length)
  const idCount = $derived(rows.filter((r) => r.kind !== 'res').reduce((a, r) => a + r.count, 0))
  const rangeText = (r) => (r.lo === r.hi ? hx(r.lo, r.ide) : `${hx(r.lo, r.ide)} to ${hx(r.hi, r.ide)}`)
  const rateText = (r) => (!live.connected ? 'not seen' : r.hz == null ? (r.seen ? 'measuring…' : 'none') : r.hz < 0.05 ? 'quiet' : (r.count > 1 ? 'each ' : '') + (r.hz >= 10 ? Math.round(r.hz) : r.hz.toFixed(1)) + ' Hz')
  const lastText = (r) => { if (!live.connected || !r.last) return r.kind === 'res' ? 'none' : 'not seen'; const s = Math.round((now - r.last) / 1000); return s < 2 ? 'just now' : s + ' s ago' }
  const kindName = { mod: 'dingo module', ecu: 'ECU frame (from a DBC)', unknown: 'Unknown sender', res: 'Reserved range' }
  const filters = [['all', 'All'], ['mod', 'Modules'], ['ecu', 'ECU'], ['unknown', 'Unknown'], ['res', 'Reserved'], ['clash', 'Clashes']]
  const fixLinks = (r) => (r.status === 'clash' ? live.devices.filter((d) => r.owners.some((o) => o.startsWith(d.name + ':'))) : [])
  const glyph = { mod: '●', ecu: '◆', unknown: '△' }
  // the bar shows the used stretch (padded, on 0x10 steps) unless "Whole range" is on: 162 ids in 0x600..0x7FF
  // crowd into the right 15 % of 0x000..0x7FF
  let whole = $state(false)
  const used = $derived(rows.filter((r) => !r.ide && r.kind !== 'res' && r.lo <= 0x7ff))
  const view = $derived.by(() => {
    if (whole || !used.length) return { lo: 0, hi: 0x7ff }
    const a = Math.min(...used.map((r) => r.lo)), b = Math.max(...used.map((r) => r.hi ?? r.lo))
    const pad = Math.max(0x10, Math.round((b - a) * 0.05))
    const lo = Math.max(0, Math.floor((a - pad) / 0x10) * 0x10), hi = Math.min(0x7ff, Math.ceil((b + pad + 1) / 0x10) * 0x10 - 1)
    return { lo, hi }
  })
  const at = (id) => ((id - view.lo) / Math.max(1, view.hi - view.lo)) * 100
  const marks = $derived(used.map((r) => ({ left: at(r.lo), g: r.status === 'clash' ? '■' : glyph[r.kind] ?? '●', bad: r.status === 'clash' })))
  const obd = $derived(view.hi >= 0x7df && view.lo <= 0x7ef ? { left: at(Math.max(0x7df, view.lo)), width: at(Math.min(0x7ef, view.hi) + 1) - at(Math.max(0x7df, view.lo)) } : null)
</script>

{#if loadErr}<Banner tone="fault" title="Could not load the CAN map.">{loadErr}</Banner>{/if}

<Card title="CAN ID map" subtitle={`${idCount} ids in use · showing ${hx(view.lo)} to ${hx(view.hi)}`}>
  {#snippet actions()}<Button size="sm" aria-pressed={whole} onclick={() => (whole = !whole)} data-testid="can-whole-range">Whole range</Button>{/snippet}
  {#snippet tag()}{#if clashes}<Chip tone="fault" symbol="■" data-testid="can-clash-count">{clashes} {clashes === 1 ? 'clash' : 'clashes'}</Chip>{:else}<Chip tone="ok" symbol="✓" data-testid="can-clash-count">No clashes</Chip>{/if}{/snippet}
  <div class="strip" role="img" aria-label={`CAN ID map from ${hx(view.lo)} to ${hx(view.hi)}. ${idCount} ids in use. ${clashes ? clashes + ' clash.' : 'No clashes.'} OBD-II reserved 0x7DF to 0x7EF.`}>
    {#if obd}<div class="obd" style="left: {obd.left}%; width: {obd.width}%"></div>{/if}
    {#each marks as m, i (i)}<span class="mk" class:bad={m.bad} style="left: {m.left}%" aria-hidden="true">{m.g}</span>{/each}
  </div>
  <div class="scale muted" aria-hidden="true"><span>{hx(view.lo)}</span><span>{hx(Math.round((view.lo + view.hi) / 2))}</span><span>{hx(view.hi)}</span></div>
  <p class="muted lg">● dingo module · ◆ ECU frame · △ unknown sender · ■ clash · shaded = OBD-II reserved</p>
</Card>

<div class="cols">
  <Card title="Ids" subtitle="Neighbouring ids with the same owner are one line">
    {#snippet actions()}
      <div class="flt" role="group" aria-label="Filter ids">
        {#each filters as [value, label] (value)}<button class="fb" aria-pressed={filter === value} onclick={() => (filter = value)} data-testid="can-filter-{value}">{label}</button>{/each}
      </div>
    {/snippet}
    {#if !map}<p class="muted" role="status">Reading the map…</p>
    {:else if !shown.length}<Empty title="Nothing here" text="No id matches this filter." />
    {:else}
      <div class="nx-scroll tw">
        <table class="nx-table" data-testid="can-table">
          <thead><tr><th>Id</th><th>Owner</th><th>Rate</th><th>Last seen</th><th>State</th></tr></thead>
          <tbody>
            {#each shown as r (r.rid)}
              {@const st = STATUS[r.status]}
              <tr class:on={r.rid === sel?.rid} data-status={r.status}>
                <td><button class="pick mono" aria-pressed={r.rid === sel?.rid} onclick={() => (selId = r.rid)}>{rangeText(r)}</button></td>
                <td>{r.owners.length ? r.owners.join(', ') : 'Nobody in the project'}{#if r.count > 1} <span class="muted">· {r.count} frames</span>{/if}</td>
                <td class="mono">{rateText(r)}</td>
                <td class="mono muted">{lastText(r)}</td>
                <td><Chip tone={st.tone} symbol={st.mark}>{st.word}</Chip></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>

  <Card title={sel ? rangeText(sel) : 'Selected id'} subtitle={sel ? kindName[sel.kind] : ''}>
    {#if sel}
      {@const st = STATUS[sel.status]}
      <div data-testid="can-detail" class="det">
        <StateDot tone={sel.status === 'clash' ? 'fault' : sel.status === 'ok' ? 'on' : 'warn'} shape={sel.status === 'clash' ? 'square' : sel.status === 'ok' ? 'dot' : 'ring'} label={st.word} />
        <dl>
          <dt>Owner</dt><dd>{sel.owners.length ? sel.owners.join(', ') : 'Nobody in the project'}</dd>
          <dt>Rate</dt><dd class="mono">{rateText(sel)}</dd>
          <dt>Last seen</dt><dd class="mono">{lastText(sel)}</dd>
        </dl>
        {#if sel.why}<Banner tone={sel.status === 'clash' ? 'fault' : 'warn'}>{sel.why}</Banner>{:else}<p class="muted">Nothing is wrong with this id.</p>{/if}
        {#each fixLinks(sel) as d (d.guid)}<Button href={href('hardware', 'module', d.guid)}>Change the base ID of {d.name}…</Button>{/each}
      </div>
    {/if}
  </Card>
</div>

<style>
  .strip { position: relative; height: 34px; border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-raised); overflow: hidden; }
  .obd { position: absolute; top: 0; bottom: 0; background: var(--color-warn-soft); border-left: 2px dashed var(--color-warn); min-width: 4px; }
  .mk { position: absolute; top: 8px; transform: translateX(-50%); font-size: 12px; color: var(--color-text); line-height: 1; }
  .mk.bad { color: var(--color-fault); font-size: 17px; top: 5px; }
  .scale { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 11px; }
  .lg { font-size: var(--text-xs); }
  .flt { display: flex; flex-wrap: wrap; gap: 2px; padding: 4px; border-radius: var(--radius-md); background: var(--color-raised); }
  .fb { min-height: 36px; padding: 0 var(--space-3); border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--color-text-muted); font-weight: 600; }
  .fb[aria-pressed='true'] { background: var(--color-surface); color: var(--color-text); border-color: var(--color-line-strong); }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: var(--space-4); align-items: start; }
  @media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } }
  .tw { max-height: 560px; }
  tr.on td { background: var(--color-raised); }
  tr[data-status='clash'] td:first-child { box-shadow: inset 4px 0 0 var(--color-fault); }
  .pick { background: transparent; border: 0; padding: 6px 0; min-height: 32px; font-weight: 700; text-align: left; text-decoration: underline; text-underline-offset: 3px; }
  .det { display: flex; flex-direction: column; gap: var(--space-3); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px var(--space-3); margin: 0; }
  dt { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: 600; }
  dd { margin: 0; }
</style>
