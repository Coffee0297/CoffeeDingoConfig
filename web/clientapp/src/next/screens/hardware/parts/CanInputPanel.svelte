<script>
  // CAN input (H20): pick a signal from an ECU file or another module, or type the frame position;
  // see the decoded value live; set what happens when the frames stop; learn a switch from the bus.
  import { untrack } from 'svelte'
  import { Page, PageHeader, Card, Button, StateDot, Banner, Segmented, Switch, Stepper, Field, Checkbox, Select, LineChart, Chip, Empty } from '../../../ui/index.js'
  import { live, api, device, hex, toast, mutate, isPdm, project } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import { setRemoteLink, clearRemoteLink, remoteLinkFor } from '../../../../lib/store.js'
  import { inputModel } from './input.svelte.js'
  import { linkRemote } from '../../functions/flow/net.js'
  import { signalFeed, ring } from './feeds.svelte.js'
  import { resample, lacks, has, isUpstream } from './util.js'
  import SaveBar from './SaveBar.svelte'
  import UsedBy from './UsedBy.svelte'
  import LearnSwitch from './LearnSwitch.svelte'

  let { guid, n } = $props()
  const M = inputModel(() => guid, () => 'caninput', () => n)
  const dev = $derived(M.dev)
  const row = $derived(M.row)
  const feed = signalFeed(() => guid, 200)

  // ---- form ----
  let f = $state(null), snap = $state(''), learnedNote = $state(false)
  const seed = (r) => ({ name: r.name ?? '', enabled: !!r.enabled, id: r.id ?? 0, ide: !!r.ide, startBit: r.startBit ?? 0, bitLength: r.bitLength ?? 8, byteOrder: r.byteOrder ?? 0, signed: !!r.signed,
    factor: r.factor ?? 1, offset: r.offset ?? 0, operator: r.operator ?? 0, operand: r.operand ?? 0, timeoutEnabled: !!r.timeoutEnabled, timeout: r.timeout ?? 1000, timeoutValue: r.timeoutValue ?? 0, timeoutUseValue: !!r.timeoutUseValue, idText: hex(r.id ?? 0) })
  $effect(() => { if (!f && row) { f = seed(row); snap = JSON.stringify(f) } })
  const dirty = $derived(!!f && JSON.stringify(f) !== snap)
  function revert() { if (row) { f = seed(row); snap = JSON.stringify(f); M.state.saveErr = ''; learnedNote = false } }

  const parsedId = $derived(f ? parseInt(String(f.idText).replace(/^0x/i, ''), 16) : NaN)
  const problem = $derived.by(() => {
    if (!f || !dirty) return ''
    if (!String(f.name).trim()) return 'Give the input a name.'
    if (!Number.isInteger(parsedId) || parsedId < 0) return `"${f.idText}" is not a CAN ID. Use hex, for example 0x18F.`
    const max = f.ide ? 0x1fffffff : 0x7ff
    if (parsedId > max) return `ID 0x${parsedId.toString(16).toUpperCase()} is too big for a ${f.ide ? '29' : '11'}-bit ID.${parsedId > 0x7ff ? ' Choose Extended.' : ''}`
    const sb = Math.trunc(Number(f.startBit)), bl = Math.trunc(Number(f.bitLength))
    if (!Number.isInteger(sb) || sb < 0 || sb > 63) return 'Start bit must be 0 to 63.'
    if (!Number.isInteger(bl) || bl < 1 || bl > 32) return 'Length must be 1 to 32 bits.'
    if (bl > 64 - sb) return `Length must be 1 to ${64 - sb} for a start bit of ${sb}.`
    return ''
  })
  async function save() {
    const body = { name: String(f.name).trim(), enabled: f.enabled, id: parsedId, ide: f.ide, startBit: Math.trunc(Number(f.startBit)), bitLength: Math.trunc(Number(f.bitLength)),
      byteOrder: Number(f.byteOrder), signed: f.signed, factor: Number(f.factor), offset: Number(f.offset), operator: Number(f.operator), operand: Number(f.operand),
      timeoutEnabled: f.timeoutEnabled, timeout: Math.max(0, Math.round(Number(f.timeout) || 0)),
      ...(firmwareOld ? {} : { timeoutValue: Number(f.timeoutValue) || 0 }), ...(useFlag ? { timeoutUseValue: f.timeoutUseValue } : {}) }
    if (await M.save(body)) { snap = JSON.stringify(f); learnedNote = false }
  }

  // ---- where the signal comes from ----
  const others = $derived(live.devices.filter((d) => d.guid !== guid && !/dbc/i.test(d.type ?? '')))
  const dbcs = $derived(live.devices.filter((d) => /dbc/i.test(d.type ?? '')))
  let source = $state(''), q = $state(''), dbcGuid = $state(''), modGuid = $state('')
  $effect(() => { if (!source && row) source = row.enabled && row.id ? 'manual' : dbcs.length ? 'dbc' : others.length ? 'module' : 'manual' })
  $effect(() => { if (!dbcGuid && dbcs.length) dbcGuid = dbcs[0].guid })
  $effect(() => { if (!modGuid && others.length) modGuid = others[0].guid })

  let dbcHits = $state([]), dbcMore = $state(false), dbcBusy = $state(false), dbcErr = $state('')
  $effect(() => {
    const g = dbcGuid, qq = q, s = source
    if (s !== 'dbc' || !g) { dbcHits = []; return }
    let alive = true; dbcBusy = true
    const t = setTimeout(() => {
      api.dbcSearch(g, qq, 60).then((r) => { if (alive) { dbcHits = r?.items ?? []; dbcMore = !!r?.more; dbcErr = ''; dbcBusy = false } })
        .catch((e) => { if (alive) { dbcHits = []; dbcErr = e?.message ?? String(e); dbcBusy = false } })
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  })
  let modSigs = $state([]), modBusy = $state(false), modErr = $state('')
  $effect(() => {
    const g = modGuid, s = source
    if (s !== 'module' || !g) { modSigs = []; return }
    let alive = true; modBusy = true
    api.broadcastSignals(g, true).then((r) => { if (alive) { modSigs = (Array.isArray(r) ? r : []).filter((x) => !x.isFloat); modErr = ''; modBusy = false } })
      .catch((e) => { if (alive) { modSigs = []; modErr = e?.message ?? String(e); modBusy = false } })
    return () => { alive = false }
  })
  const modSrc = $derived(others.find((d) => d.guid === modGuid))
  const modRows = $derived(modSigs.filter((s) => !q.trim() || ((s.label ?? '') + ' ' + s.name + ' ' + (s.unit ?? '')).toLowerCase().includes(q.trim().toLowerCase())))
  const scaleText = (len, factor, off, unit) => (len === 1 ? 'on / off' : '×' + factor + (off ? (off > 0 ? ' +' : ' −') + Math.abs(off) : '') + (unit ? ' ' + unit : ''))

  function fill(o) {
    f.idText = hex(o.id); f.ide = !!o.ide; f.startBit = o.startBit; f.bitLength = o.length; f.byteOrder = o.byteOrder ?? 0
    f.factor = o.factor ?? 1; f.offset = o.offset ?? 0; f.signed = !!o.signed
    f.operator = 1; f.operand = 0   // reads as ON when the value is not zero
    if (!f.enabled) f.enabled = true
    learnedNote = false
  }
  function pickDbc(s) {
    fill({ id: s.id, ide: s.ide, startBit: s.startBit, length: s.length, byteOrder: s.byteOrder, factor: s.factor, offset: s.offset, signed: s.isSigned })
    if (!f.name || /^canInput\d+$/i.test(f.name)) f.name = s.name
    clearRemoteLink(guid, n)
    toast(`Filled from ${s.messageName || 'the ECU file'} · ${s.name}. Save to keep.`, 'info', 4000)
  }
  // Server-side link (staged like a save): the backend resolves the frame from the source's base ID, so a
  // later base-ID change can re-point it. The form is reseeded from the result; unsaved timeout edits stay.
  let linking = $state(false)
  async function pickModule(s) {
    const src = modSrc, keep = f
    linking = true; M.state.saveErr = ''
    try {
      const r = await linkRemote(guid, n, src.guid, s.name, true)   // the row itself reads ON when not zero, not only the form
      project.dirty = true
      await M.reload()
      if (!row) return
      snap = JSON.stringify(seed(row))
      f = { ...seed(row), timeoutEnabled: keep.timeoutEnabled, timeout: keep.timeout, timeoutValue: keep.timeoutValue, operator: 1, operand: 0 }   // reads as ON when not zero
      learnedNote = false
      M.state.note = r?.staged ? 'Kept in the project. Not on the car yet.' : r?.written ? 'Kept in the project and sent to the module.' : 'Kept in the project. Not on the car yet: the module is offline, apply to car when it is back.'
      setRemoteLink(guid, n, { sourceGuid: src.guid, signal: s.name, label: s.label ?? s.name, offset: s.offset, startBit: s.startBit, bitLength: s.bitLength, factor: s.factor, valueOffset: s.valueOffset, byteOrder: s.byteOrder, signed: s.signed })
      toast(`Linked to ${src.name} · ${s.label ?? s.name}. Kept in the project.`, 'info', 4000)
    } catch (e) { M.state.saveErr = e?.message ?? String(e) } finally { linking = false }
  }
  let learnOpen = $state(false)
  function useLearned(c) {
    fill({ id: c.id, ide: c.ide, startBit: c.startBit, length: 1, byteOrder: 0, factor: 1, offset: 0, signed: false })
    if (!f.name || /^canInput\d+$/i.test(f.name)) f.name = 'Learned switch'
    clearRemoteLink(guid, n)
    source = 'manual'; learnedNote = true
  }

  // DBC import (project change: a DBC entry appears in the module list)
  let fileEl = $state(null), importing = $state(false)
  async function importDbc(e) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ''
    if (!file) return
    importing = true
    const text = await file.text()
    const r = await mutate(() => api.dbcImport(file.name.replace(/\.dbc$/i, ''), text, 0, false), `Imported ${file.name}`)
    if (r?.guid) dbcGuid = r.guid   // search the file just imported, not the first ECU in the project
    importing = false
  }

  // ---- live value, frame and graph ----
  const sig = $derived(row ? feed.get('CAN input', row.name) : undefined)
  const online = $derived(M.connected)
  const val = $derived(sig && online ? Number(sig.value) : null)
  const hist = ring(10_000)
  let tick = $state(0)
  $effect(() => {
    feed.ts
    const s = untrack(() => sig)
    if (!s || !untrack(() => online)) return
    untrack(() => { hist.push(Number(s.value)); tick++ })
  })
  const series = $derived.by(() => { tick; return resample(hist.samples(), 10_000, 100) })

  // last frame with the saved ID (canlog keeps the last data and a count per id)
  let frame = $state(null), lastSeen = $state(0), period = $state(0), prevCount = 0, prevAt = 0
  $effect(() => {
    const r = row
    if (!r || !r.id) { frame = null; return }
    let alive = true, busy = false
    prevCount = 0; prevAt = 0
    const poll = async () => {
      if (busy) return
      busy = true
      try {
        const list = await api.canlog()
        if (!alive) return
        const e = (list ?? []).find((x) => x.id === r.id && !!x.ide === !!r.ide && x.dir === 'Rx') ?? null
        frame = e
        const t = Date.now()
        if (e && e.count !== prevCount) {
          if (prevCount && t > prevAt) period = Math.round((t - prevAt) / Math.max(1, e.count - prevCount))
          lastSeen = t; prevCount = e.count; prevAt = t
        }
      } catch { /* the live feed banner covers a lost link */ } finally { busy = false }
    }
    poll()
    const id = setInterval(poll, 300)
    return () => { alive = false; clearInterval(id) }
  })
  let now = $state(Date.now())
  $effect(() => { const id = setInterval(() => (now = Date.now()), 250); return () => clearInterval(id) })
  const bytes = $derived.by(() => {
    const b = (frame?.data ?? '').trim().split(/\s+/).filter(Boolean)
    const sb = Number(f?.startBit) || 0, bl = Math.max(1, Number(f?.bitLength) || 1)
    const first = Math.floor(sb / 8)
    const last = f?.byteOrder === 1 ? first + Math.ceil(Math.max(0, bl - (sb % 8 + 1)) / 8) : Math.floor((sb + bl - 1) / 8)
    return Array.from({ length: 8 }, (_, i) => ({ n: i, hex: (b[i] ?? '--').toUpperCase(), hl: i >= first && i <= last }))
  })
  const frameAge = $derived(frame && lastSeen ? Math.max(0, now - lastSeen) : null)
  const raw = $derived(val == null || !f ? null : f.bitLength === 1 ? val : Math.round((val - Number(f.offset)) / (Number(f.factor) || 1)))
  const decoded = $derived(val == null ? '—' : f.bitLength === 1 ? (val ? 'ON' : 'OFF') : Number.isInteger(val) ? String(val) : val.toFixed(2))
  const formula = $derived(val == null || !f ? '' : f.bitLength === 1 ? `bit ${f.startBit} of ${f.idText} = ${val ? 1 : 0}` : `${raw} × ${f.factor}${Number(f.offset) ? (Number(f.offset) > 0 ? ' + ' : ' − ') + Math.abs(Number(f.offset)) : ''} = ${decoded}`)
  const timedOut = $derived(!!row?.timeoutEnabled && frameAge != null && frameAge > (row.timeout ?? 0))

  const pillTone = $derived(!live.connected ? 'stale' : !dev?.connected ? 'stale' : !row?.enabled ? 'off' : timedOut ? 'fault' : val == null ? 'stale' : val ? 'on' : 'off')
  const pillText = $derived(!live.connected ? 'No connection' : !dev?.connected ? 'Module offline' : !row?.enabled ? 'Not in use' : timedOut ? 'Signal lost' : val == null ? 'Reading…' : `${decoded} · ${f?.idText}`)

  const OPS = ['is', 'is not', 'is above', 'is below', 'is at least', 'is at most', 'has bits', 'lacks bits'].map((label, i) => ({ value: String(i), label }))
  let srcVal = $state(''), opVal = $state('0'), orderVal = $state('0'), idtVal = $state('std'), modSel = $state(''), dbcSel = $state('')
  $effect(() => { srcVal = source })
  $effect(() => { if (f) { opVal = String(f.operator); orderVal = String(f.byteOrder); idtVal = f.ide ? 'ext' : 'std' } })
  $effect(() => { modSel = modGuid; dbcSel = dbcGuid })
  const title = $derived(f?.name?.trim() || `CAN input ${n}`)
  const firmwareOld = $derived(lacks(dev, [5, 6, 0], 0x1300, 14))   // value-on-timeout: firmware 5.6 (0x1300 sub 14)
  // upstream dingoFW (feat/can-input-timeout-value) also has the flag (sub 15); without it the input reads 0. The fork has none.
  const useFlag = $derived(!firmwareOld && isUpstream(dev) && has(dev, 0x1300 + (row?.number ?? 1) - 1, 15))
</script>

<Page>
  {#if !M.state.loaded}
    <p class="muted" role="status">Reading the input…</p>
  {:else if M.state.err && !row}
    <Banner tone="fault" title="Could not read this module">{M.state.err}</Banner>
  {:else if !row}
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: dev.name, href: href('hardware', 'module', guid) }, { label: `CAN input ${n}` }]} title={`${dev.name} has no CAN input ${n}`} />
    <Empty title="No such input" text="Check the number in the address." />
  {:else if f}
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: dev.name, href: href('hardware', 'module', guid) }, { label: 'Inputs' }, { label: `CAN input ${n}` }]} title={title}>
      {#snippet tag()}
        <span class="pin mono">CAN IN {n}</span>
        <span class="pill" data-tone={pillTone} role="status" data-testid="in-state"><StateDot tone={pillTone} shape={pillTone === 'on' ? 'dot' : pillTone === 'fault' ? 'square' : pillTone === 'stale' ? 'square' : 'ring'} label={pillText} /></span>
        {#if learnedNote}<Chip tone="accent" symbol="●">Filled in by Learn</Chip>{/if}
      {/snippet}
      {#snippet actions()}
        <Switch bind:checked={f.enabled} label="Input in use" />
      {/snippet}
    </PageHeader>

    {#if !live.connected}
      <Banner tone="warn" title="Not connected to the car">Settings are kept in the project and sent when you apply them.</Banner>
    {:else if !dev.connected}
      <Banner tone="warn" title={`${dev.name} is not answering`}>Values here are the last ones it sent.</Banner>
    {/if}

    <Segmented label="Signal comes from" items={[{ value: 'dbc', label: 'ECU (DBC file)' }, { value: 'module', label: 'Another module' }, { value: 'keypad', label: 'Keypad button', disabled: true, sub: 'in the flow builder' }, { value: 'manual', label: 'Type it in' }]}
      bind:value={srcVal} onchange={(v) => { source = v; q = '' }} data-testid="source" />

    <div class="cols">
      <div class="col">
        <Card title={source === 'dbc' ? 'Pick an ECU signal' : source === 'module' ? "Pick another module's signal" : 'Type the frame yourself'}
          subtitle={source === 'dbc' ? 'Search by name, message or ID.' : source === 'module' ? 'Signals the modules in this car send, by name. The ID and bit are filled in for you.' : 'For a bit or number you know the position of. Fill in the fields below.'} aria-label="Pick a signal">
          {#snippet actions()}
            {#if source === 'dbc'}<Button size="sm" busy={importing} onclick={() => fileEl?.click()} data-testid="import-dbc">Import DBC…</Button>
              <input bind:this={fileEl} type="file" accept=".dbc" class="sr-only" aria-label="Choose a DBC file" onchange={importDbc} data-testid="dbc-file" />{/if}
          {/snippet}
          {#if source === 'dbc'}
            {#if !dbcs.length}
              <Empty title="No ECU file imported yet" text="Import the DBC file for your ECU, then search its signals here." />
            {:else}
              {#if dbcs.length > 1}<Select label="ECU file" items={dbcs.map((d) => ({ value: d.guid, label: d.name }))} bind:value={dbcSel} onchange={(v) => (dbcGuid = v)} />{/if}
              <Field label="Search" bind:value={q} placeholder="rpm, coolant, fan, 0x0C9" data-testid="search" />
              <p class="muted small" role="status">{dbcBusy ? 'Searching…' : dbcErr ? dbcErr : `${dbcHits.length}${dbcMore ? '+' : ''} match${dbcHits.length === 1 ? '' : 'es'}`}</p>
              <div role="group" aria-label="Matching signals" class="rows">
                {#each dbcHits as s (s.id + ':' + s.name + ':' + s.startBit)}
                  <button type="button" class="pick" aria-pressed={parsedId === s.id && Number(f.startBit) === s.startBit && f.bitLength === s.length} onclick={() => pickDbc(s)} data-testid="dbc-row">
                    <span class="a"><strong>{s.name}</strong><span class="mono">{hex(s.id)}</span></span>
                    <span class="muted small">{s.messageName} · bit {s.startBit} · {s.length === 1 ? '1 bit' : s.length + ' bits'} · {scaleText(s.length, s.factor, s.offset, s.unit)}</span>
                  </button>
                {/each}
              </div>
            {/if}
          {:else if source === 'module'}
            {#if !others.length}
              <Empty title="No other modules" text="Add another module to the project to read its signals." />
            {:else}
              <Select label="Module" items={others.map((d) => ({ value: d.guid, label: d.name }))} bind:value={modSel} onchange={(v) => (modGuid = v)} data-testid="module-select" />
              <Field label="Search" bind:value={q} placeholder="brake, door, fuel" data-testid="search" />
              <p class="muted small" role="status">{modBusy ? 'Reading…' : modErr ? modErr : `${modRows.length} of ${modSigs.length} signals`}</p>
              <div role="group" aria-label="Matching signals" class="rows">
                {#each modRows as s (s.name)}
                  <button type="button" class="pick" disabled={linking} onclick={() => pickModule(s)} data-testid="module-row">
                    <span class="a"><strong>{s.label ?? s.name}</strong><span class="mono">{hex((modSrc?.baseId ?? 0) + s.offset)}</span></span>
                    <span class="muted small">{modSrc?.name} · bit {s.startBit} · {s.bitLength === 1 ? '1 bit' : s.bitLength + ' bits'} · {scaleText(s.bitLength, s.factor, s.valueOffset, s.unit)}</span>
                  </button>
                {/each}
              </div>
            {/if}
          {:else}
            <p class="muted">Use the fields in the next card to say where the number lives in the frame.</p>
          {/if}
          <div class="learn">
            <span><strong>Not in the list, or it is a plain switch?</strong><br /><span class="muted">Flip the switch while the bus is recorded. The bit that follows it is found for you.</span></span>
            <Button onclick={() => (learnOpen = true)} disabled={!live.connected} title={live.connected ? '' : 'Connect to the car to record the bus'} data-testid="learn">Learn a switch</Button>
          </div>
        </Card>

        <Card title="Where the number lives in the frame" subtitle="filled in from the pick, still editable" aria-label="Signal details">
          <Field label="Name" bind:value={f.name} data-testid="name" />
          <div class="grid">
            <Field label="CAN ID" bind:value={f.idText} mono data-testid="can-id" hint="Hex, for example 0x18F" />
            <div class="grp"><span class="nx-label">ID type (11-bit or 29-bit)</span>
              <Segmented label="ID type" items={[{ value: 'std', label: 'Standard' }, { value: 'ext', label: 'Extended' }]} bind:value={idtVal} onchange={(v) => (f.ide = v === 'ext')} data-testid="id-type" /></div>
            <Field label="Start bit" type="number" min={0} max={63} bind:value={f.startBit} data-testid="start-bit" />
            <Field label="Length in bits" type="number" min={1} max={32} bind:value={f.bitLength} data-testid="bit-length" />
            <div class="grp"><span class="nx-label">Byte order</span>
              <Segmented label="Byte order" items={[{ value: '1', label: 'Big-endian' }, { value: '0', label: 'Little-endian' }]} bind:value={orderVal} onchange={(v) => (f.byteOrder = Number(v))} data-testid="byte-order" /></div>
            <div class="grp">
              <Checkbox bind:checked={f.signed} label="Signed" data-testid="signed" />
              <Checkbox checked={false} disabled label="Float" hint="Not available yet: the module cannot read 32-bit floats." />
            </div>
            <Field label="Factor (multiply by)" type="number" step="any" bind:value={f.factor} data-testid="factor" />
            <Field label="Offset (then add)" type="number" step="any" bind:value={f.offset} data-testid="offset" />
          </div>
          <div class="two">
            <Select label="Reads as ON when the value" items={OPS} bind:value={opVal} onchange={(v) => (f.operator = Number(v))} />
            <Field label="This number" type="number" step="any" bind:value={f.operand} />
          </div>
        </Card>
      </div>

      <div class="col">
        <Card title="Live value" subtitle="last 10 s" aria-label="Live decoded value">
          <div class="dec" role="status" data-testid="decoded">{decoded}</div>
          <p class="muted"><span class="mono">{formula}</span>{#if frame}<br />Last frame {frameAge != null ? (frameAge < 1000 ? frameAge + ' ms' : (frameAge / 1000).toFixed(1) + ' s') + ' ago' : 'seen'}{period ? ` · sent about every ${period} ms` : ''}{:else if row.id}<br />No frame with this ID seen yet.{/if}</p>
          <div class="bytes" role="img" aria-label={`Last frame ${f.idText}: ${bytes.map((b) => b.hex).join(' ')}. Bytes ${bytes.filter((b) => b.hl).map((b) => b.n).join(', ')} hold this signal.`}>
            {#each bytes as b (b.n)}<span class:hl={b.hl}><small>byte {b.n}</small><strong class="mono">{b.hex}</strong></span>{/each}
          </div>
          <LineChart series={[{ label: 'Value', values: series.length ? series : [0, 0], color: 'var(--color-on)', area: true }]} height={110} xLabels={['−10 s', 'now']}
            label={`Line graph of ${title} over the last 10 seconds. Now ${decoded}.`} />
        </Card>

        <Card title="If the signal stops" aria-label="If the signal stops">
          <Checkbox bind:checked={f.timeoutEnabled} label="Treat it as lost after a gap" hint="No frame for this long means the sender stopped." data-testid="timeout-on" />
          <Stepper label="Timeout" bind:value={f.timeout} min={50} max={60000} step={50} unit="ms" disabled={!f.timeoutEnabled} data-testid="timeout" />
          <div class="tv">
            <label class="nx-label" for="tval">Value to use then</label>
            {#if firmwareOld}
            <input id="tval" class="nx-input" disabled value="0" />
            <span class="muted small">{dev.name} runs {dev.version && dev.version !== 'v0.0.0' ? dev.version.replace(/^v/, '') : 'its current firmware'}. Until it has firmware 5.6 the input reads 0 after a timeout. <a href={href('hardware', 'firmware')}>Update firmware</a></span>
            {:else}
            {#if useFlag}<Checkbox bind:checked={f.timeoutUseValue} label="Use a value instead of 0" hint="Off: the input reads 0 and off, as before." disabled={!f.timeoutEnabled} data-testid="timeout-use-value" />{/if}
            <input id="tval" class="nx-input" type="number" step="any" bind:value={f.timeoutValue} disabled={!f.timeoutEnabled || (useFlag && !f.timeoutUseValue)} data-testid="timeout-value" />
            <span class="muted small">What the input reads while the frame is missing, for example 0 for "off" or a safe temperature. The on/off result follows the same test.</span>
            {/if}
          </div>
        </Card>
        <UsedBy {guid} items={M.usedBy} />
        <p class="muted small">{learnedNote ? 'Learned from the bus: check it with the real switch. The live value above should flip when you do.' : 'Check the live value against the dash or a scan tool before you rely on it. A wrong byte order is the usual cause of odd numbers.'}</p>
      </div>
    </div>

    <SaveBar {dirty} saving={M.state.saving} {problem} err={M.state.saveErr} note={M.state.note} connected={online} onsave={save} onrevert={revert} />
    <LearnSwitch bind:open={learnOpen} onuse={useLearned} />
  {/if}
</Page>

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: var(--space-4); align-items: start; }
  .col { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  .pin { font-size: var(--text-md); padding: 4px 10px; border-radius: var(--radius-sm); background: var(--color-raised); }
  .pill { display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 999px; background: var(--color-raised); font-weight: 600; }
  .pill[data-tone='on'] { background: var(--color-on-soft); }
  .pill[data-tone='fault'] { background: var(--color-fault-soft); }
  .rows { display: flex; flex-direction: column; gap: var(--space-2); max-height: 320px; overflow: auto; }
  .pick { display: flex; flex-direction: column; gap: 2px; text-align: left; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); border: 1px solid var(--color-line); background: transparent; min-height: 48px; }
  .pick:hover { background: var(--color-raised); }
  .pick[aria-pressed='true'] { border: 2px solid var(--color-focus); background: var(--color-raised); }
  .a { display: flex; justify-content: space-between; gap: var(--space-3); }
  .learn { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-raised); flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-3); align-items: start; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  .grp { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start; }
  .dec { font-size: var(--text-3xl); font-weight: 700; font-family: var(--font-mono); }
  .bytes { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
  .bytes span { display: flex; flex-direction: column; align-items: center; padding: 4px; border-radius: var(--radius-sm); background: var(--color-raised); border: 1px solid var(--color-line); }
  .bytes span.hl { border-color: var(--color-on); background: var(--color-on-soft); }
  .bytes small { font-size: 11px; color: var(--color-text-muted); }
  .tv { display: flex; flex-direction: column; gap: var(--space-2); }
  .small { font-size: var(--text-xs); }
</style>
