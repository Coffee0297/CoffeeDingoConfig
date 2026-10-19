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
  import { wireLoad, wireLoadText } from '../hardware/parts/wireload.js'
  import ForceCan from './parts/ForceCan.svelte'

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

  // ---- MODULES group: one compact row per answering module (temperature, state, current) ----
  const moduleRows = $derived(
    live.connected
      ? devs.filter((d) => d.connected).map((d) => {
          const lim = tempLimits(d), t = Number.isFinite(d.temp) ? d.temp : null
          return {
            guid: d.guid, name: d.name, temp: t == null ? '-' : String(Math.round(t)), state: d.state || (/pdm/i.test(d.type) ? 'dingoPDM' : 'CANBoard'),
            current: /pdm/i.test(d.type) ? q(num(d.current)) : '', graph: href('live', 'plot', { signal: keys.temp(d.guid) }),
            tone: /overtemp|error/i.test(d.state ?? '') ? 'fault' : lim && t != null && t >= lim.warn ? 'warn' : /sleep/i.test(d.state ?? '') ? 'off' : 'on',
          }
        })
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
        sub: !d.connected ? 'module not answering' : tripped ? `limit ${o.currentLimit} A` : lingering ? `off ${Math.round((now - lastOn[id]) / 1000)} s ago` : on ? `of ${o.currentLimit} A${o.warnLimit ? ' · warn at ' + o.warnLimit + ' A' : ''}${wireLoad(o) ? ' · ' + wireLoadText(wireLoad(o)) : ''}` : o.enabled === false ? 'not enabled' : 'off',
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
  // where a signal tile leads: the pin or CAN input's own page, else the block in the flow builder (N = its slot)
  const PAGE = { 'Digital input': 'input', 'Analog input': 'analoginput', 'Rotary position': 'analoginput', 'Analog switch': 'analoginput', 'CAN input': 'caninput' }
  const BLOCK = { 'Virtual input': 'virtualinput', Condition: 'condition', Counter: 'counter', Flasher: 'flasher', Timer: 'timer', Table: 'table' }
  const signalHref = (guid, s) => !s.n ? href('hardware', 'module', guid)
    : PAGE[s.kind] ? href('hardware', 'module', guid, 'input', PAGE[s.kind], s.n)
    : s.kind === 'Digital output' ? href('hardware', 'module', guid, 'output', s.n)
    : BLOCK[s.kind] ? href('functions', 'flow', guid, `${BLOCK[s.kind]}:${s.n}`) : href('hardware', 'module', guid)
  const signalTiles = $derived.by(() => {
    feed.tick
    const shown = [], hidden = []
    for (const d of devs) {
      // an ECU's DBC can hold thousands of signals: they are under Show hidden, the first 200 of them (Plot has them all)
      const ecu = /dbc/i.test(d.type ?? '')
      for (const s of (feed.byGuid[d.guid] ?? []).slice(0, ecu ? 200 : undefined)) {
        if (s.kind === 'Output') continue
        const enabled = s.enabled !== false
        const tile = {
          id: `${d.guid}:${s.kind}:${s.n}:${s.name}`, name: s.name, mod: d.name, value: word(s), unit: s.kind === 'Analog input' ? 'mV' : '',
          sub: s.kind + (d.connected ? '' : ' · module not answering'), tone: !d.connected ? 'stale' : s.on ? 'on' : 'off', key: keys.sig(d.guid, s.name),
          href: signalHref(d.guid, s), graph: href('live', 'plot', { signal: keys.sig(d.guid, s.name) }),
        }
        if (enabled && !ecu) shown.push(tile); else hidden.push({ ...tile, key: null })
      }
    }
    return { shown, hidden }
  })

  const shownCount = $derived(carTiles.length + outputTiles.shown.length + signalTiles.shown.length)
  const hiddenCount = $derived(outputTiles.hidden.length + signalTiles.hidden.length)
  const feedLost = $derived(hub.state !== 'live' || live.stale)
  const groups = $derived([
    { name: 'CAR', tiles: carTiles },
    { name: 'OUTPUTS ON', tiles: showHidden ? [...outputTiles.shown, ...outputTiles.hidden] : outputTiles.shown },
    { name: 'MODULES', tiles: [] },
    { name: 'SWITCHES & SIGNALS', tiles: showHidden ? [...signalTiles.shown, ...signalTiles.hidden] : signalTiles.shown },
  ])
</script>

<Page wide>
  <PageHeader title="Live">
    {#snippet tag()}<LiveTabs current="dashboard" />{/snippet}
    {#snippet actions()}
      <span class="muted count" role="status" data-testid="live-count" data-shown={shownCount} data-hidden={hiddenCount}
        title={`${shownCount} values shown. ${hiddenCount} more are hidden: outputs that are off or not enabled, signals that are not enabled, and ECU signals. Turn on Show hidden to see them.`}>{shownCount} live values</span>
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
        {#if g.name === 'MODULES'}
          {#if moduleRows.length}
            <div class="mtw"><table class="mods">
              <thead><tr><th>Module</th><th class="r">Temp</th><th>State</th><th class="r">Current</th><th><span class="sr-only">Graph</span></th></tr></thead>
              <tbody>
                {#each moduleRows as m (m.guid)}
                  <tr data-testid="module-row" data-tone={m.tone}>
                    <td><a href={href('hardware', 'module', m.guid)}>{m.name}</a></td>
                    <td class="r mono">{m.temp} °C</td>
                    <td>{m.tone === 'fault' ? '■ ' : m.tone === 'warn' ? '▲ ' : ''}{m.state}</td>
                    <td class="r mono">{m.current ? m.current + ' A' : ''}</td>
                    <td class="r"><a class="gr" href={m.graph} aria-label={'Graph ' + m.name + ' temperature'}>Graph it</a></td>
                  </tr>
                {/each}
              </tbody>
            </table></div>
          {:else}<p class="muted">No module is answering.</p>{/if}
        {:else if g.tiles.length || g.name === 'CAR'}
          <div class="grid">
            {#each g.tiles as t (t.id)}
              <Tile name={t.name} mod={t.mod} value={t.value} unit={t.unit} pct={t.pct ?? null} sub={t.sub} tone={t.tone} spark={t.key ? spark(t.key) : []} href={t.href} graph={t.graph ?? ''} />
            {/each}
            {#if g.name === 'CAR' && moduleKey === 'all'}
              {@const ig = ignitionTile(live.devices)}
              {#if ig}<Tile name="Ignition" mod="" value={ig.value} unit="" sub={ig.sub} tone={ig.value === 'Cranking' ? 'warn' : 'muted'} spark={[]} href={href('power', 'ignition')} graph="" />
              {:else}<div class="tile-fw"><span>Ignition</span><FwBadge version="5.6" /><small class="muted">start button and ignition state</small></div>{/if}
            {/if}
          </div>
        {:else}
          <p class="muted">{g.name === 'OUTPUTS ON' ? 'No outputs are on right now.' : 'No enabled switches or signals yet.'}{#if hiddenCount} Turn on Show hidden to see the rest.{/if}</p>
        {/if}
      </section>
    {/each}
    <ForceCan {devs} />
  {/if}
</Page>

<style>
  .count { font-size: var(--text-sm); }
  .sel { width: 190px; }
  .mtw { max-width: 100%; overflow-x: auto; }
  .mods { width: 100%; max-width: 760px; border-collapse: collapse; font-size: var(--text-sm); }
  .mods th { text-align: left; font-size: var(--text-xs); color: var(--color-text-muted); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--color-line); }
  .mods td { padding: 2px 8px; border-bottom: 1px solid var(--color-line); white-space: nowrap; }
  .mods .r { text-align: right; }
  .mods tr[data-tone='fault'] td { color: var(--color-fault); }
  .mods tr[data-tone='warn'] td:nth-child(2), .mods tr[data-tone='warn'] td:nth-child(3) { color: var(--color-warn); }
  .gr { display: inline-flex; align-items: center; min-height: 32px; font-size: 13px; font-weight: 600; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  @media (max-width: 900px) { .sel { width: 100%; } .mods td, .mods th { padding: 2px 4px; } .mods td:first-child { white-space: normal; } }
  .grp { display: flex; flex-direction: column; gap: var(--space-3); }
  .gh { font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: var(--space-3); }
  .tile-fw { border-radius: var(--radius-lg); border: 1px dashed var(--color-line-strong); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: 6px; align-items: flex-start; font-weight: 600; }
  :global(.sp .lc svg) { inset: 0; width: 100%; height: 100%; }
</style>
