<script>
  import { Page, PageHeader, Button, Banner, Card, Chip, Empty, Dialog, LineChart, Segmented, StateDot } from '../../ui/index.js'
  import { live, api, defs, read, toast } from '../../lib/live.svelte.js'
  import { href } from '../../router.svelte.js'
  import { outputRatingA } from '../../../lib/apply.js'
  import { readAllTrips, tripTitle, whenText, noticeText } from './parts/trips.js'
  import { tripFixes } from './parts/tripFixes.js'
  import LiveTabs from './parts/LiveTabs.svelte'

  let { guid = undefined, index = undefined } = $props()

  let data = $state({ items: [], notices: [], errors: [], loaded: false })
  let reading = $state(false)
  let sel = $state('')
  // follow the URL: a link to another trip while this page is open changes the selection
  $effect.pre(() => { if (guid != null && index != null) sel = `${guid}:${index}` })
  let zoom = $state('whole')

  const logDevices = $derived(live.devices.filter((d) => (d.outputs ?? []).length > 0))
  const answering = $derived(logDevices.filter((d) => d.connected))
  const silent = $derived(logDevices.filter((d) => !d.connected))

  async function load() {
    reading = true
    try {
      data = { ...(await readAllTrips(answering, (part) => (data = { ...part, loaded: false }))), loaded: true }
    } finally { reading = false }
  }
  // Read once the live modules are known; the log lives on the modules, so there is nothing to poll.
  let started = false
  $effect(() => {
    if (!started && live.connected && answering.length) { started = true; load() }
  })

  const grouped = $derived.by(() => {
    const m = new Map()
    for (const d of logDevices) m.set(d.guid, { dev: d, items: [] })
    for (const t of data.items) m.get(t.guid)?.items.push(t)
    return [...m.values()].filter((g) => g.items.length || data.errors.some((e) => e.guid === g.dev.guid))
  })
  const current = $derived(data.items.find((t) => `${t.guid}:${t.index}` === sel) ?? data.items[0] ?? null)

  function pick(t, e) {
    e?.preventDefault()
    sel = `${t.guid}:${t.index}`
    try { history.replaceState(null, '', href('live', 'trips', t.guid, t.index)) } catch { /* keep the selection in memory only */ }
  }

  // ---- waveform ----
  const dts = $derived(current?.samples?.map((s) => s.dt) ?? [])
  const range = $derived.by(() => {
    if (!dts.length) return { a: -10, b: 3 }
    if (zoom === 'whole') return { a: dts[0], b: dts.at(-1) }
    const on = current?.onS
    return { a: Math.max(dts[0], Math.min(-1, -((on ?? 0.7) + 0.3))), b: Math.min(dts.at(-1), 0.6) }
  })
  const pts = $derived((current?.samples ?? []).filter((s) => s.dt >= range.a - 1e-9 && s.dt <= range.b + 1e-9))
  const yMax = $derived(Math.max(current?.peakA ?? 0, current?.limitA ?? 0, 1) * 1.15)
  const pos = (t) => ((t - range.a) / (range.b - range.a || 1)) * 100
  const ticks = $derived.by(() => {
    const t = []
    const inRange = (x) => x >= range.a && x <= range.b
    if (zoom === 'whole') {
      for (const x of [-10, -5]) if (inRange(x)) t.push({ x, label: `−${-x} s` })
    } else {
      for (const x of [range.a, range.a / 2]) t.push({ x, label: `−${Math.abs(x).toFixed(1)} s` })
    }
    t.push({ x: 0, label: 'trip', strong: true })
    t.push({ x: range.b, label: `+${range.b.toFixed(range.b % 1 ? 1 : 0)} s` })
    return t
  })
  const onAt = $derived(current?.onS != null && current.onS > 0.04 && inRangeX(-current.onS) ? -current.onS : null)
  function inRangeX(x) { return x >= range.a && x <= range.b }
  const waveLabel = $derived(current ? `${tripTitle(current)}. Current around the trip: peak ${current.peakA.toFixed(1)} A against a limit of ${current.limitA} A${current.onS != null ? ', switched on ' + current.onS.toFixed(2) + ' s before the trip' : ''}.` : '')
  const rating = $derived(current ? outputRatingA(defs, live.devices.find((d) => d.guid === current.guid)?.type, current.output) : null)
  const fixes = $derived(current ? tripFixes(current, rating) : [])

  // ---- clear (the only record: confirm first) ----
  let confirmFor = $state(null)
  let clearing = $state(false)
  async function clearLog() {
    const d = confirmFor
    if (!d) return
    clearing = true
    // clearing a module's trip log is not a project change, so the project is not marked unsaved
    const r = await read(() => api.overloadsClear(d.guid))
    clearing = false
    if (r !== undefined) {
      toast(`Cleared the trip log on ${d.name}.`, 'info', 2500)
      confirmFor = null; sel = ''
      await load()
    }
  }
</script>

<Page wide>
  <PageHeader title="Live">
    {#snippet tag()}<LiveTabs current="trips" />{/snippet}
    {#snippet actions()}
      <Button busy={reading} onclick={load} disabled={!answering.length}>Read trip logs again</Button>
    {/snippet}
  </PageHeader>

  {#if !live.connected}
    <Banner tone="warn" title="Not connected to the car.">Trip logs are stored on the modules. Connect to read them.
      {#snippet actions()}<Button size="sm" href="#/next/connect">Connect</Button>{/snippet}
    </Banner>
  {/if}
  {#each data.errors as e (e.guid)}
    <Banner tone="warn" title={`Could not read the trip log of ${e.dev}.`}>{e.message}</Banner>
  {/each}
  {#if silent.length && live.connected}
    <Banner tone="info" title={`${silent.map((d) => d.name).join(', ')} not answering.`}>Their trip logs are not shown. A module has to be on the bus to read its log.</Banner>
  {/if}

  {#if reading && !data.items.length && !data.errors.length}
    <p class="muted" role="status">Reading the trip logs from the modules…</p>
  {:else if data.loaded && !data.items.length && !reading}
    <Empty title="No trips are logged on the modules" text="Each module records its own output trips, with a −10 s to +3 s current waveform around each one, so a trip that happened while the laptop was away is still here. When an output trips it shows up on this page.">
      {#snippet actions()}<Button href="#/next/live">Back to the dashboard</Button>{/snippet}
    </Empty>
  {:else if current}
    <div class="cols">
      <nav class="list" aria-label="Trips">
        <p class="muted small">Listed by module, newest first. Modules on firmware older than 5.6 do not record when a trip happened; theirs are in log order.</p>
        {#each grouped as g (g.dev.guid)}
          <div class="gh"><strong>{g.dev.name}</strong><span class="muted">{g.items.length} {g.items.length === 1 ? 'trip' : 'trips'}</span>
            <Button size="sm" variant="danger" disabled={!g.dev.connected || !g.items.length} onclick={() => (confirmFor = g.dev)} aria-label={`Clear trip log on ${g.dev.name}`}>Clear log</Button>
          </div>
          {#each g.items as t (t.index)}
            <a class="trip" class:on={current.guid === t.guid && current.index === t.index} href={href('live', 'trips', t.guid, t.index)} aria-current={current.guid === t.guid && current.index === t.index ? 'true' : undefined} onclick={(e) => pick(t, e)} data-testid="trip-row">
              <StateDot tone="fault" shape={t.state === 'Fault' ? 'square' : 'diamond'} />
              <span class="tx"><strong>{t.outName || 'Output ' + t.output}</strong><span class="muted">{t.at ? whenText(t.at) + ' · ' : ''}{t.state} · {t.peakA.toFixed(1)} A · limit {t.limitA} A · out {t.output}</span></span>
            </a>
          {/each}
        {/each}
      </nav>

      <div class="detail">
        <header class="dh">
          <nav aria-label="Breadcrumb" class="cr muted"><a href="#/next/live">Live</a> › <a href="#/next/live/trips">Trips</a> › <span>{current.dev} · {current.outName || 'Output ' + current.output}</span></nav>
          <h2 data-testid="trip-title">{tripTitle(current)}: {current.peakA.toFixed(1)} A, limit {current.limitA} A</h2>
          <p class="muted">{current.at ? whenText(current.at) + ' · ' : ''}{current.dev} out {current.output}{current.kind === 'inrush' ? ' · judged against the inrush limit' : ''} · {current.text}{current.clears ? ' · ' + current.clears : ''}</p>
          <div class="chips"><Chip tone="fault" symbol="■">{current.state}</Chip>{#if current.out?.resetMode}<Chip tone="muted">auto retry on</Chip>{/if}</div>
        </header>

        <Card title="Current around the trip" subtitle="one point every 40 ms · 0.5 A steps">
          {#snippet actions()}
            <Segmented size="sm" label="Zoom" bind:value={zoom} items={[{ value: 'whole', label: 'Whole recording' }, { value: 'trip', label: 'Zoom on the trip' }]} />
          {/snippet}
          {#if pts.length > 1}
            <div class="cw">
              <LineChart series={[{ label: 'Current', values: pts.map((s) => s.i), color: 'var(--color-on)' }]} min={0} max={yMax} height={280}
                lines={[{ value: current.limitA, label: `limit ${current.limitA} A`, tone: 'warn' }]} over={{ value: current.limitA, tone: 'fault' }} label={waveLabel} />
              <span class="mk trip" aria-hidden="true" style="left: calc(8px + (100% - 16px) * {pos(0) / 100})"></span>
              {#if onAt != null}<span class="mk on" aria-hidden="true" style="left: calc(8px + (100% - 16px) * {pos(onAt) / 100})"></span>{/if}
            </div>
            <div class="ax mono" aria-hidden="true">
              {#each ticks as k (k.label)}<span class:strong={k.strong} style="left: calc(8px + (100% - 16px) * {pos(k.x) / 100})">{k.label}</span>{/each}
              {#if onAt != null}<span class="onl" style="left: calc(8px + (100% - 16px) * {pos(onAt) / 100})">switched on</span>{/if}
            </div>
            <p class="muted small">Peak {current.peakA.toFixed(1)} A at the trip. Orange dashed line: the limit that fired ({current.kind === 'inrush' ? 'inrush' : 'steady'}). The part above it is drawn in the fault colour.</p>
          {:else}
            <p class="muted">This trip has no waveform. The module fills it in 3 s after the trip.</p>
          {/if}
        </Card>

        <section class="fixes" aria-label="What to do">
          {#each fixes as f (f.tag + f.title)}
            <div class="fix" class:accent={f.tone === 'accent'}>
              <span class="tag">{f.tag}</span>
              <strong>{f.title}</strong>
              <span class="muted why">{f.why}</span>
              <Button size="sm" href={f.href}>{f.label} →</Button>
            </div>
          {/each}
        </section>
      </div>
    </div>
  {/if}

  {#if data.notices?.length}
    <Card title="Notices" subtitle="Outputs that went over their warning level or had nothing connected (firmware 5.6). No waveform: they did not trip." aria-label="Notices">
      <ul class="notices" data-testid="notices">
        {#each data.notices as n (n.guid + ':' + n.index)}
          <li><StateDot tone="warn" shape="diamond" /> <span>{n.at ? whenText(n.at) + ' · ' : ''}<strong>{n.dev}</strong> · {noticeText(n)}</span></li>
        {/each}
      </ul>
    </Card>
  {/if}
</Page>

<Dialog bind:open={() => !!confirmFor, (v) => { if (!v) confirmFor = null }} title={`Clear the trip log on ${confirmFor?.name ?? ''}?`} description="The log is the only record of these trips. Clearing it cannot be undone.">
  {#snippet footer()}
    <Button onclick={() => (confirmFor = null)}>Cancel</Button>
    <Button variant="danger" busy={clearing} onclick={clearLog}>Clear trip log</Button>
  {/snippet}
</Dialog>

<style>
  .notices { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .cols { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: var(--space-5); align-items: start; }
  @media (max-width: 1000px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  .list { display: flex; flex-direction: column; gap: var(--space-2); }
  .small { font-size: var(--text-xs); }
  .gh { display: flex; align-items: center; gap: var(--space-2); margin-top: var(--space-2); }
  .gh strong { flex: 1 1 auto; }
  .trip { display: flex; align-items: center; gap: var(--space-3); min-height: var(--target-min); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); border: 1px solid var(--color-line); color: var(--color-text); text-decoration: none; background: transparent; }
  .trip:hover { background: var(--color-raised); }
  .trip.on { border-color: var(--color-focus); background: var(--color-raised); }
  .tx { display: flex; flex-direction: column; min-width: 0; font-size: var(--text-sm); }
  .tx .muted { font-size: var(--text-xs); }
  .detail { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .dh { display: flex; flex-direction: column; gap: var(--space-2); }
  .cr { font-size: var(--text-sm); }
  .cr a { color: var(--color-text-muted); }
  .chips { display: flex; gap: var(--space-2); }
  h2 { font-size: var(--text-xl); font-weight: 700; }
  .cw { position: relative; }
  .mk { position: absolute; top: 8px; bottom: 8px; width: 0; pointer-events: none; }
  .mk.trip { border-left: 2px solid var(--color-fault); }
  .mk.on { border-left: 2px dotted var(--color-text-muted); }
  .ax { position: relative; height: 34px; font-size: 11px; color: var(--color-text-muted); }
  .ax span { position: absolute; top: 2px; transform: translateX(-50%); white-space: nowrap; }
  .ax span.strong { color: var(--color-fault); font-weight: 700; }
  .ax .onl { top: 16px; }
  .fixes { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-3); }
  .fix { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start; border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); padding: var(--space-4); }
  .fix.accent { border-color: var(--color-focus); }
  .tag { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); }
  .fix.accent .tag { color: var(--color-accent); }
  .why { font-size: var(--text-sm); }
</style>
