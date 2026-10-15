<script>
  // DBC devices tab (board H28, tab 2): ECU / DBC devices, search their signals, define a signal,
  // use one as a CAN input on a module, import a .dbc file, export one combined .dbc.
  import { onMount } from 'svelte'
  import { Card, Button, Chip, Banner, Dialog, Empty, Field, Segmented, Select, Checkbox } from '../../../ui/index.js'
  import { live, api, toast, project, isPdm, isCanboard, hex } from '../../../lib/live.svelte.js'
  import { buildDbc } from './dbcexport.js'

  let devs = $state([]) // DBC devices { guid, name, baseId, type }
  let counts = $state({}) // guid -> signal count
  let sel = $state(null)
  let q = $state('')
  let hits = $state([])
  let total = $state(0)
  let more = $state(false)
  let searching = $state(false)
  let listErr = $state('')
  let added = $state({}) // `${guid}:${sigKey}` -> { consumer, number, name, before }
  let target = $state('')
  let fn = $state(null) // the target module's functions (CAN input slots)
  let slot = $state('')

  async function loadDevs() {
    try {
      const r = await fetch('/api/devices')
      const all = r.ok ? await r.json() : []
      devs = all.filter((d) => /dbc/i.test(d.type ?? ''))
      listErr = ''
      for (const d of devs) if (!(d.guid in counts)) api.dbcSearch(d.guid, '', 1).then((s) => (counts[d.guid] = s?.total ?? 0)).catch(() => {})
      if (!devs.find((d) => d.guid === sel)) sel = devs[0]?.guid ?? null
    } catch (e) { listErr = e.message }
  }
  onMount(loadDevs)

  const cur = $derived(devs.find((d) => d.guid === sel))
  const consumers = $derived(live.devices.filter((d) => isPdm(d) || isCanboard(d)))
  $effect(() => { if (!target && consumers.length) target = consumers[0].guid })
  async function loadSlots() {
    const t = target
    if (!t) { fn = null; return }
    try { const f = await api.functions(t); if (t === target) { fn = f; const free = (f?.canInputs ?? []).filter((x) => !x.enabled); if (!free.some((x) => String(x.number) === slot)) slot = free.length ? String(free[0].number) : '' } }
    catch { fn = null }
  }
  $effect(() => { void target; loadSlots() })
  const freeSlots = $derived((fn?.canInputs ?? []).filter((x) => !x.enabled).map((x) => ({ value: String(x.number), label: 'CAN input ' + x.number })))

  let timer
  async function search() {
    const g = sel
    if (!g) { hits = []; total = 0; return }
    searching = true
    try { const r = await api.dbcSearch(g, q, 100); if (g === sel) { hits = r?.items ?? []; total = r?.total ?? 0; more = !!r?.more } }
    catch (e) { toast('Search failed: ' + e.message, 'error', 5000) } finally { searching = false }
  }
  $effect(() => { void q; void sel; clearTimeout(timer); timer = setTimeout(search, 250); return () => clearTimeout(timer) })

  const sigKey = (s) => `${s.id}-${s.ide ? 'x' : 's'}-${s.startBit}-${s.length}-${s.name}`
  const consumer = $derived(consumers.find((c) => c.guid === target))

  async function useAsInput(s) {
    if (!consumer) return
    const k = `${sel}:${sigKey(s)}`
    try {
      const f = await api.functions(consumer.guid)
      // The same frame slice is already decoded by an input: reuse it instead of piling up duplicates.
      const same = (f?.canInputs ?? []).find((x) => x.enabled && x.id === s.id && !!x.ide === !!s.ide && x.startBit === s.startBit && x.bitLength === s.length)
      if (same) {
        added[k] = { consumer: consumer.guid, consumerName: consumer.name, number: same.number, name: same.name, reused: true }
        toast(`${consumer.name} already reads this signal as CAN input ${same.number}.`, 'info', 4000)
        return
      }
      const free = (f?.canInputs ?? []).find((x) => String(x.number) === slot && !x.enabled)
      if (!free) throw new Error('That CAN input slot is not free any more. Pick another slot.')
      const name = (s.name || 'dbc' + free.number).slice(0, 32)
      // id before ide: the id setter forces ide from the value, so send the signal's own flag afterwards.
      await api.setFunction(consumer.guid, 'caninput', free.number, { enabled: true, id: s.id, ide: !!s.ide, startBit: s.startBit, bitLength: s.length, byteOrder: s.byteOrder, factor: s.factor, offset: s.offset, signed: s.isSigned, mode: 0, operator: 1, operand: 0, name })
      project.dirty = true
      added[k] = { consumer: consumer.guid, consumerName: consumer.name, number: free.number, name, before: JSON.parse(JSON.stringify(free)), reused: false }
      toast(`Added CAN input ${free.number} on ${consumer.name}.`, 'info', 4000)
      loadSlots()
    } catch (e) { toast(e.message, 'error', 7000) }
  }
  async function undoInput(s) {
    const k = `${sel}:${sigKey(s)}`, a = added[k]
    if (!a?.before) return
    try { await api.setFunction(a.consumer, 'caninput', a.number, a.before); delete added[k]; toast(`CAN input ${a.number} on ${a.consumerName} is free again.`, 'info', 3500); loadSlots() }
    catch (e) { toast(e.message, 'error', 6000) }
  }

  // ---- import ----
  let imp = $state(false)
  let impFile = $state(null)
  let impName = $state('')
  let impKind = $state('ecu')
  let impBase = $state('0x6E0')
  let impBusy = $state(false)
  let impErr = $state('')
  function pickFile(e) { impFile = e.target.files?.[0] ?? null; if (impFile && !impName) impName = impFile.name.replace(/\.dbc$/i, ''); impErr = '' }
  async function doImport() {
    if (!impFile) { impErr = 'Choose a .dbc file first.'; return }
    const base = impKind === 'module' ? parseInt(String(impBase).replace(/^0x/i, ''), 16) : 0
    if (impKind === 'module' && !(base > 0 && base <= 0x7ff)) { impErr = 'The base ID must be a hex number from 1 to 7FF.'; return }
    impBusy = true; impErr = ''
    try {
      const r = await api.dbcImport(impName.trim() || impFile.name.replace(/\.dbc$/i, ''), await impFile.text(), base, impKind === 'module')
      project.dirty = true
      imp = false; impFile = null; impName = ''
      await loadDevs()
      sel = r.guid
      counts[r.guid] = r.count
      toast(`Imported ${r.count} signals.`, 'info', 4000)
    } catch (e) { impErr = e.message } finally { impBusy = false }
  }

  // ---- open another file into the selected device ----
  let openBusy = $state(false)
  async function openInto(e) {
    const f = e.target.files?.[0]; e.target.value = ''
    if (!f || !sel) return
    openBusy = true
    try { const r = await api.dbcOpen(sel, await f.text()); counts[sel] = r.count; project.dirty = true; toast(`Loaded ${r.count} signals from ${f.name}.`, 'info', 4000); search() }
    catch (err) { toast('Could not read that file: ' + err.message, 'error', 6000) } finally { openBusy = false }
  }

  // ---- remove ----
  let rm = $state(false)
  async function doRemove() {
    rm = false
    try { await api.remove(sel); project.dirty = true; toast(`Removed ${cur?.name}.`, 'info', 3000); await loadDevs() } catch (e) { toast(e.message, 'error', 6000) }
  }

  // ---- define a signal ----
  let sg = $state({ name: '', id: '', ext: false, startBit: 0, length: 8, order: 'intel', signed: false, factor: 1, offset: 0, unit: '' })
  let sgErr = $state('')
  let sgBusy = $state(false)
  async function addSignal() {
    sgErr = ''
    const raw = String(sg.id).trim()
    const id = /^0x/i.test(raw) ? parseInt(raw.slice(2), 16) : parseInt(raw, 16)
    const max = sg.ext ? 0x1fffffff : 0x7ff
    if (!sg.name.trim()) return (sgErr = 'Give the signal a name.')
    if (!Number.isInteger(id) || id < 0 || id > max) return (sgErr = `"${sg.id}" is not a valid ${sg.ext ? '29' : '11'}-bit CAN id (0 to 0x${max.toString(16).toUpperCase()}).`)
    const sb = Math.trunc(+sg.startBit), len = Math.trunc(+sg.length)
    if (!(sb >= 0 && sb <= 63)) return (sgErr = 'Start bit must be 0 to 63.')
    if (!(len >= 1 && len <= 64)) return (sgErr = 'Length must be 1 to 64 bits.')
    sgBusy = true
    try {
      await api.dbcAddSignal(sel, { name: sg.name.trim(), id, extended: !!sg.ext, startBit: sb, length: len, byteOrder: sg.order === 'motorola' ? 1 : 0, isSigned: sg.signed, isFloat: false, factor: +sg.factor, offset: +sg.offset, unit: sg.unit, min: 0, max: 0 })
      project.dirty = true
      toast(`Added signal ${sg.name.trim()}.`, 'info', 3500)
      sg.name = ''
      counts[sel] = (counts[sel] ?? 0) + 1
      search()
    } catch (e) { sgErr = e.message } finally { sgBusy = false }
  }

  // ---- export ----
  let inc = $state({ mod: true, ecu: true })
  let exBusy = $state(false)
  let exNote = $state('')
  async function doExport() {
    exBusy = true; exNote = ''
    try {
      const mods = inc.mod ? live.devices.filter((d) => isPdm(d) || isCanboard(d)) : []
      const frames = []
      for (const m of mods) {
        const sigs = (await api.broadcastSignals(m.guid)) ?? []
        for (const s of sigs) frames.push({ node: m.name, id: m.baseId + s.offset, ide: false, msg: `${m.name}_${hex(m.baseId + s.offset).slice(2)}`, sig: { name: s.label || s.name, startBit: s.startBit, length: s.bitLength, byteOrder: s.byteOrder, isSigned: s.signed, isFloat: s.isFloat, factor: s.factor, offset: s.valueOffset, unit: s.unit } })
      }
      let capped = false
      if (inc.ecu) for (const d of devs) {
        const r = await api.dbcSignals(d.guid, 2000)
        if ((r?.count ?? 0) > (r?.items?.length ?? 0)) capped = true
        for (const s of r?.items ?? []) frames.push({ node: d.name, id: s.id, ide: !!s.ide, msg: s.messageName || `${d.name}_${hex(s.id).slice(2)}`, sig: { name: s.name, startBit: s.startBit, length: s.length, byteOrder: s.byteOrder, isSigned: s.isSigned, isFloat: false, factor: s.factor, offset: s.offset, unit: s.unit, min: s.min, max: s.max } })
      }
      if (!frames.length) { exNote = 'Nothing to export. Tick something that has signals.'; return }
      const blob = new Blob([buildDbc(frames)], { type: 'text/plain' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob); a.download = 'dingo-combined.dbc'; document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 2000)
      exNote = `Saved dingo-combined.dbc with ${frames.length} signals.` + (capped ? ' ECU devices with more than 2 000 signals were cut at 2 000 (the backend caps the list).' : '')
    } catch (e) { exNote = 'Export failed: ' + e.message } finally { exBusy = false }
  }
  const fmtV = (v) => (v == null ? '—' : Number.isInteger(v) ? String(v) : Number(v).toFixed(3))
</script>

{#if listErr}<Banner tone="fault" title="Could not list DBC devices.">{listErr}</Banner>{/if}

<div class="cols">
  <Card title="DBC devices" subtitle="From .dbc files">
    {#snippet actions()}<Button variant="primary" onclick={() => { imp = true; impErr = '' }} data-testid="dbc-import">Import a DBC file…</Button>{/snippet}
    {#if !devs.length}
      <Empty title="No DBC file imported yet" text="Import a .dbc file to read an ECU's signals, check its ids for clashes and use them as inputs." />
    {:else}
      <ul class="list" data-testid="dbc-list">
        {#each devs as d (d.guid)}
          <li><button class="item" aria-pressed={d.guid === sel} onclick={() => (sel = d.guid)}>
            <strong>{d.name}</strong>
            <span class="muted">{counts[d.guid] != null ? `${counts[d.guid].toLocaleString('en-US')} signals` : 'reading…'}{d.baseId ? ` · base ${hex(d.baseId)}` : ' · no base id'}</span>
          </button></li>
        {/each}
      </ul>
    {/if}

    <div class="exp">
      <h3>Export one combined DBC</h3>
      <Checkbox bind:checked={inc.mod} label="dingo modules" hint="Their broadcast frames, built from the live project" />
      <Checkbox bind:checked={inc.ecu} label="ECU devices" hint="{devs.length} imported {devs.length === 1 ? 'device' : 'devices'}" />
      <Button onclick={doExport} busy={exBusy} data-testid="dbc-export">Export .dbc</Button>
      {#if exNote}<p class="muted" role="status" data-testid="dbc-export-note">{exNote}</p>{/if}
    </div>
  </Card>

  <div class="main">
    {#if cur}
      <Card title={cur.name} subtitle={`${(counts[cur.guid] ?? 0).toLocaleString('en-US')} signals`}>
        {#snippet actions()}
          <label class="fbtn" class:dis={openBusy}>{openBusy ? 'Reading…' : 'Open another .dbc into this device…'}<input type="file" accept=".dbc" class="sr-only" onchange={openInto} disabled={openBusy} data-testid="dbc-open" /></label>
          <Button variant="danger" onclick={() => (rm = true)} data-testid="dbc-remove">Remove device</Button>
        {/snippet}
        <Field label="Search signal or message name" bind:value={q} placeholder="for example coolant" data-testid="dbc-search" />
        <div class="to">
          <Select label="Use a signal as a CAN input on" items={consumers.map((c) => ({ value: c.guid, label: c.name }))} bind:value={target} data-testid="dbc-target" />
          <Select label="In slot" items={freeSlots} bind:value={slot} placeholder={fn ? 'No free slot' : 'Reading…'} disabled={!freeSlots.length} data-testid="dbc-slot" />
        </div>
        {#if !hits.length}
          <p class="muted" role="status">{searching ? 'Searching…' : total ? 'No signal matches. Try another word.' : 'No signals yet. Open a .dbc file or define one below.'}</p>
        {:else}
          <div class="nx-scroll tw">
            <table class="nx-table" data-testid="dbc-hits">
              <thead><tr><th>Signal</th><th>Frame</th><th>Id</th><th>Bits</th><th>Scale</th><th>Live</th><th>Use</th></tr></thead>
              <tbody>
                {#each hits as s (sigKey(s))}
                  {@const a = added[`${sel}:${sigKey(s)}`]}
                  <tr>
                    <td><strong>{s.name}</strong>{#if s.unit} <span class="muted">{s.unit}</span>{/if}</td>
                    <td class="muted">{s.messageName ?? ''}</td>
                    <td class="mono">{hex(s.id)}{s.ide ? ' ext' : ''}</td>
                    <td class="mono">{s.startBit}+{s.length}{s.byteOrder == 1 ? ' BE' : ''}{s.isSigned ? ' ±' : ''}</td>
                    <td class="mono">×{s.factor} {s.offset >= 0 ? '+' : ''}{s.offset}</td>
                    <td class="mono">{fmtV(s.value)}</td>
                    <td>
                      {#if a}<Chip tone="ok" symbol="✓">{a.reused ? 'Already' : 'Added'} · {a.consumerName} CAN in {a.number}</Chip>
                        {#if a.before && !a.reused}<Button size="sm" variant="ghost" onclick={() => undoInput(s)}>Undo</Button>{/if}
                      {:else}<Button size="sm" onclick={() => useAsInput(s)} disabled={!consumer || !slot} data-testid="dbc-use" aria-label={`Use ${s.name} as a CAN input on ${consumer?.name ?? 'a module'}`}>Use as input</Button>{/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if more}<p class="muted">Showing the first 100 of {total.toLocaleString('en-US')}. Narrow the search to see more.</p>{/if}
        {/if}
      </Card>

      <Card title="Define a signal" subtitle="For a frame you found on the bus that the file does not describe">
        <div class="form">
          <Field label="Name" bind:value={sg.name} data-testid="sg-name" />
          <Field label="CAN id (hex)" bind:value={sg.id} mono placeholder="0x3E0" data-testid="sg-id" />
          <Field label="Start bit" type="number" bind:value={sg.startBit} min="0" max="63" data-testid="sg-start" />
          <Field label="Length (bits)" type="number" bind:value={sg.length} min="1" max="64" data-testid="sg-len" />
          <Field label="Factor" type="number" step="any" bind:value={sg.factor} />
          <Field label="Offset" type="number" step="any" bind:value={sg.offset} />
          <Field label="Unit" bind:value={sg.unit} />
        </div>
        <div class="row">
          <Checkbox bind:checked={sg.ext} label="29-bit id" />
          <Checkbox bind:checked={sg.signed} label="Signed" />
          <Segmented items={[{ value: 'intel', label: 'Intel (little endian)' }, { value: 'motorola', label: 'Motorola (big endian)' }]} bind:value={sg.order} label="Byte order" size="sm" />
        </div>
        {#if sgErr}<Banner tone="fault" data-testid="sg-error">{sgErr}</Banner>{/if}
        <div><Button variant="primary" onclick={addSignal} busy={sgBusy} data-testid="sg-add">Add signal</Button></div>
      </Card>
    {:else}
      <Empty title={devs.length ? 'Pick a DBC device' : 'No DBC device yet'} text={devs.length ? 'Its signals show here.' : 'Import a .dbc file to see its signals here.'} />
    {/if}
  </div>
</div>

<Dialog bind:open={imp} title="Import a DBC file" description="This adds a DBC device to the project. Nothing is sent to the car.">
  <div class="dlg">
    <label class="fbtn">{impFile ? impFile.name : 'Choose a .dbc file…'}<input type="file" accept=".dbc" class="sr-only" onchange={pickFile} data-testid="dbc-file" /></label>
    <Field label="Name" bind:value={impName} data-testid="dbc-name" />
    <Segmented items={[{ value: 'ecu', label: 'ECU', sub: 'absolute ids, no base' }, { value: 'module', label: 'Module', sub: 'moved onto a base id' }]} bind:value={impKind} label="What the file describes" />
    {#if impKind === 'module'}<Field label="Base id (hex)" bind:value={impBase} mono hint="The messages in the file are moved so the first one sits on this base." />{/if}
    {#if impErr}<Banner tone="fault">{impErr}</Banner>{/if}
  </div>
  {#snippet footer()}
    <Button onclick={() => (imp = false)}>Cancel</Button>
    <Button variant="primary" onclick={doImport} busy={impBusy} data-testid="dbc-import-go">Import</Button>
  {/snippet}
</Dialog>

<Dialog bind:open={rm} title={`Remove ${cur?.name ?? 'this device'}?`} description="Its signals are removed from the project. CAN inputs that already decode its frames keep working.">
  {#snippet footer()}
    <Button onclick={() => (rm = false)}>Cancel</Button>
    <Button variant="danger" onclick={doRemove} data-testid="dbc-remove-go">Remove</Button>
  {/snippet}
</Dialog>

<style>
  .cols { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: var(--space-4); align-items: start; }
  @media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } }
  .main { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .item { width: 100%; text-align: left; display: flex; flex-direction: column; gap: 2px; padding: var(--space-3); min-height: var(--target-min); border-radius: var(--radius-md); border: 1px solid var(--color-line); border-left: 4px solid transparent; background: transparent; }
  .item[aria-pressed='true'] { background: var(--color-raised); border-color: var(--color-line-strong); border-left-color: var(--color-accent); }
  .exp { display: flex; flex-direction: column; gap: var(--space-2); border-top: 1px solid var(--color-line); padding-top: var(--space-3); }
  .exp h3 { font-size: var(--text-md); }
  .fbtn { display: inline-flex; align-items: center; min-height: var(--target-min); padding: 0 var(--space-4); border: 1px solid var(--color-line-strong); border-radius: var(--radius-md); font-weight: 600; cursor: pointer; background: var(--color-surface); }
  .fbtn:focus-within { outline: 3px solid var(--color-focus); outline-offset: 2px; }
  .fbtn.dis { opacity: 0.5; }
  .to { display: flex; align-items: flex-end; gap: var(--space-3); flex-wrap: wrap; }
  .tw { max-height: 420px; }
  .form { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: var(--space-3); }
  .row { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
  .dlg { display: flex; flex-direction: column; gap: var(--space-3); }
</style>
