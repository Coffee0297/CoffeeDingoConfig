<script>
  import { untrack } from 'svelte'
  import { Page, PageHeader, Button, Banner, Empty, StateDot, FwBadge } from '../../ui/index.js'
  import { live, project, pendingModules } from '../../lib/live.svelte.js'
  import { ignitionTile } from '../power/parts/ignition.js'
  import { ui } from '../../shell/ui.svelte.js'
  import { href } from '../../router.svelte.js'
  import { worstCaseA, outputCounts, isTripped, isOn, fmt1, num, olderFirmware } from './parts/summary.js'
  import CarMap from './parts/CarMap.svelte'
  import { readAllTrips, whenText } from '../live/parts/trips.js'
  import { useEcu } from '../live/parts/ecu.svelte.js'

  const ecu = useEcu()
  const devices = $derived(live.devices)
  const answering = $derived(devices.filter((d) => d.connected))
  const pdms = $derived(answering.filter((d) => /pdm/i.test(d.type)))
  const title = $derived(project.current ? project.current.replace(/\.json$/i, '') : 'Your car')

  const battery = $derived(pdms.length ? Math.max(...pdms.map((d) => num(d.battery))) : null)
  const totalA = $derived(pdms.reduce((s, d) => s + num(d.current), 0))
  const worstA = $derived(worstCaseA(devices))
  const counts = $derived(outputCounts(devices))
  const hottest = $derived.by(() => {
    const t = answering.filter((d) => Number.isFinite(d.temp))
    if (!t.length) return null
    const top = t.reduce((a, b) => (b.temp > a.temp ? b : a))
    const tied = t.filter((d) => Math.round(d.temp) === Math.round(top.temp)).length
    return { temp: top.temp, who: tied === 1 ? top.name : tied === t.length ? `all ${tied} modules` : `${tied} modules` }
  })
  const ign = $derived(ignitionTile(live.devices))
  const differing = $derived(pendingModules())
  const older = $derived(olderFirmware(devices))

  // ---- trip log (read from the modules; firmware 5.6 adds when each trip happened) ----
  let trips = $state({ items: [], errors: [], loaded: false })
  const trippedNow = $derived(answering.flatMap((d) => (d.outputs ?? []).filter(isTripped).map((o) => ({ d, o }))))
  const trippedKey = $derived(trippedNow.map((t) => t.d.guid + ':' + t.o.number + ':' + t.o.state).join(','))
  const answeringKey = $derived(answering.map((d) => d.guid).join(','))
  $effect(() => {
    trippedKey; answeringKey
    if (!live.connected || !answering.length) return
    let alive = true
    const id = setTimeout(async () => {
      const r = await readAllTrips(answering)
      if (alive) trips = { ...r, loaded: true }
    }, 400)
    return () => { alive = false; clearTimeout(id) }
  })

  const needs = $derived.by(() => {
    const list = []
    if (devices.length && !live.connected) {
      list.push({ id: 'conn', tone: 'warn', title: 'Not connected to the car', detail: 'Live values are not updating.', label: 'Connect', href: '#/next/connect' })
    } else {
      for (const d of devices.filter((x) => !x.connected)) {
        list.push({ id: 'nf-' + d.guid, tone: 'fault', title: `${d.name} is not answering`, detail: 'Check its power and the CAN cable. A module that is asleep also looks like this.', label: 'Open', href: href('hardware', 'module', d.guid) })
      }
    }
    for (const { d, o } of trippedNow) {
      const ev = [...trips.items].reverse().find((t) => t.guid === d.guid && t.output === o.number)
      list.push({
        id: `trip-${d.guid}-${o.number}`, tone: 'fault',
        title: `${o.name?.trim() || 'Output ' + o.number} ${/fault/i.test(o.state) ? 'has a fault' : 'tripped'}`,
        detail: `${d.name} out ${o.number}` + (ev ? ` · ${ev.peakA.toFixed(1)} A peak, limit ${ev.limitA} A` : ` · limit ${o.currentLimit} A`),
        label: 'Why?', href: ev ? href('live', 'trips', d.guid, ev.index) : href('live', 'trips'),
      })
    }
    const stored = trips.items.length
    if (stored) {
      const mods = [...new Set(trips.items.map((t) => t.dev))].join(', ')
      const latest = trips.items.map((t) => t.at).filter(Boolean).sort().at(-1)
      list.push({ id: 'stored', tone: 'warn', title: `${stored} ${stored === 1 ? 'trip is' : 'trips are'} in the module logs`, detail: `${mods} · ${latest ? 'newest ' + whenText(latest) : 'these modules do not record when it happened'}`, label: 'Open trips', href: href('live', 'trips') })
    }
    if (differing.length) {
      list.push({ id: 'diff', tone: 'warn', title: `${differing.length} ${differing.length === 1 ? 'module differs' : 'modules differ'} from the project`, detail: differing.map((d) => d.name).join(', '), label: 'Review', onclick: () => (ui.panel = 'apply') })
    }
    if (ign?.value === 'Not set up') {
      list.push({ id: 'ign', tone: 'warn', title: 'Ignition is not set up', detail: 'Pick the switch and start button so outputs can follow the ignition.', label: 'Set up', href: href('power', 'ignition') })
    }
    if (older.length) {
      list.push({ id: 'fw', tone: 'warn', title: `${older.length} ${older.length === 1 ? 'module has' : 'modules have'} older firmware`, detail: older.map((o) => `${o.dev.name} ${o.dev.version}`).join(', ') + ` · newest in the car is ${older[0].newest}`, label: 'Firmware', href: href('hardware', 'firmware') })
    }
    return list
  })

  // Smoothed so the list does not jump with every telemetry frame: each current is averaged over ~1.5 s,
  // the order is redone at most every 3 s, and a row stays 5 s after its output goes off (flashers, PWM).
  // ponytail: browser-side smoothing; tune TAU / REORDER / LINGER if it feels slow or still jumpy.
  const TAU = 1500, REORDER = 3000, LINGER = 5000
  let avg = $state({}), order = [], orderAt = 0, lastT = 0
  const seenOn = {}
  const rkey = (d, o) => d.guid + ':' + o.number
  $effect(() => {
    const now = Date.now(), dt = lastT ? now - lastT : TAU
    lastT = now
    const a = Math.min(1, dt / TAU), next = {}, prev = untrack(() => avg)   // read untracked: this effect writes avg
    for (const d of answering) for (const o of d.outputs ?? []) {
      const k = rkey(d, o)
      if (isOn(o) || isTripped(o)) seenOn[k] = now
      next[k] = prev[k] == null ? num(o.current) : prev[k] + a * (num(o.current) - prev[k])
    }
    avg = next
  })
  const running = $derived.by(() => {
    const now = Date.now()
    const rows = answering.flatMap((d) => (d.outputs ?? []).filter((o) => isOn(o) || isTripped(o) || now - (seenOn[rkey(d, o)] ?? 0) < LINGER).map((o) => ({ d, o, k: rkey(d, o), a: avg[rkey(d, o)] ?? num(o.current) })))
    const keys = rows.map((r) => r.k)
    if (now - orderAt > REORDER || keys.some((k) => !order.includes(k))) {
      order = [...rows].sort((x, y) => y.a - x.a).map((r) => r.k)
      orderAt = now
    }
    return rows.sort((x, y) => order.indexOf(x.k) - order.indexOf(y.k))
  })
  let showAllRunning = $state(false)
  const runShown = $derived(showAllRunning ? running : running.slice(0, 8))

  const subtitle = $derived(
    devices.length
      ? `${answering.length} of ${devices.length} modules live · ${counts.on} of ${counts.total} outputs on · ${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} a look`
      : 'No modules yet',
  )
  const dash = '-'
</script>

<Page wide>
  <PageHeader title={title} {subtitle}>
    {#snippet actions()}
      <Button onclick={() => (ui.addModule = true)}>Find modules</Button>
      <Button variant="primary" href="#/next/functions/add">+ Add function</Button>
    {/snippet}
  </PageHeader>

  {#if !devices.length}
    <Empty title="No modules in this project yet" text="Connect the USB adapter and find your modules, or open a saved project.">
      {#snippet actions()}
        <Button variant="primary" href="#/next/connect">Connect to the car</Button>
        <Button onclick={() => (ui.addModule = true)}>Find modules</Button>
      {/snippet}
    </Empty>
  {:else}
    {#if !live.connected}
      <Banner tone="warn" title="Not connected to the car.">Values below are blank until you connect.
        {#snippet actions()}<Button size="sm" href="#/next/connect">Connect</Button>{/snippet}
      </Banner>
    {/if}

    <div class="stats" aria-label="Car summary">
      <div class="stat"><span class="l">Battery</span><span class="n mono" data-testid="stat-battery">{battery != null && live.connected ? battery.toFixed(1) : dash}<small> V</small></span><span class="s" class:ok={battery >= 13.2}>{battery == null ? 'no PDM answering' : battery >= 13.2 ? 'charging' : 'not charging'}</span></div>
      <div class="stat"><span class="l">Total current</span><span class="n mono" data-testid="stat-current">{live.connected ? totalA.toFixed(1) : dash}<small> A</small></span><span class="s" title="of {Math.round(worstA)} A if every output hit its limit">of {Math.round(worstA)} A if every output hit its limit</span></div>
      {#if ecu.rpm != null}
        <div class="stat"><span class="l">Engine</span><span class="n mono">{Math.round(ecu.rpm)}<small> rpm</small></span><span class="s">from {ecu.source}{ecu.gear != null ? ' · gear ' + ecu.gear : ''}</span></div>
      {/if}
      <div class="stat"><span class="l">Hottest module</span><span class="n mono" data-testid="stat-temp">{hottest ? Math.round(hottest.temp) : dash}<small> °C</small></span><span class="s">{hottest ? hottest.who : 'no module answering'}</span></div>
      <div class="stat"><span class="l">Outputs on</span><span class="n mono" data-testid="stat-outputs">{counts.on}<small> of {counts.total}</small></span><span class="s">enabled outputs that are switched on</span></div>
      <div class="stat"><span class="l">Matches the project</span><span class="n mono">{differing.length ? differing.length + ' differ' : 'All'}</span><span class="s" class:warn={differing.length}>{differing.length ? 'Apply to car sends them' : 'modules hold the project settings'}</span></div>
      {#if ign}
        <a class="stat link" href={href('power', 'ignition')}><span class="l">Ignition</span><span class="n" data-testid="stat-ignition">{ign.value}</span>{#if ign.value === 'Not set up'}<span class="s cta">Set up ignition →</span>{:else}<span class="s">{ign.sub}</span>{/if}</a>
      {:else}<div class="stat dis"><span class="l">Ignition</span><span class="n"><FwBadge version="5.6" /></span><span class="s">start button and ignition state</span></div>{/if}
    </div>

    <div class="cols">
      <CarMap {devices} />

      <div class="side">
        <section class="panel" aria-label="Needs a look">
          <h2>Needs a look</h2>
          {#each needs as n (n.id)}
            <div class="need" data-tone={n.tone}>
              <span class="mk" aria-hidden="true"></span>
              <span class="tx"><strong>{n.title}</strong><span class="muted">{n.detail}</span></span>
              {#if n.href}<Button size="sm" href={n.href}>{n.label}</Button>{:else}<Button size="sm" onclick={n.onclick}>{n.label}</Button>{/if}
            </div>
          {:else}
            <p class="ok"><StateDot tone="ok" label="Nothing needs a look." /></p>
          {/each}
          {#if trips.errors.length}
            <p class="muted small">Could not read the trip log of {trips.errors.map((e) => e.dev).join(', ')}.</p>
          {/if}
        </section>

        <section class="panel grow" aria-label="On right now">
          <div class="ph"><h2>On right now</h2><a href="#/next/functions">All functions →</a></div>
          {#each runShown as r (r.d.guid + ':' + r.o.number)}
            <a class="row" href={href('hardware', 'module', r.d.guid, 'output', r.o.number)}>
              <StateDot tone={isTripped(r.o) ? 'fault' : 'on'} shape={isTripped(r.o) ? 'square' : 'dot'} />
              <span class="nm">{r.o.name?.trim() || 'Output ' + r.o.number}<small class="muted">{r.d.name}</small></span>
              <span class="why muted">{isTripped(r.o) ? r.o.state : r.o.input ? 'from ' + r.o.input : ''}</span>
              <span class="val mono">{fmt1(r.a)} A</span>
            </a>
          {:else}
            <p class="muted">{live.connected ? 'No outputs are on.' : 'Connect to see what is on.'}</p>
          {/each}
          {#if running.length > 8}
            <Button size="sm" variant="ghost" onclick={() => (showAllRunning = !showAllRunning)} aria-expanded={showAllRunning}>{showAllRunning ? 'Show fewer' : `Show all ${running.length}`}</Button>
          {/if}
        </section>
      </div>
    </div>
  {/if}
</Page>

<style>
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-3); }
  .stat { border-radius: var(--radius-lg); border: 1px solid var(--color-line); background: var(--color-surface); padding: var(--space-2) var(--space-4); display: flex; flex-direction: column; gap: 2px; min-width: 0; color: var(--color-text); text-decoration: none; }
  a.stat:hover { background: var(--color-raised); }
  .stat.dis { border-style: dashed; }
  .l { font-size: var(--text-xs); color: var(--color-text-muted); }
  .n { font-size: 24px; font-weight: 500; line-height: 1.2; }
  .n small { font-size: var(--text-sm); color: var(--color-text-muted); }
  .s { font-size: var(--text-xs); color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s.cta { color: var(--color-accent); font-weight: 600; }
  .s.ok { color: var(--color-ok); }
  .s.warn { color: var(--color-warn); }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, 480px); gap: var(--space-4); align-items: start; }
  @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  .side { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .panel { border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); padding: var(--space-4) var(--space-5); display: flex; flex-direction: column; gap: var(--space-2); }
  h2 { font-size: var(--text-lg); font-weight: 700; }
  .ph { display: flex; align-items: center; justify-content: space-between; }
  .ph a { font-weight: 600; font-size: var(--text-sm); }
  .need { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-md); background: var(--bg); }
  .need[data-tone='fault'] { --bg: var(--color-fault-soft); --c: var(--color-fault); }
  .need[data-tone='warn'] { --bg: var(--color-warn-soft); --c: var(--color-warn); }
  .mk { flex: none; width: 10px; height: 10px; background: var(--c); }
  .need[data-tone='fault'] .mk { transform: rotate(45deg); }
  .need[data-tone='warn'] .mk { width: 0; height: 0; background: none; border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 10px solid var(--c); }
  .tx { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; font-size: var(--text-sm); }
  .small { font-size: var(--text-xs); }
  .row { display: flex; align-items: center; gap: var(--space-3); min-height: var(--target-min); border-bottom: 1px solid var(--color-line); color: var(--color-text); text-decoration: none; }
  .row:hover { background: var(--color-raised); }
  .nm { flex: 1 1 auto; font-weight: 500; display: flex; flex-direction: column; min-width: 0; }
  .nm small { font-size: 11px; }
  .why { font-size: var(--text-xs); max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .val { width: 70px; text-align: right; font-size: var(--text-sm); }
</style>
