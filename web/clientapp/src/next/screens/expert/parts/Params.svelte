<script>
  // Parameters tab (board H28, tab 3): the raw parameter list of every module. Read one parameter, or
  // write one and see what the module really kept (it may refuse or clamp the value).
  import { onMount } from 'svelte'
  import { Card, Button, Chip, Banner, Select, Field, Dialog } from '../../../ui/index.js'
  import { live, toast, project } from '../../../lib/live.svelte.js'
  import { getSchema, getSnapshot, hexIdx, showVal, readParam, writeConfirmed, writable, encode } from './params.js'

  const CAP = 100

  let schema = $state([]) // [{ guid, name, params: [{ name, index, sub, type, options }] }]
  let values = $state({}) // `${guid}|${name}` -> value held in the project copy (= last read / ack from the module)
  let loadErr = $state('')
  let ready = $state(false)
  let modF = $state('all')
  let q = $state('')
  let edits = $state({})
  let res = $state({}) // key -> { k: 'ok'|'warn'|'fault'|'info', t }
  let busy = $state({}) // key -> 'read'|'write'
  let ask = $state(null) // { dev, p, key, input }

  const keyOf = (dev, p) => `${dev.guid}|${p.name}`

  async function load() {
    try {
      const [s, snap] = await Promise.all([getSchema(), getSnapshot()])
      schema = (s.devices ?? []).filter((d) => d.params?.length)
      const v = {}
      for (const d of snap.devices ?? []) for (const [n, val] of Object.entries(d.params ?? {})) v[`${d.guid}|${n}`] = val
      values = v
      loadErr = ''
      ready = true
    } catch (e) { loadErr = e.message }
  }
  onMount(load)

  const sim = $derived(live.adapter === 'Sim')
  const online = (dev) => live.connected && !!live.devices.find((d) => d.guid === dev.guid)?.connected
  const total = $derived(schema.reduce((a, d) => a + d.params.length, 0))
  const matches = $derived.by(() => {
    const t = q.trim().toLowerCase()
    const out = []
    for (const d of schema) {
      if (modF !== 'all' && d.guid !== modF) continue
      for (const p of d.params) {
        if (t && !(p.name + ' ' + d.name + ' ' + hexIdx(p.index, p.sub)).toLowerCase().includes(t)) continue
        out.push({ dev: d, p })
      }
    }
    return out
  })
  const rows = $derived(matches.slice(0, CAP))
  const modItems = $derived([{ value: 'all', label: 'All modules' }, ...schema.map((d) => ({ value: d.guid, label: d.name }))])

  const curVal = (dev, p) => {
    const k = keyOf(dev, p)
    if (k in edits) return edits[k]
    const v = values[k]
    return p.type === 'bool' ? (v ? 'on' : 'off') : v == null ? '' : String(v)
  }
  const setRes = (k, r) => (res[k] = r)
  const MARK = { ok: ['✓', 'var(--color-ok)'], warn: ['■', 'var(--color-warn)'], fault: ['✕', 'var(--color-fault)'], info: ['○', 'var(--color-text-muted)'] }

  async function doRead(dev, p) {
    const k = keyOf(dev, p)
    busy[k] = 'read'
    try {
      const v = await readParam(dev.guid, p)
      values[k] = v; delete edits[k]
      setRes(k, { k: 'info', t: `Read ${showVal(v)} from ${dev.name}.` })
    } catch (e) { setRes(k, { k: 'fault', t: 'Could not read: ' + e.message }) } finally { delete busy[k] }
  }
  function askWrite(dev, p) {
    const k = keyOf(dev, p)
    try { const input = curVal(dev, p); encode(p, input); ask = { dev, p, key: k, input } } catch (e) { setRes(k, { k: 'fault', t: e.message }) }
  }
  async function doWrite() {
    const { dev, p, key, input } = ask
    ask = null
    busy[key] = 'write'
    try {
      const r = await writeConfirmed(dev.guid, p, input)
      values[key] = r.got
      if (r.state === 'ok') delete edits[key] // keep what was typed when the module did not take it, so it can be retried
      project.dirty = true
      setRes(key, { k: r.state === 'ok' ? 'ok' : r.state === 'refused' ? 'fault' : 'warn', t: r.text })
    } catch (e) { setRes(key, { k: 'fault', t: e.message }) } finally { delete busy[key] }
  }
</script>

{#if loadErr}<Banner tone="fault" title="Could not load the parameters.">{loadErr}
  {#snippet actions()}<Button onclick={load}>Try again</Button>{/snippet}
</Banner>{/if}
{#if !live.connected}
  <Banner tone="info" title="Not connected.">Parameters can't be read or written. The values shown are the project's copy.</Banner>
{:else if sim}
  <Banner tone="warn" title="Sim adapter active.">Programming is off: parameter writes are disabled. Reading still works.</Banner>
{/if}

<Card title="Parameters" subtitle={ready ? `${matches.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} parameters` : 'Loading…'}>
  {#snippet actions()}<Button size="sm" onclick={load} data-testid="par-refresh">Refresh values</Button>{/snippet}
  <div class="bar">
    <Select label="Module" items={modItems} bind:value={modF} data-testid="par-module" />
    <Field label="Search by name, module or index" bind:value={q} placeholder="for example output[8].currentLimit" data-testid="par-search" />
  </div>
  {#if ready && !rows.length}<p class="muted" role="status">No parameter matches.</p>{/if}
  <div class="nx-scroll tw">
    <table class="nx-table" data-testid="par-table">
      <thead><tr><th>Parameter</th><th>Module</th><th>Index</th><th>Value</th><th>Actions</th></tr></thead>
      <tbody>
        {#each rows as { dev, p } (dev.guid + p.name)}
          {@const k = keyOf(dev, p)}
          {@const r = res[k]}
          <tr data-param={p.name} data-module={dev.name}>
            <td class="mono nm">{p.name}<div class="muted ty">{p.type}</div></td>
            <td>{dev.name}</td>
            <td class="mono">{hexIdx(p.index, p.sub)}</td>
            <td class="vc">
              {#if p.type === 'bool'}
                <select class="nx-input" aria-label={`Value of ${p.name} on ${dev.name}`} value={curVal(dev, p)} onchange={(e) => (edits[k] = e.target.value)}><option value="on">on</option><option value="off">off</option></select>
              {:else if p.type === 'enum'}
                <select class="nx-input" aria-label={`Value of ${p.name} on ${dev.name}`} value={curVal(dev, p)} onchange={(e) => (edits[k] = e.target.value)}>{#each p.options ?? [] as o (o)}<option value={o}>{o}</option>{/each}</select>
              {:else}
                <input class="nx-input mono" aria-label={`Value of ${p.name} on ${dev.name}`} value={curVal(dev, p)} oninput={(e) => (edits[k] = e.target.value)} readonly={!writable(p)} />
              {/if}
            </td>
            <td><div class="ac">
              <Button size="sm" onclick={() => doRead(dev, p)} busy={busy[k] === 'read'} disabled={!online(dev)} title={online(dev) ? '' : dev.name + ' is not connected.'} aria-label={`Read ${p.name} from ${dev.name}`} data-testid="par-read">Read</Button>
              <Button size="sm" variant="primary" onclick={() => askWrite(dev, p)} busy={busy[k] === 'write'} disabled={!online(dev) || sim || !writable(p)} title={!writable(p) ? 'Labels are stored in the project only.' : sim ? 'Programming is off while the Sim adapter is active.' : online(dev) ? '' : dev.name + ' is not connected.'} aria-label={`Write ${p.name} to ${dev.name}`} data-testid="par-write">Write</Button>
            </div></td>
          </tr>
          <tr class="msg"><td colspan="5">
            <span role="status" class="rs" data-testid="par-result" style="color: {r ? MARK[r.k][1] : 'var(--color-text-muted)'}"><span aria-hidden="true">{r ? MARK[r.k][0] : ''}</span> {r ? r.t : 'Not read or written yet'}</span>
          </td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if matches.length > CAP}<p class="muted">Showing the first {CAP}. Search to narrow the list.</p>{/if}
</Card>

<Dialog open={!!ask} title="Write this parameter?" onclose={() => (ask = null)}
  description={ask ? `${ask.dev.name} · ${ask.p.name} (${hexIdx(ask.p.index, ask.p.sub)}) = ${ask.input}. The module uses it at once and may refuse or change it. It is lost at power-off until you store it with Apply to car.` : ''}>
  {#snippet footer()}
    <Button onclick={() => (ask = null)}>Cancel</Button>
    <Button variant="primary" onclick={doWrite} data-testid="par-confirm">Write</Button>
  {/snippet}
</Dialog>

<style>
  .bar { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: var(--space-3); align-items: end; }
  @media (max-width: 700px) { .bar { grid-template-columns: 1fr; } }
  .tw { max-height: 640px; }
  .nm { word-break: break-all; font-weight: 700; }
  .ty { font-size: 11px; font-weight: 500; }
  .vc { min-width: 160px; }
  .ac { white-space: nowrap; display: flex; gap: var(--space-2); }
  tr.msg td { padding-top: 0; font-size: var(--text-xs); }
  .rs { font-weight: 600; }
</style>
