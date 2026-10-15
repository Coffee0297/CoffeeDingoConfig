<script module>
  // Remembered while the app is open, so leaving the Plot and coming back keeps the chosen signals.
  const memo = { series: null, win: 60 }
</script>

<script>
  import { Page, PageHeader, Button, Banner, Segmented, Card, Empty, StateDot } from '../../ui/index.js'
  import { live, api } from '../../lib/live.svelte.js'
  import { feed, watchSignals, resampleRange, firstAt, samples, keys } from './parts/feed.svelte.js'
  import { buildCatalog, resolveSignalToken, describeKey } from './parts/catalog.js'
  import { renderPlotPng, downloadBlob } from './parts/plotExport.js'
  import LiveTabs from './parts/LiveTabs.svelte'
  import { LineChart } from '../../ui/index.js'

  let { query = {} } = $props()

  const MAX = 6
  const DASH = ['', '10 6', '2 5', '12 4 2 4', '6 3', '1 4']
  const N = 160
  const WINDOWS = [{ value: '10', label: '10 s' }, { value: '60', label: '1 min' }, { value: '300', label: '5 min' }]

  // ---- chosen series ----
  const tokens = String(query?.signal ?? '').split(',').filter(Boolean)
  let asked = $state(tokens.map((t) => resolveSignalToken(t, live.devices)).filter(Boolean))
  // names of modules can only be resolved once the module list has arrived
  $effect(() => {
    if (!live.devices.length || asked.length >= tokens.length) return
    const more = tokens.map((t) => resolveSignalToken(t, live.devices)).filter((k) => k && !series.some((s) => s.key === k))
    if (more.length) { series = [...series, ...more.map((k) => ({ key: k, hidden: false }))].slice(0, MAX); asked = [...asked, ...more] }
  })
  let series = $state([...(memo.series ?? [keys.total, keys.battMax]), ...asked].filter((k, i, a) => a.indexOf(k) === i).slice(0, MAX).map((k) => ({ key: k, hidden: false })))
  let win = $state(String(memo.win))
  $effect(() => { memo.series = series.map((s) => s.key); memo.win = Number(win) })

  // ---- catalog (one-shot read of every module's signals; history only for what is added) ----
  let catSignals = $state({})
  const devKey = $derived(live.devices.map((d) => d.guid).join(','))
  $effect(() => {
    devKey
    let alive = true
    for (const d of live.devices) {
      api.signals(d.guid).then((l) => { if (alive) catSignals[d.guid] = l ?? [] }).catch(() => {})
    }
    return () => { alive = false }
  })
  const catalog = $derived(buildCatalog(live.devices, catSignals))
  const byKey = $derived(new Map(catalog.map((c) => [c.key, c])))
  const info = (key) => byKey.get(key) ?? { key, ...describeKey(key, live.devices), kind: '' }

  const sigGuidKey = $derived([...new Set(series.filter((s) => s.key.startsWith('sig:')).map((s) => s.key.split(':')[1]))].join(','))
  $effect(() => watchSignals(sigGuidKey ? sigGuidKey.split(',') : []))

  // ---- time ----
  let now = $state(Date.now())
  let paused = $state(false)
  let frozenAt = $state(0)
  $effect(() => {
    const id = setInterval(() => { if (!paused) now = Date.now() }, 250)
    return () => clearInterval(id)
  })
  const until = $derived(paused ? frozenAt : now)
  function togglePause() {
    if (!paused) frozenAt = Date.now()
    paused = !paused
    if (!paused) now = Date.now()
  }

  const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)} min${Math.round(s % 60) ? ' ' + Math.round(s % 60) + ' s' : ''}` : s >= 10 ? `${Math.round(s)} s` : `${s.toFixed(1)} s`)
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour12: false })

  // ---- chart data ----
  const visible = $derived(series.filter((s) => !s.hidden))
  const spanSec = $derived.by(() => {
    const u = until
    let avail = Number(win)
    for (const s of visible) { const f = firstAt(s.key); avail = Math.min(avail, f == null ? 0 : (u - f) / 1000) }
    return Math.max(avail, 1)
  })
  const hasData = $derived.by(() => { until; return visible.length > 0 && visible.every((s) => samples(s.key).t.length > 0) })
  const from = $derived(until - spanSec * 1000)

  const lines = $derived.by(() => {
    if (!hasData) return []
    const units = new Set(visible.map((s) => info(s.key).unit).filter(Boolean))
    const shared = units.size <= 1
    const raws = visible.map((s) => resampleRange(s.key, from, until, N))
    // keep a minimum range per unit so a flat signal does not look like a wild one
    const widen = (a, b, unit) => {
      const min = unit === 'A' ? 2 : unit === 'V' ? 1 : unit === '°C' ? 10 : unit === 'on/off' ? 1.2 : Math.max(1, Math.abs((a + b) / 2) * 0.1)
      if (b - a >= min) { const p = (b - a) * 0.06; return [a - p, b + p] }
      const mid = (a + b) / 2
      return [mid - min / 2, mid + min / 2]
    }
    let lo = 0, hi = 1
    if (shared) {
      const all = raws.flat()
      ;[lo, hi] = widen(Math.min(...all), Math.max(...all), [...units][0] ?? '')
      if (visible.every((s) => info(s.key).unit === 'on/off')) { lo = -0.1; hi = 1.1 }
    }
    return visible.map((s, k) => {
      const raw = raws[k]
      let a = lo, b = hi
      if (!shared) [a, b] = widen(Math.min(...raw), Math.max(...raw), info(s.key).unit)
      const i = series.indexOf(s)
      const last = samples(s.key).t.at(-1) ?? 0
      return { key: s.key, i, raw, lo: a, hi: b, norm: raw.map((v) => ((v - a) / (b - a)) * 100), color: `var(--color-series-${i + 1})`, dash: DASH[i], stale: (until - last > 3000 && !paused) || live.devices.some((d) => d.guid === s.key.split(':')[1] && !d.connected), shared }
    })
  })
  const shared = $derived(lines.length === 0 || lines[0].shared)
  const yLabels = $derived.by(() => {
    if (!lines.length || !shared) return []
    const { lo, hi } = lines[0]
    return [0, 1, 2, 3, 4].map((k) => fmtNum(hi - ((hi - lo) * k) / 4, hi - lo))
  })
  const fmtNum = (v, range = 10) => (Math.abs(range) >= 20 ? Math.round(v) : Math.abs(range) >= 2 ? v.toFixed(1) : v.toFixed(2))
  const xLabels = $derived(Array.from({ length: 6 }, (_, k) => (k === 5 ? 'now' : '−' + fmtDur(spanSec * (1 - k / 5)))))

  // cursor
  let cursor = $state(100)
  const ci = $derived(Math.round((cursor / 100) * (N - 1)))
  const cursorT = $derived(from + ((until - from) * cursor) / 100)
  const cursorText = $derived(`At ${cursor >= 99.5 ? 'now' : '−' + fmtDur((until - cursorT) / 1000)} · ${clock(cursorT)}`)

  const fmtVal = (v, unit) => {
    if (v == null) return 'no data'
    if (unit === 'on/off') return v > 0.5 ? 'On' : 'Off'
    const s = Number.isInteger(v) || unit === 'mV' ? String(Math.round(v)) : v.toFixed(Math.abs(v) >= 100 ? 0 : 1)
    return unit ? `${s} ${unit}` : s
  }
  const rows = $derived(series.map((s, i) => {
    const inf = info(s.key), ln = lines.find((l) => l.key === s.key)
    const dev = live.devices.find((d) => d.guid === s.key.split(':')[1])
    const gone = dev && !dev.connected
    return { s, i, inf, ln, gone, val: s.hidden ? 'hidden' : ln ? fmtVal(ln.raw[ci], inf.unit) : 'waiting…' }
  }))
  const goneNames = $derived([...new Set(rows.filter((r) => r.gone && !r.s.hidden).map((r) => live.devices.find((d) => d.guid === r.s.key.split(':')[1])?.name))])

  const chartLabel = $derived(`Line graph of the last ${fmtDur(spanSec)}${paused ? ', paused' : ', live'}. ` + rows.filter((r) => r.ln).map((r) => `${r.inf.name} ${fmtVal(r.ln.raw.at(-1), r.inf.unit)}`).join(', ') + '.')

  // ---- table ----
  let showTable = $state(false)
  const tableRows = $derived(Array.from({ length: 13 }, (_, r) => {
    const idx = Math.round((r * (N - 1)) / 12)
    return { idx, t: clock(from + ((until - from) * idx) / (N - 1)), near: Math.abs(idx - ci) <= (N - 1) / 24, cells: rows.map((x) => (x.s.hidden ? 'hidden' : x.ln ? fmtVal(x.ln.raw[idx], x.inf.unit) : '-')) }
  }))

  // ---- add / remove ----
  let q = $state('')
  const words = $derived(q.trim().toLowerCase().split(/\s+/).filter(Boolean))
  const candidates = $derived(catalog.filter((c) => !series.some((s) => s.key === c.key) && words.every((w) => `${c.name} ${c.mod} ${c.kind}`.toLowerCase().includes(w))))
  const full = $derived(series.length >= MAX)
  function add(key) { if (full || series.some((s) => s.key === key)) return; series = [...series, { key, hidden: false }]; q = '' }
  const remove = (key) => (series = series.filter((s) => s.key !== key))
  const toggleHide = (key) => (series = series.map((s) => (s.key === key ? { ...s, hidden: !s.hidden } : s)))

  // ---- export ----
  let exportMsg = $state('')
  async function exportPng() {
    exportMsg = ''
    if (!lines.length) { exportMsg = 'Nothing to export yet: add a signal and wait a moment for data.'; return }
    const blob = await renderPlotPng(
      lines.map((l) => { const inf = info(l.key); return { label: `${inf.name} (${inf.mod})`, color: l.color, dash: l.dash, values: l.norm.map((v) => v / 100), last: fmtVal(l.raw.at(-1), inf.unit) } }),
      { title: `dingoConfig plot, last ${fmtDur(spanSec)}${paused ? ', paused' : ''}`, xLabels, yLabels },
    )
    downloadBlob(blob, 'dingo-plot.png')
    exportMsg = 'Saved dingo-plot.png'
  }

  const opened = $derived(asked.length ? asked.map((k) => info(k).name).join(', ') : '')
  const unitNote = (r) => (r.ln ? (r.ln.shared ? (shared && rows.filter((x) => x.ln).length > 0 ? 'shared scale' : '') : `own scale ${fmtNum(r.ln.lo, r.ln.hi - r.ln.lo)} to ${fmtNum(r.ln.hi, r.ln.hi - r.ln.lo)}`) : '')
</script>

<Page wide>
  <PageHeader title="Live">
    {#snippet tag()}<LiveTabs current="plot" />{/snippet}
  </PageHeader>

  {#if opened}
    <Banner tone="info" title="Opened from Graph it.">{opened} {asked.length === 1 ? 'is' : 'are'} on the graph. Add another signal to see what makes it change.</Banner>
  {/if}
  {#if goneNames.length}
    <Banner tone="warn" title={`${goneNames.join(', ')} stopped answering.`}>Its lines stop at the last value (dotted). Check the CAN cable and the module power. Other modules are still plotted.</Banner>
  {:else if !live.connected}
    <Banner tone="warn" title="Not connected to the car.">Lines stop until you connect.</Banner>
  {/if}

  <div class="cols">
    <section class="plot" aria-label="Plot">
      <div class="bar">
        <Segmented items={WINDOWS} bind:value={win} label="Time window" />
        <Button aria-pressed={paused} onclick={togglePause} data-testid="pause">{paused ? '▶ Live' : '❚❚ Pause'}</Button>
        <span class="muted" role="status" data-testid="plot-status">{paused ? `Paused at ${clock(frozenAt)}` : 'Live'}</span>
        <span class="grow"></span>
        {#if exportMsg}<span role="status" class="msg">✓ {exportMsg}</span>{/if}
        <Button aria-pressed={showTable} onclick={() => (showTable = !showTable)}>{showTable ? 'Show as graph' : 'Show as table'}</Button>
        <Button onclick={exportPng}>Export PNG</Button>
      </div>

      {#if !series.length}
        <Empty title="No signals yet" text="Search for a signal on the right, or press Graph it on any value on the dashboard." />
      {:else if !visible.length}
        <Empty title="All signals are hidden" text="Press Show next to a signal to see its line." />
      {:else if !hasData}
        <Empty title="Waiting for data" text="The first values arrive in a second. If nothing appears, the module may not be answering." />
      {:else if showTable}
        <div class="nx-scroll tbl" tabindex="0" role="region" aria-label="Plot values as a table">
          <table class="nx-table">
            <caption class="muted">Same data as the graph, 13 samples across the last {fmtDur(spanSec)}. The cursor row is marked with an arrow.</caption>
            <thead><tr><th scope="col">Time</th>{#each rows as r (r.s.key)}<th scope="col">{r.inf.name} <span class="muted">{r.inf.mod}</span></th>{/each}</tr></thead>
            <tbody>
              {#each tableRows as tr (tr.idx)}
                <tr class:near={tr.near}><th scope="row" class="mono">{tr.near ? '→ ' : ''}{tr.t}</th>{#each tr.cells as c, k (k)}<td class="mono">{c}</td>{/each}</tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="axes muted">{shared ? `Left axis${rows.find((r) => r.ln)?.inf.unit ? ' · ' + rows.find((r) => r.ln).inf.unit : ''}` : 'Each line on its own scale (range shown on the right)'}</div>
        <div class="pw">
          {#if shared}
            <div class="ya mono" aria-hidden="true">{#each yLabels as y, k (k)}<span style="top: calc(8px + (100% - 16px) * {k / 4})">{y}</span>{/each}</div>
          {/if}
          <div class="cw">
            <LineChart series={lines.map((l, k) => ({ label: info(l.key).name, values: l.norm, color: l.color, dash: l.stale ? '2 5' : l.dash, area: k === 0 && lines.length === 1 }))} min={0} max={100} height={340} label={chartLabel} />
            <div class="cur" aria-hidden="true" style="left: calc(8px + (100% - 16px) * {cursor / 100})"></div>
            {#each lines as l (l.key)}
              <span class="dot" aria-hidden="true" style="left: calc(8px + (100% - 16px) * {cursor / 100}); top: calc(8px + (100% - 16px) * {1 - Math.max(0, Math.min(100, l.norm[ci])) / 100}); background: {l.color}"></span>
            {/each}
          </div>
        </div>
        <div class="xl mono" aria-hidden="true">{#each xLabels as x (x)}<span>{x}</span>{/each}</div>
        <p class="muted small">Showing the last {fmtDur(spanSec)}{spanSec < Number(win) ? ` (history builds up while this app is open, window ${fmtDur(Number(win))})` : ''}. Nothing is stored on the server.</p>
      {/if}

      <div class="curbar">
        <label for="plot-cursor">Cursor</label>
        <input id="plot-cursor" type="range" min="0" max="100" step="0.5" bind:value={cursor} aria-valuetext={cursorText} />
        <span role="status" class="mono" data-testid="cursor-time">{cursorText}</span>
      </div>
    </section>

    <aside aria-label="Series" class="side">
      <Card title="Series" subtitle={`${series.length} of ${MAX} · value at the cursor`}>
        {#each rows as r (r.s.key)}
          <div class="srow" data-testid="series-row">
            <svg aria-hidden="true" width="44" height="14" viewBox="0 0 44 14"><path d="M 0 7 L 44 7" fill="none" stroke={`var(--color-series-${r.i + 1})`} stroke-width="3" stroke-dasharray={DASH[r.i] || 'none'} /></svg>
            <span class="who"><strong>{r.inf.name}</strong>
              <span class="muted small">{r.inf.mod}{unitNote(r) ? ' · ' + unitNote(r) : ''}</span>
              {#if r.gone}<span class="small warnT">▲ module not answering</span>{:else if r.ln?.stale}<span class="small warnT">▲ no new data</span>{/if}
            </span>
            <span class="val mono">{r.val}</span>
            <Button size="sm" aria-pressed={r.s.hidden} aria-label={(r.s.hidden ? 'Show ' : 'Hide ') + r.inf.name} onclick={() => toggleHide(r.s.key)}>{r.s.hidden ? 'Show' : 'Hide'}</Button>
            <Button size="sm" aria-label={'Remove ' + r.inf.name} onclick={() => remove(r.s.key)}>×</Button>
          </div>
        {:else}
          <p class="muted">No series yet. Search for a signal below, or press Graph it on any value.</p>
        {/each}
      </Card>

      <Card title="Add a signal" subtitle={`${catalog.length} to choose from`}>
        <label class="nx-label" for="plot-q">Search signals</label>
        <input id="plot-q" class="nx-input" type="text" bind:value={q} placeholder="fan, battery, PDM-01, headlights" />
        <Button size="sm" disabled title="Not available yet: the backend keeps no CAN frame history (gap G17)">Learn a switch</Button>
        <span class="muted small">Learn a switch needs a CAN frame history from the backend (gap G17).</span>
        {#if full}<p class="small warnT" role="status">Six signals is the most one graph can show clearly. Remove one to add another.</p>{/if}
        <div class="res">
          {#each candidates.slice(0, 8) as c (c.key)}
            <button type="button" class="pick" disabled={full} aria-label={`Add ${c.name} from ${c.mod}`} onclick={() => add(c.key)}>
              <span class="who"><strong>{c.name}</strong><span class="muted small">{c.mod} · {c.kind}{c.unit ? ' · ' + c.unit : ''}</span></span><span class="act">{full ? 'Full' : '+ Add'}</span>
            </button>
          {:else}
            <p class="muted small">{q ? 'No signal matches that search.' : 'Every signal is already on the graph.'}</p>
          {/each}
          {#if candidates.length > 8}<p class="muted small">{candidates.length - 8} more. Type to narrow the list.</p>{/if}
        </div>
      </Card>
    </aside>
  </div>
</Page>

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: var(--space-4); align-items: start; }
  @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  .plot { border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); padding: var(--space-4) var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
  .bar { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .grow { flex: 1 1 auto; }
  .msg { color: var(--color-ok); font-weight: 600; }
  .axes { font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  .pw { display: flex; gap: var(--space-2); }
  .ya { position: relative; width: 52px; flex: none; height: 340px; font-size: 11px; color: var(--color-text-muted); }
  .ya span { position: absolute; right: 0; transform: translateY(-50%); }
  .cw { position: relative; flex: 1 1 auto; min-width: 0; height: 340px; }
  .cur { position: absolute; top: 8px; bottom: 8px; width: 0; border-left: 2px solid var(--color-text); opacity: 0.7; pointer-events: none; }
  .dot { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; border: 2px solid var(--color-surface); pointer-events: none; }
  .xl { display: flex; justify-content: space-between; font-size: 11px; color: var(--color-text-muted); padding: 0 8px 0 60px; }
  .small { font-size: var(--text-xs); }
  .curbar { display: flex; align-items: center; gap: var(--space-3); }
  .curbar input { flex: 1 1 auto; min-height: var(--target-min); accent-color: var(--color-accent); }
  .tbl { max-height: 420px; }
  tr.near { background: var(--color-on-soft); }
  caption { text-align: left; padding-bottom: var(--space-2); font-size: var(--text-xs); }
  .side { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .srow { display: flex; align-items: center; gap: var(--space-2); min-height: var(--target-min); border-bottom: 1px solid var(--color-line); padding: 4px 0; }
  .who { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
  .val { min-width: 62px; text-align: right; font-size: var(--text-sm); }
  .warnT { color: var(--color-warn); font-weight: 600; }
  .res { display: flex; flex-direction: column; gap: 4px; }
  .pick { display: flex; align-items: center; gap: var(--space-2); min-height: var(--target-min); padding: 4px var(--space-3); border-radius: var(--radius-md); border: 1px solid var(--color-line); background: var(--color-raised); color: var(--color-text); text-align: left; }
  .pick:hover:not(:disabled) { border-color: var(--color-line-strong); }
  .pick:disabled { opacity: 0.55; }
  .act { font-weight: 700; color: var(--color-accent); font-size: var(--text-xs); }
</style>
