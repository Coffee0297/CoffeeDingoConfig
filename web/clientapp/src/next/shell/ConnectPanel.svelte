<script>
  // Connect panel (board H14): pick an adapter, set the CAN speed, connect / disconnect.
  // Backed by GET /api/adapters, POST /api/connect, /api/disconnect, /api/usb/identify.
  import { Dialog, Banner, Button, Chip, Select, Field, Switch, Segmented } from '../ui/index.js'
  import { live, api, toast, hex } from '../lib/live.svelte.js'
  import { ui } from './ui.svelte.js'

  const RATES = ['125K', '250K', '500K', '1000K']
  const AUTO_ORDER = ['500K', '250K', '125K', '1000K']
  const LAST_KEY = 'nxLastConnection'
  const isTcp = (p) => /^\s*tcp:\/\//i.test(p ?? '')

  // What each choice means for POST /api/connect. `adapter` must be in the backend's list to be usable.
  const OPTIONS = [
    { id: 'usb', adapter: 'USB', name: 'USB, straight to a module', sub: 'Opens the first dingoPDM or CANBoard found on USB.' },
    { id: 'wifi', adapter: 'SLCAN', name: 'WiFi bridge', sub: 'Find a bridge on this network.' },
    { id: 'pcan', adapter: 'PCAN', name: 'PCAN', sub: 'PEAK PCAN-USB adapter. Needs the PEAK driver.' },
    { id: 'slcan', adapter: 'SLCAN', name: 'SLCAN, serial port', sub: 'Adapters that speak SLCAN over a COM port.' },
    { id: 'tcp', adapter: 'SLCAN', name: 'SLCAN over TCP', sub: 'The simulator or a network adapter. Host and port.' },
    { id: 'sim', adapter: 'Sim', name: 'Simulator replay', sub: 'A recorded log. Programming is off.' },
    { id: 'kvaser', adapter: 'Kvaser', name: 'Kvaser', sub: 'Needs the Kvaser CANlib driver.' },
    { id: 'socketcan', adapter: 'SocketCAN', name: 'SocketCAN', sub: 'Linux only.' },
  ]

  let info = $state({ adapters: [], ports: [], connected: false, activeAdapter: null, activePort: null, gatewayBaseId: null })
  let loaded = $state(false)
  let sel = $state('usb')
  let serial = $state('')
  let channel = $state('')
  let host = $state('127.0.0.1')
  let tcpPort = $state('7778')
  // G11: bridges found on the network (GET /api/adapters/discover, mDNS _slcan._tcp); bridge = the chosen tcp:// url
  let bridges = $state([]), bridge = $state(''), scanningNet = $state(false), netScanned = $state(false)
  // the last bridge used stays pickable before a search (the brief: "last one remembered")
  function restoreBridge() {
    const b = lastConn?.bridge
    if (!b?.url) return
    if (!bridges.some((x) => x.url === b.url)) bridges = [...bridges, { name: b.name ?? 'Last bridge', address: b.address ?? b.url.replace(/^tcp:\/\/|:\d+$/g, ''), port: b.port ?? Number(b.url.split(':').pop()), url: b.url }]
    if (!bridge) bridge = b.url
  }
  async function scanNet() {
    scanningNet = true
    try {
      bridges = (await (await fetch('/api/adapters/discover')).json()).bridges ?? []
      if (!bridges.some((b) => b.url === bridge)) bridge = bridges[0]?.url ?? ''
    } catch (e) { error = { title: 'Could not search the network', body: e?.message ?? String(e) } }
    finally { scanningNet = false; netScanned = true }
  }
  let rate = $state('500K')
  let auto = $state(false)
  let busy = $state(false)
  let step = $state('')
  let error = $state(null) // { title, body }
  let usbBusy = $state(false)
  let usbNote = $state('')
  let cancelled = false

  const last = (() => { try { return JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') } catch { return null } })()
  let lastConn = $state(last)

  const open = $derived(ui.panel === 'connect')
  const have = (o) => !o.adapter || info.adapters.some((a) => a.toLowerCase() === o.adapter.toLowerCase())
  const available = (o) => !o.gap && have(o)
  const activeId = $derived.by(() => {
    if (!live.connected) return null
    const a = (live.adapter ?? info.activeAdapter ?? '').toLowerCase()
    if (a === 'slcan') return isTcp(info.activePort) ? 'tcp' : 'slcan'
    return OPTIONS.find((o) => o.adapter?.toLowerCase() === a)?.id ?? null
  })
  const selOpt = $derived(OPTIONS.find((o) => o.id === sel))
  const ports = $derived(info.ports.map((p) => ({ value: p, label: p })))
  const moduleRate = $derived(live.devices.find((d) => d.bitrate)?.bitrate ?? null)
  const simActive = $derived(live.connected && /^sim$/i.test(live.adapter ?? ''))

  async function loadInfo() {
    try {
      const a = await api.adapters()
      info = { adapters: a.adapters ?? [], ports: a.ports ?? [], connected: !!a.connected, activeAdapter: a.activeAdapter ?? null, activePort: a.activePort ?? null, gatewayBaseId: a.gatewayBaseId ?? null }
      if (!serial || (!info.ports.includes(serial))) serial = info.ports[0] ?? ''
      if (a.connected && isTcp(a.activePort)) {
        const m = /^tcp:\/\/(.+):(\d+)\s*$/i.exec(a.activePort)
        if (m) { host = m[1]; tcpPort = m[2] }
      }
    } catch (e) { error = { title: 'Could not list adapters', body: e.message } }
    loaded = true
  }

  let wasOpen = false
  $effect(() => {
    if (open && !wasOpen) {
      error = null; usbNote = ''
      loadInfo().then(() => {
        sel = activeId ?? (lastConn?.sel && OPTIONS.find((o) => o.id === lastConn.sel && available(o)) ? lastConn.sel : 'usb')
        if (lastConn && !live.connected) { rate = lastConn.rate ?? rate; auto = !!lastConn.auto }
        else if (moduleRate && RATES.includes(moduleRate)) rate = moduleRate
        if (lastConn?.channel) channel = lastConn.channel
        restoreBridge()
      })
    }
    wasOpen = open
  })
  // Keep the "connected through" facts fresh while open and connected.
  $effect(() => { if (open && live.connected) { live.adapter; loadInfo() } })

  function params(id = sel) {
    const o = OPTIONS.find((x) => x.id === id)
    let port = ''
    if (id === 'slcan') port = serial
    else if (id === 'tcp') port = `tcp://${host.trim()}:${String(tcpPort).trim()}`
    else if (id === 'wifi') port = bridge
    else if (id === 'pcan' || id === 'kvaser') port = channel.trim() || (id === 'pcan' ? 'PCAN_USBBUS1' : '0')
    return { adapter: o.adapter, port }
  }
  const problem = $derived.by(() => {
    if (!selOpt || !available(selOpt)) return 'This adapter is not available.'
    if (sel === 'slcan' && !serial) return 'No serial port found. Plug the adapter in and reopen this panel.'
    if (sel === 'wifi' && !bridge) return 'Search the network and pick a bridge.'
    if (sel === 'tcp') {
      if (!host.trim()) return 'Type the host, for example 127.0.0.1.'
      if (!/^\d+$/.test(String(tcpPort).trim()) || Number(tcpPort) < 1 || Number(tcpPort) > 65535) return 'The port is a number from 1 to 65535.'
    }
    return ''
  })

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  function explain(msg) {
    if (/busy|in use|access.*denied|another program|couldn't open|could not open/i.test(msg ?? '')) return { title: 'The port is busy', body: msg + ' Close any other program that uses it (another dingoConfig window, a serial terminal, the firmware flasher), then try again.' }
    if (/No dingo module found on USB/i.test(msg ?? '')) return { title: 'No module on USB', body: msg }
    return { title: 'Could not connect', body: msg }
  }

  async function connect() {
    if (busy || problem) return
    busy = true; error = null; cancelled = false
    const { adapter, port } = params()
    try {
      if (live.connected) { step = 'Closing the current connection…'; await api.disconnect() }
      const rates = auto ? AUTO_ORDER : [rate]
      let used = null
      for (const r of rates) {
        if (cancelled) { error = { title: 'Stopped', body: 'You stopped connecting.' }; return }
        step = auto ? `Trying ${r}…` : `Opening ${adapter}${port ? ' ' + port : ''}…`
        const res = await api.connect(adapter, port, r)
        if (!res?.ok) { error = explain(res?.error ?? `${adapter}${port ? ' ' + port : ''} did not open. Check the port is free and the speed matches the bus.`); return }
        if (!auto) { used = r; break }
        // Auto-detect: keep the speed at which frames arrive. Give each speed 3 s of traffic.
        const start = live.canTotal
        let heard = false
        for (let i = 0; i < 12 && !heard; i++) { await sleep(250); heard = live.canTotal - start > 3 }
        if (heard) { used = r; break }
        await api.disconnect()
      }
      if (!used) { error = { title: 'No traffic at any speed', body: 'No frames were heard at 500K, 250K, 125K or 1000K. Switch the ignition on if the modules are asleep, check CAN-H and CAN-L and the terminators, or pick a speed by hand.' }; return }
      rate = used
      // the found speed is kept: show it, so the next reconnect does not search again
      auto = false
      lastConn = { sel, rate: used, auto, channel, host, tcpPort, serial, bridge: sel === 'wifi' ? bridges.find((b) => b.url === bridge) ?? { url: bridge } : lastConn?.bridge }
      try { localStorage.setItem(LAST_KEY, JSON.stringify(lastConn)) } catch {}
      toast(`Connected · ${adapter}${port ? ' ' + port : ''} · ${used}`, 'info', 3000)
      await loadInfo()
    } catch (e) {
      error = explain(e?.message ?? String(e))
    } finally { busy = false; step = '' }
  }

  async function disconnect() {
    if (busy) return
    busy = true; error = null; step = 'Disconnecting…'
    try { await api.disconnect(); toast('Disconnected', 'info', 2500); usbNote = ''; await loadInfo() }
    catch (e) { error = { title: 'Could not disconnect', body: e.message } }
    finally { busy = false; step = '' }
  }

  async function usbIdentify() {
    usbBusy = true; usbNote = ''
    try {
      const r = await api.usbIdentify()
      info.gatewayBaseId = r?.gatewayBaseId ?? null
      usbNote = r?.gatewayBaseId != null ? `The module on USB answers on ${hex(r.gatewayBaseId)}.` : 'No module answered on USB. The link may not be a module USB link.'
    } catch (e) { usbNote = 'Could not ask the module: ' + e.message }
    finally { usbBusy = false }
  }

  function useLast() {
    if (!lastConn) return
    sel = lastConn.sel; rate = lastConn.rate ?? rate; auto = !!lastConn.auto
    channel = lastConn.channel ?? ''; host = lastConn.host ?? host; tcpPort = lastConn.tcpPort ?? tcpPort
    restoreBridge()
    if (lastConn.serial && info.ports.includes(lastConn.serial)) serial = lastConn.serial
    connect()
  }

  const status = $derived.by(() => {
    if (busy) return { tone: 'info', mark: '◌ Connecting', title: step || 'Connecting…', body: 'This can take about 5 seconds.' }
    if (error) return { tone: 'fault', mark: '■ Not connected', title: error.title, body: error.body }
    if (live.connected) {
      const answering = live.devices.filter((d) => d.connected).length
      const via = `${live.adapter ?? info.activeAdapter ?? 'Adapter'}${info.activePort ? ' · ' + info.activePort : ''}`
      return { tone: simActive ? 'warn' : 'ok', mark: simActive ? '◆ Simulator replay' : '● Connected', title: `Connected through ${via}`, body: `${moduleRate ?? 'speed unknown'} · ${answering} of ${live.devices.length} modules answering${info.gatewayBaseId != null ? ` · the module on USB is ${hex(info.gatewayBaseId)}` : ''}.` }
    }
    return { tone: 'info', mark: '○ Not connected', title: 'Not connected', body: 'Pick an adapter and the CAN speed, then connect. Nothing can be read from or written to the car until you do.' }
  })
</script>

<Dialog bind:open={() => open, (v) => { if (!v) ui.panel = null }} title="Connection" width={1040}>
  <div class="st" role="status" data-tone={status.tone} data-testid="connect-status">
    <div class="sx">
      <span class="mark">{status.mark}</span>
      <strong>{status.title}</strong>
      <span class="muted">{status.body}</span>
    </div>
    <div class="sa">
      {#if busy}
        <Button onclick={() => (cancelled = true)}>Stop</Button>
      {:else if live.connected}
        <Button onclick={disconnect} data-testid="disconnect">Disconnect</Button>
      {/if}
    </div>
  </div>

  {#if simActive}
    <Banner tone="warn" title="Programming is off with the simulator replay">Write, Store on modules and flashing are disabled so nothing can reach a real car.</Banner>
  {/if}

  <div class="grid">
    <div class="col">
      <span class="nx-label" id="ad-l">Adapter</span>
      <div class="opts" role="radiogroup" aria-labelledby="ad-l">
        {#each OPTIONS as o (o.id)}
          {@const ok = available(o)}
          <label class="opt" class:dis={!ok}>
            <input type="radio" class="ri" name="nx-adapter" value={o.id} checked={sel === o.id} disabled={!ok || busy} onchange={() => { sel = o.id; error = null }} />
            <span class="ring" aria-hidden="true"></span>
            <span class="ot"><strong>{o.name}</strong><span class="muted">{o.sub}</span></span>
            <span class="ob">
              {#if activeId === o.id}<Chip tone="ok" symbol="●">In use</Chip>
              {:else if o.gap}<Chip dashed>Not available yet</Chip>
              {:else if !ok}<Chip dashed>Not on this PC</Chip>
              {:else}<Chip tone="muted" symbol="○">Available</Chip>{/if}
            </span>
          </label>
        {/each}
      </div>
    </div>

    <div class="col">
      <div class="box">
        <h3>{selOpt?.name}</h3>
        {#if sel === 'usb'}
          <p class="muted">dingoConfig opens the first dingoPDM or CANBoard it finds on USB and talks to the whole bus through it. No adapter box needed.</p>
          {#if info.ports.length}<p class="muted">COM ports on this PC: <span class="mono">{info.ports.join(', ')}</span>. The module's own port is found when you connect.</p>{/if}
        {:else if sel === 'wifi'}
          <p class="muted">Finds bridges that announce SLCAN over TCP on this network (mDNS service <span class="mono">_slcan._tcp</span>). A bridge that does not can still be reached with SLCAN over TCP and its address.</p>
          <div><Button onclick={scanNet} busy={scanningNet} disabled={busy || scanningNet} data-testid="wifi-scan">Search the network</Button></div>
          {#if bridges.length}
            <Select label="Bridge" items={bridges.map((b) => ({ value: b.url, label: `${b.name} · ${b.address}:${b.port}` }))} bind:value={bridge} data-testid="wifi-bridge" />
          {:else if netScanned && !scanningNet}
            <p class="muted" role="status" data-testid="wifi-none">No bridge answered. Check that it is on and on the same network, or use SLCAN over TCP with its address.</p>
          {/if}
        {:else if sel === 'pcan'}
          <Field label="Channel" bind:value={channel} placeholder="PCAN_USBBUS1" hint="PCAN needs the PEAK driver installed. Leave empty for the first channel." mono />
        {:else if sel === 'slcan'}
          {#if ports.length}
            <Select label="Serial port" items={ports} bind:value={serial} />
          {:else}
            <p class="muted">No serial port found. Plug the adapter in and reopen this panel.</p>
          {/if}
          <p class="muted">For adapters that speak SLCAN over a serial port. The CAN speed is set below.</p>
        {:else if sel === 'tcp'}
          <div class="two">
            <Field label="Host" bind:value={host} mono />
            <Field label="Port" bind:value={tcpPort} mono />
          </div>
          <p class="muted">The simulator on this PC is <span class="mono">127.0.0.1</span> and port <span class="mono">7778</span>.</p>
        {:else if sel === 'sim'}
          <p class="muted">Replays a recorded log. Programming is off with the simulator replay. The recording sets the speed.</p>
        {:else if sel === 'kvaser'}
          <Field label="Channel" bind:value={channel} placeholder="0" hint="Kvaser needs the CANlib driver installed." mono />
        {:else if sel === 'socketcan'}
          <p class="muted">SocketCAN is part of Linux. This PC runs Windows, so use USB, PCAN or SLCAN.</p>
        {/if}
        {#if problem && selOpt && available(selOpt)}<p class="bad" role="status">■ {problem}</p>{/if}
      </div>

      <div class="box">
        <span class="nx-label" id="br-l">CAN speed (bitrate)</span>
        <div role="group" aria-labelledby="br-l">
          <Segmented label="CAN speed" value={auto ? 'auto' : rate} disabled={busy}
            items={[...RATES.map((r) => ({ value: r, label: r.replace('K', ' k') })), { value: 'auto', label: 'Auto-detect' }]}
            onchange={(v) => { if (v === 'auto') auto = true; else { auto = false; rate = v } }} />
        </div>
        <p class="muted">
          {#if auto}Auto-detect tries 500 k, 250 k, 125 k and 1000 k and keeps the speed where frames arrive. The bus needs traffic, so switch the ignition on if the modules are asleep.
          {:else if sel === 'sim'}The recording sets the speed.
          {:else}All modules on one bus must use the same speed.{moduleRate ? ` The modules in the project report ${moduleRate}.` : ""}{/if}
        </p>
      </div>

      <div class="box">
        <Switch label="Connect automatically when dingoConfig starts" hint="Not available yet: the backend does not remember the last connection (gap G10)." checked={false} disabled />
        <Switch label="Reconnect if the link drops" hint="Not available yet: the backend does not reconnect the adapter (gap G10). The live feed reconnects by itself." checked={false} disabled />
      </div>

      {#if live.connected}
        <div class="box">
          <span class="nx-label">Module on USB</span>
          <div class="row">
            <Button onclick={usbIdentify} busy={usbBusy} data-testid="usb-identify">Identify the module on USB</Button>
            <span class="muted" role="status">{usbNote || (info.gatewayBaseId != null ? `It answers on ${hex(info.gatewayBaseId)}.` : 'Ask the module on the USB link for its base ID. It moves when a module is re-addressed.')}</span>
          </div>
        </div>
      {/if}
    </div>
  </div>

  {#snippet footer()}
    <span class="muted last">
      {#if lastConn}Last connection: <span class="mono">{OPTIONS.find((o) => o.id === lastConn.sel)?.name} · {lastConn.auto ? 'auto' : lastConn.rate}</span>{:else}No earlier connection on this browser.{/if}
    </span>
    {#if lastConn}<Button onclick={useLast} disabled={busy}>Use last connection</Button>{/if}
    <Button onclick={() => (ui.panel = null)}>Close</Button>
    {#if live.connected && activeId === sel}
      <Button variant="secondary" onclick={disconnect} disabled={busy}>Disconnect</Button>
      <Button variant="primary" onclick={connect} disabled={busy || !!problem}>Reconnect</Button>
    {:else}
      <Button variant="primary" onclick={connect} busy={busy} disabled={!!problem} data-testid="connect">{sel === 'sim' ? 'Connect to simulator' : 'Connect'}</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .st { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); border: 1px solid var(--color-line); background: var(--color-raised); }
  .st[data-tone='fault'] { background: var(--color-fault-soft); border-color: var(--color-fault); }
  .st[data-tone='warn'] { background: var(--color-warn-soft); border-color: var(--color-warn); }
  .sx { flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .sx strong { font-size: var(--text-lg); overflow-wrap: anywhere; }
  .mark { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; }
  .st[data-tone='ok'] .mark { color: var(--color-ok); }
  .st[data-tone='fault'] .mark { color: var(--color-fault); }
  .st[data-tone='warn'] .mark { color: var(--color-warn); }
  .grid { display: grid; grid-template-columns: minmax(0, 420px) minmax(0, 1fr); gap: var(--space-5); }
  .col { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
  .opts { display: flex; flex-direction: column; gap: 6px; }
  .ri { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
  .ri:disabled { cursor: not-allowed; }
  .opt { position: relative; display: flex; align-items: center; gap: var(--space-3); min-height: 52px; padding: 6px var(--space-3); border-radius: var(--radius-md); border: 2px solid var(--color-line); cursor: pointer; }
  .opt:has(input:checked) { border-color: var(--color-accent); background: var(--color-raised); }
  .opt:has(input:focus-visible) { outline: 3px solid var(--color-focus); outline-offset: 2px; }
  .opt.dis { opacity: 0.7; cursor: not-allowed; }
  .ring { flex: none; width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--color-line-strong); }
  .opt:has(input:checked) .ring { border: 5px solid var(--color-accent); }
  .ot { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  .ot .muted { font-size: var(--text-xs); }
  .ob { flex: none; }
  .box { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); border: 1px solid var(--color-line); background: var(--color-bg); }
  .box h3 { font-size: var(--text-md); }
  .two { display: grid; grid-template-columns: 1fr 120px; gap: var(--space-3); }
  .row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .bad { color: var(--color-fault); font-weight: 600; }
  .last { margin-right: auto; align-self: center; }
</style>
