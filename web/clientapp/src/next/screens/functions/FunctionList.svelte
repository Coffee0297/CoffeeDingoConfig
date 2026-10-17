<script>
  // Functions: what the car does, grouped by system. Applied templates are "function blocks"; every other
  // enabled output is read from the module blocks (helper / blocks / custom code). Live state comes from the
  // 10 Hz telemetry. Remove / turn off / duplicate work on every function: a template's through its record, a
  // hand-built one on its outputs and the blocks that feed them (parts/handbuilt.js).
  import { untrack } from 'svelte'
  import { Page, PageHeader, Button, Chip, Banner, Empty, Dialog, Select, Field } from '../../ui/index.js'
  import { spareOutputs } from './parts/handbuilt.js'
  import { live } from '../../lib/live.svelte.js'
  import { href } from '../../router.svelte.js'
  import { templateInstances } from '../../../lib/store.js'
  import { SYSTEMS, systemName } from './parts/catalog.js'
  import { createModel } from './parts/model.svelte.js'
  import FunctionRow from './parts/FunctionRow.svelte'
  import FunctionPanel from './parts/FunctionPanel.svelte'

  const M = createModel()
  const m = M.m

  let q = $state(''), chip = $state('all'), selectedId = $state('')
  let confirmRemove = $state(false), confirmOn = $state(false)
  // Duplicate of a hand-built function: a spare output and a name
  let dup = $state(null)
  function askDuplicate() { const r = selected; const spares = spareOutputs(r); dup = { row: r, spares, target: spares[0] ? spares[0].guid + '|' + spares[0].n : '', name: r.name + ' 2' } }
  async function doDuplicate() {
    const d = dup, t = d.spares.find((x) => x.guid + '|' + x.n === d.target)
    dup = null
    if (t && (await M.duplicate(d.row, t, d.name.trim() || d.row.name + ' 2'))) selectedId = ''
  }

  // reload when modules appear / disappear or the applied list changes (an agent may apply templates too)
  // (derived values only notify when they change; reading live.devices in the effect would re-run it at 10 Hz)
  // and when an output's name, driver or on/off changes (an edit here or anywhere else lands on the next poll)
  const modKey = $derived(live.devices.map((d) => d.guid + d.connected + (d.outputs ?? []).map((o) => `${o.name}|${o.inputVal}|${o.enabled}`).join()).join())
  $effect(() => { modKey; $templateInstances; if (modKey) untrack(() => M.load()) })
  $effect(() => { untrack(() => M.syncTemplates()) })

  const states = $derived(Object.fromEntries(m.rows.map((r) => [r.id, M.stateOf(r)])))
  const text = (r) => [r.name, r.sentence, r.tag, r.modules.join(' '), ...r.outputs.flatMap((o) => [o.name, o.module, o.pin, o.pin && o.pin.replace('-', ' '), 'o' + o.n])].join(' ').toLowerCase()
  const matches = $derived(m.rows.filter((r) => {
    const t = q.trim().toLowerCase()
    if (t && !t.split(/\s+/).every((w) => text(r).includes(w))) return false
    if (chip === 'all') return true
    if (chip === 'on') return states[r.id]?.on
    if (chip === 'custom') return r.kind === 'lua'
    return r.system === chip
  }))
  const groups = $derived(SYSTEMS.map((s) => ({ ...s, rows: matches.filter((r) => r.system === s.key) })).filter((g) => g.rows.length))
  const count = (f) => m.rows.filter(f).length
  const chips = $derived([
    { key: 'all', name: 'All', n: m.rows.length },
    ...SYSTEMS.map((s) => ({ key: s.key, name: s.name, n: count((r) => r.system === s.key) })).filter((c) => c.n),
    { key: 'custom', name: 'Custom code', n: count((r) => r.kind === 'lua') },
    { key: 'on', name: 'On now', n: count((r) => states[r.id]?.on) },
  ])
  const selected = $derived(m.rows.find((r) => r.id === selectedId) ?? matches[0] ?? null)
  const kinds = (k) => count((r) => r.kind === k)
  const moduleCount = $derived(new Set(m.rows.flatMap((r) => r.modules)).size)
  const subtitle = $derived(m.rows.length ? `${m.rows.length} functions · ${count((r) => states[r.id]?.on)} on now` : 'What the car does')
  const breakdown = $derived(`On ${moduleCount} modules. Made of ${kinds('fn')} from templates, ${kinds('helper')} helpers, ${kinds('blocks')} groups of blocks and ${kinds('lua')} custom code (Lua).`)

  async function turn(row, enable) { if (enable) { confirmOn = true; return } await M.setEnabled(row, false) }
  async function doRemove() { const r = selected; confirmRemove = false; if (r) await M.remove(r) }
  async function doOn() { const r = selected; confirmOn = false; if (r) await M.setEnabled(r, true) }
</script>

<Page wide>
  <PageHeader title="Functions" {subtitle}>
    {#snippet tag()}{#if m.rows.length}<span class="info" title={breakdown} aria-label={breakdown} role="img" data-testid="fn-breakdown">i</span>{/if}{/snippet}
    {#snippet actions()}
      <label class="srch"><span class="sr-only">Search functions</span>
        <input class="nx-input" type="search" bind:value={q} placeholder="name, signal, pin (J3-7), module" aria-label="Search functions" data-testid="fn-search" />
      </label>
      <Button href={href('functions', 'cross-module')} data-testid="cross-module-link" title="A switch on one module drives outputs on other modules">Cross-module</Button>
      <Button variant="primary" href={href('functions', 'add')} data-testid="add-function">+ Add function</Button>
    {/snippet}
  </PageHeader>

  {#if !live.connected}
    <Banner tone="warn" title="Not connected">Showing the project as saved. Live state needs a connection.</Banner>
  {/if}
  {#if m.error}<Banner tone="fault" title="Could not read the modules">{m.error}</Banner>{/if}

  {#if m.loading}
    <p class="muted" role="status">Reading the modules…</p>
  {:else if !m.rows.length}
    <Empty title="No functions yet" text="Pick a ready-made function and the app builds the blocks for you.">
      {#snippet actions()}<Button variant="primary" href={href('functions', 'add')}>+ Add function</Button>{/snippet}
    </Empty>
  {:else}
    <div class="chips" role="group" aria-label="Filter by system">
      {#each chips as c (c.key)}
        <button type="button" class="chip" class:on={chip === c.key} aria-pressed={chip === c.key} onclick={() => (chip = c.key)}>{c.name}<span class="mono n">{c.n}</span></button>
      {/each}
    </div>
    <div class="cols">
      <div class="list">
        {#each groups as g (g.key)}
          <section aria-label={g.name}>
            <h2 class="gh">{g.name.toUpperCase()}</h2>
            <div class="rows">
              {#each g.rows as r (r.id)}
                <FunctionRow row={r} st={states[r.id]} selected={selected?.id === r.id} busy={m.busy}
                  onselect={() => (selectedId = r.id)} ontoggle={(v) => { selectedId = r.id; turn(r, v) }} />
              {/each}
            </div>
          </section>
        {:else}
          <Empty title="Nothing matches" text="Try a shorter search or another system." />
        {/each}
      </div>
      {#if selected}
        <FunctionPanel row={selected} st={states[selected.id]} busy={m.busy} onremove={() => (confirmRemove = true)} onturn={(enabled) => turn(selected, !enabled)} onduplicate={askDuplicate} />
      {/if}
    </div>
  {/if}
</Page>

<Dialog bind:open={confirmRemove} title={`Remove “${selected?.name ?? ''}”?`} description="This changes the modules right away.">
  <p>{selected?.inst ? 'Its blocks are switched off and its outputs go back to what they did before.' : 'Its outputs are switched off and unwired, and the blocks only it uses are switched off. Inputs and blocks other functions also use stay.'} Other functions are not touched.</p>
  <p class="muted">If a module is off the bus, the change is kept in the project and sent when it is back (Apply).</p>
  {#snippet footer()}
    <Button onclick={() => (confirmRemove = false)}>Cancel</Button>
    <Button variant="danger" onclick={doRemove} data-testid="confirm-remove">Remove function</Button>
  {/snippet}
</Dialog>

<Dialog open={!!dup} onclose={() => (dup = null)} title={`Duplicate “${dup?.row.name ?? ''}”`} description="Its blocks are copied into free slots and drive a spare output. The inputs it reads are shared.">
  {#if dup?.spares.length}
    <Select label="Spare output" items={dup.spares.map((x) => ({ value: x.guid + '|' + x.n, label: x.label }))} bind:value={dup.target} data-testid="dup-output" />
    <Field label="Name" bind:value={dup.name} data-testid="dup-name" />
  {:else}
    <p>No spare output on {dup?.row.modules.join(', ')}: every output is in use or switched on. Free one on its Hardware page first.</p>
  {/if}
  {#snippet footer()}
    <Button onclick={() => (dup = null)}>Cancel</Button>
    <Button variant="primary" disabled={!dup?.target} onclick={doDuplicate} data-testid="dup-go">Duplicate</Button>
  {/snippet}
</Dialog>

<Dialog bind:open={confirmOn} title={`Enable “${selected?.name ?? ''}”?`} description="Its outputs will switch again when their signals say so.">
  <p>Loads on {selected?.modules.join(', ')} can start straight away. Make sure nothing is connected that should not run.</p>
  {#snippet footer()}
    <Button onclick={() => (confirmOn = false)}>Cancel</Button>
    <Button variant="primary" onclick={doOn} data-testid="confirm-on">Enable function</Button>
  {/snippet}
</Dialog>

<style>
  .srch { width: min(380px, 100%); }
  .info { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--color-line-strong); font-size: 12px; font-weight: 700; font-style: italic; color: var(--color-text-muted); cursor: help; }
  .chips { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .chip { min-height: 36px; padding: 0 var(--space-3); display: inline-flex; align-items: center; gap: var(--space-2); border-radius: 999px; border: 1px solid var(--color-line); background: transparent; font-weight: 600; font-size: var(--text-sm); }
  .chip.on { background: var(--color-raised); border-color: var(--color-line-strong); }
  .n { font-size: var(--text-xs); color: var(--color-text-muted); }
  .cols { display: flex; gap: var(--space-5); align-items: flex-start; }
  .list { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--space-4); }
  .gh { font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); margin-bottom: 6px; }
  .rows { display: flex; flex-direction: column; gap: 6px; }
  @media (max-width: 1100px) { .cols { flex-direction: column; } .list { width: 100%; } }
</style>
