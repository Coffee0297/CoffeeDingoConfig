<script>
  import { api, telemetry, hubState } from './store.js'
  import { toast } from './toast.js'
  let { current } = $props()
  // A module is writable only when it's actually answering on the bus; the feed is "stale" when
  // the hub dropped or telemetry froze, so the tiles below are showing last-known, not live, data.
  let live = $derived(!!current?.connected)
  let stale = $derived($telemetry?.stale || $hubState !== 'live')

  let signals = $state([])
  $effect(() => {
    const g = current?.guid
    if (!g) { signals = []; return }
    let alive = true
    const load = async () => { try { if (alive) signals = await api.signals(g) } catch {} }
    load()
    const id = setInterval(load, 400)
    return () => { alive = false; clearInterval(id) }
  })

  const sc = (s) => (s === 'On' ? 'on' : s === 'Overcurrent' ? 'oc' : s === 'Fault' ? 'fault' : 'off')
  // A CANBoard has no battery / total-current sensing and no PDM-style outputs — its dashboard
  // shows board temp + its own I/O instead. Drive that off the device type.
  let isCb = $derived(/canboard|can.?board/i.test(current?.type ?? ''))
  let outs = $derived((current?.outputs) ?? [])
  let digOuts = $derived(signals.filter((s) => s.kind === 'Digital output'))
  let analogs = $derived(signals.filter((s) => s.kind === 'Analog input'))
  let rotaries = $derived(signals.filter((s) => s.kind === 'Rotary position'))
  let digIns = $derived(signals.filter((s) => s.kind === 'Digital input'))
  let flashers = $derived(signals.filter((s) => s.kind === 'Flasher'))
  let canActive = $derived(signals.filter((s) => s.kind === 'CAN input' && s.on))
  let condActive = $derived(signals.filter((s) => s.kind === 'Condition' && s.on))
  // Friendly verb per action for toast feedback.
  const VERB = { read: 'Read', write: 'Write', burn: 'Burn', sleep: 'Sleep', wakeup: 'Wakeup', bootloader: 'Bootloader', version: 'Version' }
  let acting = $state(false)
  async function act(a) {
    if (!current || acting) return
    if (!live) { toast(`${current.name} isn't on the bus — connect it before read/write/burn.`, 'error'); return }
    // Confirm the genuinely disruptive ones (persistent / stops the running program).
    if (a === 'burn' && !confirm(`Burn the config to "${current.name}"? This writes permanently to flash.`)) return
    if (a === 'bootloader' && !confirm(`Put "${current.name}" into its bootloader? It stops running until reflashed/rebooted.`)) return
    acting = true
    try { await api.action(current.guid, a); toast(`${VERB[a] ?? a} ✓`, 'ok') }
    catch (e) { toast(`${VERB[a] ?? a} failed: ${e.message}`, 'error') }
    finally { acting = false }
  }
</script>

<div class="h-row">
  <div><h1>{current ? current.name : '—'} · Dashboard</h1>
    <p class="sub">Live device state and the read / write / burn controls.</p></div>
</div>

{#if !current}
  <div class="card flat"><p class="muted">No device bound — go to Outputs to add one.</p></div>
{:else}
  <div class="devbar">
    <button class="btn" disabled={!live} onclick={() => act('read')}>Read</button>
    <button class="btn" disabled={!live} onclick={() => act('write')}>Write</button>
    <button class="btn primary" disabled={!live} onclick={() => act('burn')}>Burn</button>
    <span class="sep"></span>
    <button class="btn ghost" disabled={!live} onclick={() => act('sleep')}>Sleep</button>
    <button class="btn ghost" disabled={!live} onclick={() => act('wakeup')}>Wakeup</button>
    <button class="btn ghost" disabled={!live} onclick={() => act('bootloader')}>Bootloader</button>
    <button class="btn ghost" disabled={!live} onclick={() => act('version')}>Version</button>
    {#if !live}<span class="mismatch">⚠ {current.name} not on the bus — read / write / burn need a live module</span>
    {:else if current.version === 'v0.0.0'}<span class="mismatch">⚠ not read yet — press Read</span>{/if}
  </div>

  {#if !live || stale}
    <div class="sys-alert">{!live ? `${current.name} is not on the bus — these are last-known values, not live.` : 'Live feed frozen — values below may be stale.'}</div>
  {/if}
  <div class="tiles-stat" style={(!live || stale) ? 'opacity:.5' : ''}>
    {#if !isCb}
      <div class="stat"><div class="v">{current.battery.toFixed(1)} V</div><div class="k">Battery voltage</div></div>
      <div class="stat"><div class="v">{current.current.toFixed(1)} A</div><div class="k">Total current</div></div>
    {/if}
    <div class="stat"><div class="v">{Math.round(current.temp)} °C</div><div class="k">Board temp</div></div>
    {#if !isCb}<div class="stat"><div class="v">{current.state}</div><div class="k">Device state</div></div>{/if}
    <div class="stat"><div class="v">{current.version}</div><div class="k">FW version</div></div>
    <div class="stat"><div class="v">{current.bitrate}</div><div class="k">CAN bitrate</div></div>
  </div>

  {#if isCb}
    <div class="cat-grp">Live status — Digital outputs <span class="ct"></span></div>
    <div class="statusgrid">
      {#each digOuts as s}
        <div class="sc"><span class="scn">{s.name}</span>
          <span class="state {s.on ? 'on' : 'off'}" style="padding:1px 7px"><span class="ic"></span>{s.on ? 'ON' : 'OFF'}</span></div>
      {/each}
      {#if digOuts.length === 0}<span class="muted" style="font-size:13px">No digital outputs.</span>{/if}
    </div>
    <div class="cat-grp">Analog inputs <span class="ct"></span></div>
    <div class="statusgrid">
      {#each analogs as s}
        {@const pos = rotaries.find((r) => r.name === s.name + ' Pos')}
        <div class="sc"><span class="scn">{s.name}</span><span class="scv">{s.value} mV{#if pos} · pos {pos.value}{/if}</span></div>
      {/each}
    </div>
  {:else}
    <div class="cat-grp">Live status — Outputs <span class="ct"></span></div>
    <div class="statusgrid">
      {#each outs as o}
        <div class="sc"><span class="scn">O{o.number} {o.name?.trim() ? o.name : ''}</span>
          <span class="state {sc(o.state)}" style="padding:1px 7px"><span class="ic"></span>{o.state === 'On' ? `ON · ${o.current.toFixed(1)}A` : o.state.toUpperCase()}</span></div>
      {/each}
    </div>
  {/if}

  <div class="cat-grp">Digital inputs · Flashers <span class="ct"></span></div>
  <div class="statusgrid">
    {#each digIns as s}
      <div class="sc"><span class="scn">{s.name}</span><span class="scv" style={s.on ? 'color:var(--ok)' : ''}>{s.value}</span></div>
    {/each}
    {#each flashers as s}
      <div class="sc"><span class="scn">{s.name}</span><span class="scv" style={s.on ? 'color:var(--ok)' : ''}>{s.value}</span></div>
    {/each}
  </div>

  <div class="cat-grp">Active CAN inputs · conditions <span class="ct"></span></div>
  {#if canActive.length === 0 && condActive.length === 0}
    <p class="muted" style="font-size:13px">None active right now.</p>
  {:else}
    <div class="statusgrid">
      {#each canActive as s}<div class="sc"><span class="scn">{s.name}</span><span class="scv" style="color:var(--ok)">{s.value}</span></div>{/each}
      {#each condActive as s}<div class="sc"><span class="scn">{s.name}</span><span class="scv" style="color:var(--ok)">{s.value}</span></div>{/each}
    </div>
  {/if}
{/if}
