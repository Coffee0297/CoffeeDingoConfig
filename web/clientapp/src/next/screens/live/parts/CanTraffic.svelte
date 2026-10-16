<script>
  // Live CAN traffic by ID with changed bytes marked, recording and flood warning.
  // All numbers come from GET /api/canlog polled twice a second: rate and "changed" are worked out
  // here from two polls (API gap: the backend keeps no per-frame history, so no timestamps).
  import { Button, Banner, Checkbox, Empty, StateDot } from '../../../ui/index.js'
  import { live, api, hex, read, toast } from '../../../lib/live.svelte.js'
  import { makeNamer, frameBits, parseBitrate } from './canNames.js'

  const FLOOD_PER_S = 3000
  const POLL_MS = 500
  const CAP = 1000

  let rows = $state([])          // [{ key, id, ide, dir, dlc, bytes[], changed:Set, rate, count, name, silent }]
  let stale = $state(false)
  let idMap = $state(null)
  let filter = $state('')
  let hideSilent = $state(false)
  let only = $state('')          // id key shown alone (from the flood banner)
  let hidden = $state(new Set()) // id keys hidden from the list
  const prev = new Map()         // key -> { count, t, rate, bytes, changeAt:number[], lastMoved }

  const namer = $derived(makeNamer(live.devices, idMap))

  async function tick() {
    let list
    try { list = await api.canlog(); stale = false } catch { stale = true; return }
    const now = performance.now()
    const out = []
    for (const m of list ?? []) {
      const key = `${m.dir}:${m.id}:${m.ide ? 'x' : 's'}`
      const bytes = (m.data || '').split(' ').filter(Boolean)
      const p = prev.get(key)
      let rate = 0, changeAt = p?.changeAt ?? new Array(8).fill(0), lastMoved = p?.lastMoved ?? now
      if (p) {
        const dt = (now - p.t) / 1000
        if (dt > 0.05) {
          const inst = Math.max(0, (m.count - p.count) / dt)
          rate = p.rate ? p.rate * 0.5 + inst * 0.5 : inst
        } else rate = p.rate
        if (m.count !== p.count) lastMoved = now
        for (let i = 0; i < bytes.length; i++) if (bytes[i] !== p.bytes[i]) changeAt[i] = now
      }
      if (!p || now - p.t > 0.05 * 1000) prev.set(key, { count: m.count, t: p && now - p.t <= 50 ? p.t : now, rate, bytes, changeAt, lastMoved })
      out.push({ key, id: m.id, ide: m.ide, dir: m.dir, dlc: m.len, bytes, changeAt, rate, count: m.count, lastMoved })
    }
    rows = out.slice(-CAP)
    nowT = now
  }
  let nowT = $state(0)
  async function loadMap() { idMap = (await read(() => api.canIdMap())) ?? idMap }
  $effect(() => {
    let alive = true
    tick(); loadMap()
    const id = setInterval(() => { if (alive) tick() }, POLL_MS)
    const id2 = setInterval(() => { if (alive) loadMap() }, 15000)
    return () => { alive = false; clearInterval(id); clearInterval(id2) }
  })

  const q = $derived(filter.trim().toLowerCase())
  const named = $derived(rows.map((r) => ({ ...r, name: namer(r.id, r.ide) })))
  const shown = $derived(named.filter((r) => {
    if (only) return r.key === only
    if (hidden.has(r.key)) return false
    if (hideSilent && nowT - r.lastMoved > 10000) return false
    if (!q) return true
    return `${hex(r.id)} ${r.id} ${r.name}`.toLowerCase().includes(q)
  }))

  // ---- stats ----
  const sumRate = $derived(rows.reduce((s, r) => s + r.rate, 0))
  const fps = $derived(live.canRate > 0 ? live.canRate : Math.round(sumRate))
  const top = $derived(named.reduce((a, b) => (b.rate > (a?.rate ?? -1) ? b : a), null))
  const bitrate = $derived(parseBitrate(live.devices.find((d) => d.bitrate)?.bitrate))
  const load = $derived(Math.min(100, Math.round((rows.reduce((s, r) => s + r.rate * frameBits(r.dlc, r.ide), 0) / bitrate) * 100)))
  const flooded = $derived(fps > FLOOD_PER_S)
  const share = $derived(top && fps ? Math.round((top.rate / fps) * 100) : 0)

  // ---- recording ----
  let rec = $state(null)
  let recBusy = $state(false)
  const isSim = $derived(/sim/i.test(live.adapter ?? ''))
  const canRecord = $derived(live.connected && !isSim)
  async function pollRec() { try { rec = await api.canRecStatus() } catch { /* shown as unknown */ } }
  $effect(() => {
    pollRec()
    const id = setInterval(pollRec, 1000)
    return () => clearInterval(id)
  })
  async function toggleRec() {
    recBusy = true
    try {
      if (rec?.recording) { const r = await api.canRecStop(); toast(`Recording stopped: ${r.frames.toLocaleString()} frames.`, 'info', 3000) }
      else await api.canRecStart()
    } catch (e) { toast(e?.message ?? String(e), 'error', 8000) } finally { recBusy = false; await pollRec() }
  }
  const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
  const hasFile = $derived(!!rec && rec.frames > 0 && !!rec.fileName)

  const isChanged = (r, i) => nowT - r.changeAt[i] < 1000 && r.changeAt[i] > 0
</script>

<div class="wrap">
  {#if !live.connected}
    <Empty title="No CAN adapter connected" text="Plug in the USB adapter, then connect. Frames appear here as soon as the bus is alive.">
      {#snippet actions()}<Button variant="primary" href="#/next/connect">Connect</Button>{/snippet}
    </Empty>
  {:else}
    <div class="top">
      <div class="left">
        <div class="tools">
          <div class="fld"><label class="nx-label" for="can-filter">Filter by ID or name</label><input id="can-filter" class="nx-input mono" bind:value={filter} placeholder="0x680, fan, PDM-01" /></div>
          <Checkbox bind:checked={hideSilent} label="Hide IDs silent for 10 s" />
          <span class="legend muted"><strong class="chg mono">5B</strong> bold and underlined = byte changed in the last second</span>
        </div>
        <div class="stats" role="group" aria-label="Bus statistics">
          <div class="st" class:bad={flooded}><span class="sl">FRAMES / S</span><span class="sv mono" data-testid="can-fps">{fps.toLocaleString('en-US')}</span><span class="ss">limit {FLOOD_PER_S.toLocaleString('en-US')}</span></div>
          <div class="st" class:bad={flooded}><span class="sl">UNIQUE IDS</span><span class="sv mono" data-testid="can-ids">{rows.length}</span><span class="ss">{named.filter((r) => r.name).length} known</span></div>
          <div class="st"><span class="sl">BUS LOAD</span><span class="sv mono">{load} %</span><span class="ss">about, {bitrate / 1000} kbit/s</span></div>
          <div class="st"><span class="sl">TOP TALKER</span><span class="sv mono">{top ? hex(top.id) : 'none'}</span><span class="ss">{top ? `${Math.round(top.rate).toLocaleString('en-US')} / s${top.name ? ' · ' + top.name : ''}` : ''}</span></div>
        </div>
      </div>

      <section class="rec" aria-label="Recording" data-recording={rec?.recording ? 'true' : 'false'}>
        <div class="rr">
          <Button variant={rec?.recording ? 'danger' : 'primary'} busy={recBusy} disabled={!rec?.recording && !canRecord} onclick={toggleRec} data-testid="rec-toggle">{rec?.recording ? '■ Stop recording' : '● Start recording'}</Button>
          <span role="status" class="rs" data-testid="rec-status">
            {#if rec?.recording}<strong class="recw">● REC {mmss(rec.sinceMs)}</strong><span class="muted">{rec.frames.toLocaleString('en-US')} frames · all IDs, unfiltered</span>
            {:else if hasFile}<strong>Saved {rec.frames.toLocaleString('en-US')} frames</strong><span class="muted">{rec.fileName} · ready to download</span>
            {:else}<strong>Not recording</strong><span class="muted">{canRecord ? 'Records every frame on the bus, even IDs hidden by the filter.' : isSim ? 'The simulator adapter cannot be recorded. Connect a real CAN adapter.' : 'Connect a CAN adapter to record.'}</span>{/if}
          </span>
        </div>
        <div class="rr">
          <Button href={hasFile ? '/api/canlog/record/download' : undefined} download disabled={!hasFile} data-testid="dl-csv">Download CSV</Button>
          <Button href="/api/canlog/export" download data-testid="dl-summary">Download ID summary</Button>
        </div>
        {#if !hasFile}<span class="muted small">Download is available after a recording.</span>{/if}
      </section>
    </div>

    {#if flooded && top}
      <div role="alert" class="flood">
        <span class="fm" aria-hidden="true">■</span>
        <span class="ft"><strong>Bus flooded: {fps.toLocaleString('en-US')} frames/s</strong> (the limit is {FLOOD_PER_S.toLocaleString('en-US')}). Top talker is <span class="mono">{hex(top.id)}</span> with {Math.round(top.rate).toLocaleString('en-US')} frames/s, {share} % of all traffic. A device that gets no answer repeats its frame. Check that both bus ends have a 120 Ω terminator and that every module is powered.</span>
        <Button size="sm" onclick={() => (only = top.key)}>Show only {hex(top.id)}</Button>
        <Button size="sm" onclick={() => (hidden = new Set([...hidden, top.key]))}>Hide {hex(top.id)} from the list</Button>
      </div>
    {/if}
    {#if only || hidden.size}
      <div class="chips" role="status">
        {#if only}<span>Showing one ID only.</span>{/if}
        {#if hidden.size}<span>{hidden.size} {hidden.size === 1 ? 'ID is' : 'IDs are'} hidden.</span>{/if}
        <Button size="sm" onclick={() => { only = ''; hidden = new Set() }}>Show all IDs</Button>
      </div>
    {/if}
    {#if stale}<Banner tone="warn" title="The CAN list is not updating.">The app could not read the traffic. It keeps trying.</Banner>{/if}

    <section aria-label="CAN traffic by ID" class="tbl">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="nx-scroll" tabindex="0" role="region" aria-label="CAN traffic table">
        <table class="nx-table" data-testid="can-table">
          <thead><tr><th scope="col">ID</th><th scope="col">Dir</th><th scope="col">Name</th><th scope="col">DLC</th><th scope="col">Data (bytes 0 to 7)</th><th scope="col" class="r">Rate</th><th scope="col" class="r">Count</th></tr></thead>
          <tbody>
            {#each shown as r (r.key)}
              <tr class:flood={flooded && top?.key === r.key}>
                <td class="mono">{hex(r.id)}{r.ide ? ' EXT' : ''}</td>
                <td>{r.dir}</td>
                <td class:muted={!r.name}>{flooded && top?.key === r.key ? '■ Flooding · ' : ''}{r.name || 'unknown device'}</td>
                <td class="mono">{r.dlc}</td>
                <td class="mono bytes">{#each r.bytes as b, i (i)}<span class="b" class:chg={isChanged(r, i)}>{b}</span>{/each}</td>
                <td class="mono r">{r.rate >= 10 ? Math.round(r.rate) : r.rate.toFixed(1)} Hz</td>
                <td class="mono r">{r.count.toLocaleString('en-US')}</td>
              </tr>
            {:else}
              <tr><td colspan="7" class="muted">{rows.length ? 'No ID matches the filter.' : 'No frames seen yet.'}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: var(--space-4); }
  .top { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 440px); gap: var(--space-4); align-items: start; }
  @media (max-width: 1100px) { .top { grid-template-columns: minmax(0, 1fr); } }
  .left { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
  .tools { display: flex; align-items: flex-end; gap: var(--space-4); flex-wrap: wrap; }
  .fld { display: flex; flex-direction: column; gap: 4px; width: 280px; }
  .legend { font-size: var(--text-xs); }
  .chg { font-weight: 700; text-decoration: underline; color: var(--color-text); }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); }
  @media (max-width: 800px) { .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .st { border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .st.bad { border-color: var(--color-fault); background: var(--color-fault-soft); }
  .sl { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); }
  .sv { font-size: 24px; }
  .st.bad .sv { color: var(--color-fault); }
  .ss { font-size: var(--text-xs); color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rec { border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
  .rec[data-recording='true'] { border-color: var(--color-fault); }
  .rr { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .rs { display: flex; flex-direction: column; font-size: var(--text-sm); min-width: 0; }
  .recw { color: var(--color-fault); }
  .small { font-size: var(--text-xs); }
  .flood { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; border: 1px solid var(--color-fault); background: var(--color-fault-soft); border-radius: var(--radius-md); padding: var(--space-3) var(--space-4); }
  .fm { color: var(--color-fault); font-weight: 700; }
  .ft { flex: 1 1 320px; font-size: var(--text-sm); }
  .chips { display: flex; align-items: center; gap: var(--space-3); font-size: var(--text-sm); }
  .tbl { border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); }
  .tbl .nx-scroll { max-height: 560px; }
  .r { text-align: right; font-variant-numeric: tabular-nums; }
  .bytes { white-space: nowrap; }
  .b { display: inline-block; min-width: 2.2ch; margin-right: 6px; padding: 0 2px; color: var(--color-text-muted); }
  .b.chg { font-weight: 700; text-decoration: underline; color: var(--color-text); background: var(--color-on-soft); border-radius: 3px; }
  tr.flood { background: var(--color-fault-soft); }
</style>
