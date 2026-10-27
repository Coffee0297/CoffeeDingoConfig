<script>
  // Route: hardware/outputs. Every output of every PDM (telemetry) and every CANBoard digital output (/functions),
  // grouped, with live state, a link to each output and a printable wiring list.
  import { Page, PageHeader, Button, Select, Checkbox, StateDot, Banner, Empty } from '../../ui/index.js'
  import { live, api, toast, isPdm, isCanboard } from '../../lib/live.svelte.js'
  import { href, go } from '../../router.svelte.js'
  import { pinFor } from '../../../lib/pinmap.js'
  import { esc, printHtml } from '../../../lib/setupsheet.js'
  import { signalFeed } from './parts/feeds.svelte.js'

  // ---- CANBoard outputs and the names of their drivers ----
  let cb = $state({})      // guid -> { rows: digitalOut[], names: Map index -> name }
  let cbErr = $state('')
  const cbGuids = $derived(live.devices.filter(isCanboard).map((d) => d.guid).join(','))
  $effect(() => {
    const guids = cbGuids ? cbGuids.split(',') : []
    let alive = true
    Promise.all(guids.map(async (g) => {
      const [fx, vm] = await Promise.all([api.functions(g), api.inputs(g)])
      return [g, { rows: fx?.digitalOut ?? [], names: Object.fromEntries((vm ?? []).map((v) => [v.index, v.name])) }]
    })).then((list) => { if (alive) { cb = Object.fromEntries(list); cbErr = '' } }).catch((e) => { if (alive) cbErr = e?.message ?? String(e) })
    return () => { alive = false }
  })
  // CANBoard live states: one /signals poll per CANBoard module.
  const feeds = $derived(live.devices.filter(isCanboard).map((d) => d.guid))
  const f1 = signalFeed(() => feeds[0] ?? '', 500)
  const f2 = signalFeed(() => feeds[1] ?? '', 500)
  const f3 = signalFeed(() => feeds[2] ?? '', 500)
  const feedFor = (g) => [f1, f2, f3][feeds.indexOf(g)]

  let groupBy = $state('module'), showSpare = $state(false)

  const rows = $derived.by(() => {
    const out = []
    for (const d of [...live.devices].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      if (isPdm(d)) {
        for (const o of d.outputs ?? []) {
          const p = pinFor(d, 'output', o.number)
          out.push({ key: d.guid + ':' + o.number, guid: d.guid, mod: d.name, modOnline: !!d.connected, n: o.number, label: 'o' + o.number, pin: p?.label ?? '', name: o.name?.trim() || '', spare: !o.enabled,
            limit: o.enabled ? `${o.currentLimit} A` : '', driven: o.enabled && o.input && o.input !== 'None' ? o.input : '', state: o.state, amps: o.current, on: o.state === 'On',
            wire: { color: o.wireColor, stripe: o.wireStripe, mm2: o.wireGaugeMm2, len: o.wireLength } })
        }
      } else if (isCanboard(d)) {
        const c = cb[d.guid]
        for (const o of c?.rows ?? []) {
          const p = pinFor(d, 'output', o.number)
          const s = feedFor(d.guid)?.get('Digital output', o.name)
          out.push({ key: d.guid + ':' + o.number, guid: d.guid, mod: d.name, modOnline: !!d.connected, n: o.number, label: 'DO' + o.number, pin: p?.label ?? '', name: o.name?.trim() || '', spare: !o.enabled,
            limit: o.enabled ? 'low-side' : '', driven: o.enabled && o.input ? (c.names[o.input] ?? '#' + o.input) : '', state: s ? (s.on ? 'On' : 'Off') : '', amps: null, on: !!s?.on,
            wire: null, cb: true })
        }
      }
    }
    return out
  })
  const shown = $derived(rows.filter((r) => showSpare || !r.spare))
  const nSpare = $derived(rows.filter((r) => r.spare).length)
  const nMods = $derived(new Set(shown.map((r) => r.guid)).size)

  const groups = $derived.by(() => {
    if (groupBy === 'none') return [{ title: '', rows: [...shown].sort((a, b) => (a.name || '~').localeCompare(b.name || '~')) }]
    if (groupBy === 'state') {
      const order = ['Fault', 'Overcurrent', 'Warning', 'OpenLoad', 'Undercurrent', 'On', 'Off', '']
      const map = new Map(order.map((k) => [k, []]))
      for (const r of shown) (map.get(order.includes(r.state) ? r.state : '') ?? map.get('')).push(r)
      return order.filter((k) => map.get(k).length).map((k) => ({ title: (k || 'No live data') + ' · ' + map.get(k).length, rows: map.get(k) }))
    }
    const m = new Map()
    for (const r of shown) { if (!m.has(r.mod)) m.set(r.mod, []); m.get(r.mod).push(r) }
    return [...m].map(([mod, rs]) => ({ title: '', mod, rows: rs }))
  })

  function nowText(r) {
    if (!live.connected) return { t: 'No data', tone: 'stale', shape: 'ring' }
    if (!r.modOnline) return { t: 'Not found', tone: 'fault', shape: 'square' }
    if (!r.state) return { t: 'Reading…', tone: 'stale', shape: 'ring' }
    const a = r.amps != null ? ` · ${Number(r.amps).toFixed(1)} A` : ''
    if (r.state === 'On') return { t: 'On' + a, tone: 'on', shape: 'dot' }
    if (r.state === 'Off') return { t: 'Off', tone: 'off', shape: 'ring' }
    return { t: r.state + a, tone: r.state === 'Fault' || r.state === 'Overcurrent' ? 'fault' : 'warn', shape: r.state === 'Warning' || r.state === 'OpenLoad' || r.state === 'Undercurrent' ? 'triangle' : 'square' }
  }

  const GROUPS = [{ value: 'module', label: 'Module' }, { value: 'state', label: 'State' }, { value: 'none', label: 'Load name (A to Z)' }]
  function printList() {
    const body = shown.map((r) => `<tr><td>${esc(r.mod)}</td><td>${esc(r.label)}</td><td>${esc(r.pin)}</td><td>${esc(r.name)}</td><td>${esc(r.limit)}</td>`
      + `<td>${r.wire ? esc([r.wire.color, r.wire.stripe && '/ ' + r.wire.stripe].filter(Boolean).join(' ')) : ''}</td><td>${r.wire?.mm2 ? esc(r.wire.mm2 + ' mm²') : ''}</td><td>${r.wire?.len ? esc(r.wire.len + ' m') : ''}</td></tr>`).join('')
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wiring list</title><style>body{font-family:sans-serif}table{border-collapse:collapse;width:100%}th,td{border:1px solid;padding:4px 8px;text-align:left;font-size:12px}</style></head>`
      + `<body><h1>Wiring list</h1><p>${shown.length} outputs on ${nMods} modules. ${new Date().toLocaleDateString()}</p><table><thead><tr><th>Module</th><th>Out</th><th>Pin</th><th>Load</th><th>Limit</th><th>Wire colour</th><th>Gauge</th><th>Length</th></tr></thead><tbody>${body}</tbody></table>\x3cscript>window.onload=function(){window.print()}\x3c/script></body></html>`
    if (!printHtml(html)) toast('The browser blocked the print window. Allow pop-ups for this page and try again.', 'error', 8000)
  }
</script>

<Page wide>
  <PageHeader title="Every output on the car" subtitle={`${shown.length} outputs on ${nMods} module${nMods === 1 ? '' : 's'} · click one to open it${!showSpare && nSpare ? ` · ${nSpare} spare hidden` : ''}`}>
    {#snippet actions()}
      <Select label="Group by" items={GROUPS} bind:value={groupBy} data-testid="group-by" />
      <Checkbox bind:checked={showSpare} label="Show spare outputs" />
      <Button onclick={printList} disabled={!shown.length} data-testid="print">Print wiring list</Button>
    {/snippet}
  </PageHeader>

  {#if !live.connected}
    <Banner tone="warn" title="Not connected to the car">The list comes from the project. Live state shows when you connect.</Banner>
  {/if}
  {#if cbErr}<Banner tone="fault" title="Could not read the CANBoard outputs">{cbErr}</Banner>{/if}

  {#if !live.devices.length}
    <Empty title="No modules in the project" text="Add a module in Hardware first." />
  {:else if !shown.length}
    <Empty title="No outputs to show" text="Every output is spare. Tick Show spare outputs to see them." />
  {:else}
    <div class="nx-card tbl nx-scroll">
      <table class="nx-table" data-testid="outputs-table">
        <thead><tr><th>Module</th><th>Out</th><th>Pin</th><th>Load</th><th>Limit</th><th>Driven by</th><th>Now</th></tr></thead>
        {#each groups as g (g.title + (g.mod ?? ''))}
          <tbody>
            {#if g.title}<tr class="grp"><th colspan="7">{g.title}</th></tr>{/if}
            {#each g.rows as r, i (r.key)}
              {@const nw = nowText(r)}
              <tr class="row" class:first={i === 0 && groupBy === 'module'} class:spare={r.spare} data-testid="out-row" onclick={() => go('hardware', 'module', r.guid, 'output', r.n)}>
                <td>{#if groupBy !== 'module' || i === 0}<strong>{r.mod}</strong>{/if}</td>
                <td class="mono">{r.label}</td>
                <td class="mono">{r.pin}</td>
                <td><a href={href('hardware', 'module', r.guid, 'output', r.n)} data-testid="out-link">{r.name || (r.spare ? 'Spare' : 'Output ' + r.n)}<span class="sr-only"> on {r.mod}, output {r.n}</span></a></td>
                <td class="mono">{r.limit}</td>
                <td>{r.driven || (r.spare ? '' : 'Nothing')}</td>
                <td><StateDot tone={nw.tone} shape={nw.shape} label={nw.t} /></td>
              </tr>
            {/each}
          </tbody>
        {/each}
      </table>
    </div>
  {/if}
</Page>

<style>
  .tbl { padding: 0; }
  tr.row { cursor: pointer; }
  tr.row:hover { background: var(--color-raised); }
  tr.first td { border-top: 2px solid var(--color-line-strong); }
  tr.spare td { color: var(--color-text-muted); }
  .grp th { background: var(--color-raised); font-size: var(--text-sm); text-transform: none; letter-spacing: 0; color: var(--color-text); }
  td a { color: var(--color-text); }
</style>
