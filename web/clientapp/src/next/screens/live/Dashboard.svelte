<script>
  import { Page, PageHeader, Banner, Checkbox, Select, Empty, FwBadge, Button } from '../../ui/index.js'
  import { live, hub, tempLimits } from '../../lib/live.svelte.js'
  import { ignitionTile } from '../power/parts/ignition.js'
  import { href } from '../../router.svelte.js'
  import { feed, watchSignals, resample, keys } from './parts/feed.svelte.js'
  import { useEcu } from './parts/ecu.svelte.js'
  import { isTripped, isOn, num, worstCaseA } from '../car/parts/summary.js'
  import LiveTabs from './parts/LiveTabs.svelte'
  import Tile from './parts/Tile.svelte'

  // temperature as a share of the all-off limit (G18), so the bar fills toward the shutdown
  const tempBar = (d, lim) => (lim ? { pct: (d.temp / lim.crit) * 100 } : {})

  let showHidden = $state(false)
  let moduleKey = $state('all')
  const ecu = useEcu()

  const all = $derived(live.devices)
  const devs = $derived(moduleKey === 'all' ? all : all.filter((d) => d.guid === moduleKey))
  const moduleItems = $derived([{ value: 'all', label: 'All modules' }, ...all.map((d) => ({ value: d.guid, label: d.name }))])

  const guidKey = $derived(devs.map((d) => d.guid).join(','))
  $effect(() => watchSignals(guidKey ? guidKey.split(',') : []))

  const spark = (key) => { feed.tick; return resample(key, 60, 48).values }
  const q = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-')

  // ---- CAR group ----
  const carTiles = $derived.by(() => {
    const t = []
    const on = live.connected
    const answering = devs.filter((d) => d.connected)
    const pdms = answering.filter((d) => /pdm/i.test(d.type))
    const one = moduleKey !== 'all'
    const who = one ? devs[0]?.name ?? '' : 'all'
    if (pdms.length) {
      const b = Math.max(...pdms.map((d) => num(d.battery)))
      t.push({ id: 'batt', name: one ? 'Battery' : 'Battery', mod: one ? who : 'highest PDM', value: q(b), unit: 'V', sub: b >= 13.2 ? 'charging' : 'not charging', tone: 'on', key: one ? keys.batt(devs[0].guid) : keys.battMax, href: href('hardware'), graph: href('live', 'plot', { signal: one ? keys.batt(devs[0].guid) : keys.battMax }) })
      const tot = pdms.reduce((s, d) => s + num(d.current), 0)
      const worst = worstCaseA(devs)
      t.push({ id: 'cur', name: 'Total current', mod: who, value: q(tot), unit: 'A', pct: worst ? (tot / worst) * 100 : null, sub: `of ${Math.round(worst)} A worst case`, tone: 'on', key: one ? keys.cur(devs[0].guid) : keys.total, href: href('hardware', 'outputs'), graph: href('live', 'plot', { signal: one ? keys.cur(devs[0].guid) : keys.total }) })
    }
    const temps = answering.filter((d) => Number.isFinite(d.temp))
    if (!one && temps.length) {
      const h = temps.reduce((a, b) => (b.temp > a.temp ? b : a))
      const lim = tempLimits(h)
      t.push({ id: 'temp', name: one ? 'Temperature' : 'Hottest module', mod: h.name, value: String(Math.round(h.temp)), unit: '°C', ...tempBar(h, lim), sub: lim ? `OverTemp at ${lim.warn} °C · all off at ${lim.crit} °C` : 'limit not known yet', tone: /overtemp/i.test(h.state ?? '') ? 'fault' : lim && h.temp >= lim.warn ? 'warn' : 'on', key: one ? keys.temp(h.guid) : keys.hottest, href: href('hardware', 'module', h.guid), graph: href('live', 'plot', { signal: one ? keys.temp(h.guid) : keys.hottest }) })
    }
    if (!one && ecu.rpm != null) t.push({ id: 'rpm', name: 'Engine', mod: ecu.source, value: String(Math.round(ecu.rpm)), unit: 'rpm', sub: ecu.gear != null ? 'gear ' + ecu.gear : '', tone: 'on', key: null, href: href('hardware', 'module', ecu.guid) })
    if (!one && ecu.coolant != null) t.push({ id: 'cool', name: 'Coolant', mod: ecu.source, value: String(Math.round(ecu.coolant)), unit: '°C', sub: '', tone: 'on', key: null, href: href('hardware', 'module', ecu.guid) })
    if (!on) return []
    return t
  })

  // ---- MODULES group: one temperature tile per module ----
  const moduleTiles = $derived(
    live.connected
      ? devs.filter((d) => d.connected && Number.isFinite(d.temp)).map((d) => ({
          id: 'mod-' + d.guid, name: 'Temperature', mod: d.name, value: String(Math.round(d.temp)), unit: '°C', ...tempBar(d, tempLimits(d)),
          sub: (/pdm/i.test(d.type) ? 'dingoPDM' : 'CANBoard') + (d.state ? ' · ' + d.state : ''), tone: /overtemp|error/i.test(d.state ?? '') ? 'fault' : /sleep/i.test(d.state ?? '') ? 'off' : 'on',
          key: keys.temp(d.guid), href: href('hardware', 'module', d.guid), graph: href('live', 'plot', { signal: keys.temp(d.guid) }),
        }))
      : [],
  )

  // ---- OUTPUTS group ----
  // An output stays in OUTPUTS ON for 5 s after it switches off, so a short pulse or a flasher can be seen.
  const LINGER_MS = 5000
  const lastOn = {}   // tile id -> when it was last seen on (plain: telemetry ticks re-run the list)
  const outputTiles = $derived.by(() => {
    const shown = [], hidden = [], now = Date.now()
    for (const d of devs) for (const o of d.outputs ?? []) {
      const tripped = isTripped(o), on = isOn(o)
      const id = `${d.guid}:${o.number}`
      if (d.connected && (on || tripped)) lastOn[id] = now
      const lingering = d.connected && !on && !tripped && now - (lastOn[id] ?? -Infinity) < LINGER_MS
      const tile = {
        id: `${d.guid}:${o.number}`, name: o.name?.trim() || `Output ${o.number}`, mod: d.name,
        value: !d.connected ? 'No data' : tripped ? o.state : q(num(o.current)), unit: !d.connected || tripped ? '' : 'A',
        pct: d.connected && o.currentLimit ? (num(o.current) / o.currentLimit) * 100 : null,
        sub: !d.connected ? 'module not answering' : tripped ? `limit ${o.currentLimit} A` : lingering ? `off ${Math.round((now - lastOn[id]) / 1000)} s ago` : on ? `of ${o.currentLimit} A${o.warnLimit ? ' · warn at ' + o.warnLimit + ' A' : ''}` : o.enabled === false ? 'not enabled' : 'off',
        tone: !d.connected ? 'stale' : tripped ? 'fault' : on ? 'on' : 'off', key: keys.out(d.guid, o.number),
        href: href('hardware', 'module', d.guid, 'output', o.number), graph: href('live', 'plot', { signal: keys.out(d.guid, o.number) }),
      }
      if (d.connected && o.enabled !== false && (on || tripped || lingering)) shown.push(tile)
      else hidden.push({ ...tile, key: null })
    }
    return { shown, hidden }
  })

  // ---- SIGNALS group ----
  const word = (s) => (s.value === 'on' ? 'On' : s.value === 'off' ? 'Off' : s.value)
  const signalTiles = $derived.by(() => {
    feed.tick
    const shown = [], hidden = []
    for (const d of devs) {
      for (const s of feed.byGuid[d.guid] ?? []) {
        if (s.kind === 'Output') continue
        const enabled = s.enabled !== false
        const tile = {
          id: `${d.guid}:${s.name}`, name: s.name, mod: d.name, value: word(s), unit: s.kind === 'Analog input' ? 'mV' : '',
          sub: s.kind + (d.connected ? '' : ' · module not answering'), tone: !d.connected ? 'stale' : s.on ? 'on' : 'off', key: keys.sig(d.guid, s.name),
          href: href('hardware', 'module', d.guid), graph: href('live', 'plot', { signal: keys.sig(d.guid, s.name) }),
        }
        if (enabled) shown.push(tile); else hidden.push({ ...tile, key: null })
      }
    }
    return { shown, hidden }
  })

  const shownCount = $derived(carTiles.length + moduleTiles.length + outputTiles.shown.length + signalTiles.shown.length)
  const hiddenCount = $derived(outputTiles.hidden.length + signalTiles.hidden.length)
  const feedLost = $derived(hub.state !== 'live' || live.stale)
  const groups = $derived([
    { name: 'CAR', tiles: carTiles },
    { name: 'MODULES', tiles: moduleTiles },
    { name: 'OUTPUTS ON', tiles: showHidden ? [...outputTiles.shown, ...outputTiles.hidden] : outputTiles.shown },
    { name: 'SWITCHES & SIGNALS', tiles: showHidden ? [...signalTiles.shown, ...signalTiles.hidden] : signalTiles.shown },
  ])
</script>

<Page wide>
  <PageHeader title="Live">
    {#snippet tag()}<LiveTabs current="dashboard" />{/snippet}
    {#snippet actions()}
      <span class="muted count" role="status" data-testid="live-count">Showing {shownCount} enabled · {hiddenCount} hidden</span>
      <Checkbox bind:checked={showHidden} label="Show hidden" />
      <div class="sel"><Select items={moduleItems} bind:value={moduleKey} label="Module" hideLabel placeholder="All modules" /></div>
    {/snippet}
  </PageHeader>

  {#if !all.length}
    <Empty title="No modules in this project" text="Add or find your modules first, then their live values show up here.">
      {#snippet actions()}<Button variant="primary" href="#/next/connect">Connect to the car</Button>{/snippet}
    </Empty>
  {:else}
    {#if feedLost}
      <Banner tone="warn" title="Live values are not updating.">The app lost its live feed. Tiles show the last values it received.</Banner>
    {:else if !live.connected}
      <Banner tone="warn" title="Not connected to the car.">Connect the adapter to see live values.
        {#snippet actions()}<Button size="sm" href="#/next/connect">Connect</Button>{/snippet}
      </Banner>
    {/if}

    {#each groups as g (g.name)}
      <section class="grp" aria-label={g.name === 'CAR' ? 'Car' : g.name === 'MODULES' ? 'Modules' : g.name === 'OUTPUTS ON' ? 'Outputs' : 'Switches and signals'}>
        <h2 class="gh">{g.name}</h2>
        {#if g.tiles.length || g.name === 'CAR' || g.name === 'MODULES'}
          <div class="grid">
            {#each g.tiles as t (t.id)}
              <Tile name={t.name} mod={t.mod} value={t.value} unit={t.unit} pct={t.pct ?? null} sub={t.sub} tone={t.tone} spark={t.key ? spark(t.key) : []} href={t.href} graph={t.graph ?? ''} />
            {/each}
            {#if g.name === 'CAR' && moduleKey === 'all'}
              {@const ig = ignitionTile(live.devices)}
              {#if ig}<Tile name="Ignition" mod="" value={ig.value} unit="" sub={ig.sub} tone={ig.value === 'Cranking' ? 'warn' : 'muted'} spark={[]} href={href('power')} graph="" />
              {:else}<div class="tile-fw"><span>Ignition</span><FwBadge version="5.6" /><small class="muted">start button and ignition state</small></div>{/if}
            {/if}
          </div>
        {:else}
          <p class="muted">{g.name === 'OUTPUTS ON' ? 'No outputs are on right now.' : 'No enabled switches or signals yet.'}{#if hiddenCount} Turn on Show hidden to see the rest.{/if}</p>
        {/if}
      </section>
    {/each}
  {/if}
</Page>

<style>
  .count { font-size: var(--text-sm); }
  .sel { width: 190px; }
  .grp { display: flex; flex-direction: column; gap: var(--space-3); }
  .gh { font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: var(--space-3); }
  .tile-fw { border-radius: var(--radius-lg); border: 1px dashed var(--color-line-strong); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: 6px; align-items: flex-start; font-weight: 600; }
  :global(.sp .lc svg) { inset: 0; width: 100%; height: 100%; }
</style>
