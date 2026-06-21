<script>
  import { api, telemetry } from './store.js'
  import { clickable } from './a11y.js'
  let tab = $state('can')

  // Overload (trip) log — read on demand from the device (it records trips autonomously).
  let ovlDevices = $derived(($telemetry.devices ?? []).filter((d) => (d.outputs ?? []).length > 0))
  let ovlDev = $state('')
  $effect(() => { if (!ovlDev && ovlDevices[0]) ovlDev = ovlDevices[0].guid })
  let evts = $state([])
  let ovlSel = $state(null)
  let sel = $derived(evts.find((e) => e.id === ovlSel) ?? evts[0] ?? null)
  let ovlBusy = $state(false), ovlMsg = $state('')
  // Trip read/clear talk to the live module; gate on the selected module actually being on the bus.
  let ovlLive = $derived(!!ovlDevices.find((d) => d.guid === ovlDev)?.connected)

  async function readOverloads() {
    if (!ovlDev) return
    ovlBusy = true; ovlMsg = ''; evts = []; ovlSel = null
    try {
      const dev = ovlDevices.find((d) => d.guid === ovlDev)
      const r = await api.overloads(ovlDev)
      evts = (r.events ?? []).map((e, k) => ({
        id: k, dev: dev?.name ?? '', num: e.output, name: '', state: e.state,
        maxA: e.peakA, limit: e.limitA, samples: e.samples, done: true,
      }))
      ovlMsg = evts.length ? `${evts.length} event${evts.length > 1 ? 's' : ''}` : 'No trips logged on the device.'
    } catch (e) { ovlMsg = 'Read failed: ' + e.message }
    finally { ovlBusy = false }
  }
  async function clearOverloads() {
    if (!ovlDev || !confirm('Clear the trip log on the device?')) return
    try { await api.overloadsClear(ovlDev); evts = []; ovlSel = null; ovlMsg = 'Cleared.' }
    catch (e) { ovlMsg = 'Clear failed: ' + e.message }
  }

  // Build an SVG line for a captured ±10 s current waveform.
  const W = 820, H = 220, PAD = 34
  const T_PRE = 10, T_POST = 3, T_SPAN = T_PRE + T_POST   // -10 s … +3 s
  function plot(e) {
    if (!e?.samples?.length) return ''
    const ymax = Math.max(e.maxA, e.limit, 1) * 1.15
    const x = (dt) => PAD + ((dt + T_PRE) / T_SPAN) * (W - 2 * PAD)
    const y = (i) => H - PAD - (i / ymax) * (H - 2 * PAD)
    return e.samples.map((s, k) => (k ? 'L' : 'M') + x(s.dt).toFixed(1) + ',' + y(s.i).toFixed(1)).join(' ')
  }
  const xPix = (dt) => PAD + ((dt + T_PRE) / T_SPAN) * (W - 2 * PAD)
  const yPix = (i, e) => H - PAD - (i / (Math.max(e.maxA, e.limit, 1) * 1.15)) * (H - 2 * PAD)
  let canlog = $state([])
  let syslog = $state([])
  let fmt = $state('hex')

  const LOG_CAP = 1000   // cap rendered rows so a long session can't grow the DOM unbounded
  let logStale = $state(false)
  $effect(() => {
    tab   // re-subscribe per tab so switching reloads immediately and tears down cleanly
    let alive = true
    const load = async () => {
      try {
        if (tab === 'can') { const r = await api.canlog(); if (alive) { canlog = r.slice(-LOG_CAP); logStale = false } }
        else { const r = await api.syslog(); if (alive) { syslog = r.slice(-LOG_CAP); logStale = false } }
      } catch { if (alive) logStale = true }   // surface a stale badge instead of silently freezing rows
    }
    load(); const id = setInterval(load, 500)
    return () => { alive = false; clearInterval(id) }
  })

  const hex = (n) => '0x' + (n ?? 0).toString(16).toUpperCase().padStart(3, '0')
  const dec = (data) => data.split(' ').filter(Boolean).map((b) => parseInt(b, 16)).join(' ')
  const lvlClass = (l) => (l === 'Error' ? 'e' : l === 'Warning' ? 'w' : l === 'Info' ? 'i' : 'd')
</script>

<div class="h-row">
  <div><h1>Logs</h1><p class="sub">Live CAN traffic and system messages.</p></div>
</div>

<div class="tabs" role="tablist" style="margin-bottom:14px">
  <span class="t" role="tab" tabindex="0" aria-selected={tab === 'can'} use:clickable class:active={tab === 'can'} onclick={() => (tab = 'can')}>CAN log</span>
  <span class="t" role="tab" tabindex="0" aria-selected={tab === 'sys'} use:clickable class:active={tab === 'sys'} onclick={() => (tab = 'sys')}>System log</span>
  <span class="t" role="tab" tabindex="0" aria-selected={tab === 'ovl'} use:clickable class:active={tab === 'ovl'} onclick={() => (tab = 'ovl')}>Overloads {#if evts.length}({evts.length}){/if}</span>
</div>

{#if tab === 'can'}
  <div class="logbar">
    Format <select bind:value={fmt} aria-label="CAN data format"><option value="hex">Hex</option><option value="dec">Decimal</option></select>
    <a class="btn ghost" href="/api/canlog/export" download style="margin-left:auto">⭳ Export CSV</a>
    {#if logStale}<span style="color:var(--err)">⚠ feed stale — reconnecting…</span>{/if}
    <span style="color:var(--muted)">{canlog.length} IDs</span>
  </div>
  <div class="tscroll"><table class="logtable">
    <thead><tr><th>Dir</th><th>ID</th><th>DLC</th><th>Data</th><th>Count</th></tr></thead>
    <tbody>
      {#each canlog as m}
        <tr><td class={m.dir === 'Rx' ? 'dir-rx' : 'dir-tx'}>{m.dir}</td>
          <td>{fmt === 'hex' ? hex(m.id) : m.id}</td><td>{m.len}</td>
          <td>{fmt === 'hex' ? m.data : dec(m.data)}</td><td>{m.count}</td></tr>
      {/each}
      {#if canlog.length === 0}<tr><td colspan="5" class="muted">No traffic.</td></tr>{/if}
    </tbody>
  </table></div>
{:else if tab === 'sys'}
  <div class="logbar"><a class="btn ghost" href="/api/syslog/export" download style="margin-left:auto">⭳ Export CSV</a>{#if logStale}<span style="color:var(--err)">⚠ feed stale — reconnecting…</span>{/if}<span style="color:var(--muted)">{syslog.length} entries</span></div>
  <div class="tscroll"><table class="logtable">
    <thead><tr><th>Time</th><th>Level</th><th>Source</th><th>Message</th></tr></thead>
    <tbody>
      {#each syslog as e}
        <tr><td>{e.time}</td><td><span class="lvl {lvlClass(e.level)}">{e.level}</span></td>
          <td>{e.source}</td><td style="font-family:inherit">{e.message}</td></tr>
      {/each}
      {#if syslog.length === 0}<tr><td colspan="4" class="muted">No messages.</td></tr>{/if}
    </tbody>
  </table></div>
{:else}
  <div class="logbar">
    Module
    <select bind:value={ovlDev}>
      {#each ovlDevices as d}<option value={d.guid}>{d.name}</option>{/each}
      {#if ovlDevices.length === 0}<option value="">no PDM connected</option>{/if}
    </select>
    <button class="btn primary" disabled={ovlBusy || !ovlDev || !ovlLive} title={ovlLive ? '' : 'Connect this module to read its trip log'} onclick={readOverloads}>{ovlBusy ? 'Reading…' : 'Read trip log from device'}</button>
    <button class="btn ghost" disabled={ovlBusy || !ovlDev || !ovlLive} title={ovlLive ? '' : 'Connect this module to clear its trip log'} onclick={clearOverloads}>Clear</button>
    {#if ovlMsg}<span style="margin-left:auto;color:var(--muted)">{ovlMsg}</span>{:else if ovlDev && !ovlLive}<span style="margin-left:auto;color:var(--muted)">Module offline — connect to read trips.</span>{/if}
  </div>
  {#if evts.length === 0}
    <div class="card flat"><p class="muted">The device records the last few output trips (over-current / fault)
      on its own — with a −10 s / +3 s current waveform around each — so a trip that happened while the laptop
      wasn't connected is still here. Pick a module and <b>Read trip log from device</b>.</p></div>
  {:else}
    {#if sel}
      <div class="card" style="cursor:default;padding:14px;margin-bottom:14px">
        <div style="display:flex;gap:14px;align-items:baseline;margin-bottom:6px">
          <b>{sel.dev} · O{sel.num} {sel.name?.trim() ? sel.name : ''}</b>
          <span class="lvl {sel.state === 'Fault' ? 'e' : 'w'}">{sel.state}</span>
          <span class="muted">peak <b style="color:var(--err)">{sel.maxA?.toFixed(1)} A</b> · limit {sel.limit} A</span>
          {#if !sel.done}<span class="muted">capturing… (waiting for +3 s)</span>{/if}
        </div>
        {#if sel.samples?.length}
          <svg viewBox="0 0 {W} {H}" style="width:100%;height:auto;background:var(--surface);border:1px solid var(--line);border-radius:8px">
            <!-- limit line -->
            <line x1={PAD} y1={yPix(sel.limit, sel)} x2={W - PAD} y2={yPix(sel.limit, sel)} stroke="#c77700" stroke-dasharray="4 3" />
            <text x={W - PAD} y={yPix(sel.limit, sel) - 4} text-anchor="end" font-size="10" fill="#c77700">limit {sel.limit} A</text>
            <!-- trip marker at dt=0 -->
            <line x1={xPix(0)} y1={PAD} x2={xPix(0)} y2={H - PAD} stroke="#d23b3b" stroke-dasharray="3 3" />
            <text x={xPix(0) + 3} y={PAD + 10} font-size="10" fill="#d23b3b">trip</text>
            <!-- axes labels -->
            <text x={PAD} y={H - 8} font-size="10" fill="var(--muted)">-10 s</text>
            <text x={W - PAD} y={H - 8} text-anchor="end" font-size="10" fill="var(--muted)">+3 s</text>
            <path d={plot(sel)} fill="none" stroke="#594ae2" stroke-width="1.5" />
          </svg>
        {:else}
          <p class="muted">Waveform fills in 3 s after the trip…</p>
        {/if}
      </div>
    {/if}
    <div class="tscroll"><table class="logtable" style="font-family:inherit">
      <thead><tr><th>Module</th><th>Output</th><th>State</th><th>Peak A</th><th>Limit A</th></tr></thead>
      <tbody>
        {#each evts as e}
          <tr style="cursor:pointer" use:clickable class:dir-rx={e.id === sel?.id} onclick={() => (ovlSel = e.id)}>
            <td>{e.dev}</td><td>O{e.num} {e.name?.trim() ? e.name : ''}</td>
            <td><span class="lvl {e.state === 'Fault' ? 'e' : 'w'}">{e.state}</span></td>
            <td><b>{e.maxA?.toFixed(1)}</b></td><td>{e.limit}</td></tr>
        {/each}
      </tbody>
    </table></div>
  {/if}
{/if}
