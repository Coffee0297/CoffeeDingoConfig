<script>
  import { telemetry, hubState, reconnectHub, api, luaReadToTabs, awgFor, awgForMm2, outputRatingA, deviceDefs, gatherClientState, restoreClientState } from './lib/store.js'
  import { toast, toasts, dismiss } from './lib/toast.js'
  import { clickable, labelFields, dialog as dlg } from './lib/a11y.js'
  import Sparkline from './lib/Sparkline.svelte'
  import Dashboard from './lib/Dashboard.svelte'
  import SystemView from './lib/SystemView.svelte'
  import SignalsView from './lib/SignalsView.svelte'
  import LogsView from './lib/LogsView.svelte'
  import OutputDrawer from './lib/OutputDrawer.svelte'
  import DeviceTypeView from './lib/DeviceTypeView.svelte'
  import KeypadView from './lib/KeypadView.svelte'
  import GraphView from './lib/GraphView.svelte'
  import PlotView from './lib/PlotView.svelte'
  import McpView from './lib/McpView.svelte'

  // Reload resumes where you left off — last view + selected module (System overview on first run).
  let view = $state((() => { try { return localStorage.getItem('dingoView') || 'system' } catch { return 'system' } })())
  $effect(() => { try { localStorage.setItem('dingoView', view) } catch {} })
  // Dark by default; remember the user's choice across reloads (only an explicit 'light' opts out).
  let dark = $state((() => { try { return localStorage.getItem('dingoTheme') !== 'light' } catch { return true } })())
  $effect(() => { try { localStorage.setItem('dingoTheme', dark ? 'dark' : 'light') } catch {} })
  let ports = $state([])
  let adapters = $state(['USB'])
  let adapter = $state('USB')
  let port = $state('COM3')
  let bitrate = $state('500K')
  let newBaseId = $state('0x7CE')
  let editBaseId = $state('0x7CE')
  let busy = $state(false)
  let switchOpen = $state(false)
  let readOpen = $state(false)
  let deployOpen = $state(false)
  let projOpen = $state(false)
  let scopeGuid = $state((() => { try { return localStorage.getItem('dingoScope') || null } catch { return null } })())
  $effect(() => { try { scopeGuid ? localStorage.setItem('dingoScope', scopeGuid) : localStorage.removeItem('dingoScope') } catch {} })
  let graphWin = $state(60)
  let cardMode = $state({}) // output number -> 'amps' | 'trig'
  let editNum = $state(null)
  let dialog = $state(null) // 'add' | 'modify' | 'settings'
  let dlgName = $state(''), dlgType = $state('pdm'), dlgBase = $state('0x7CE')
  const deviceTypes = [
    ['pdm', 'dingoPDM'], ['canboard', 'CANBoard'], ['dbcdevice', 'DBC Device'],
    ['blinkkeypad-PKP-2400', 'Blink Marine Keypad'], ['grayhillkeypad', 'Grayhill Keypad'],
  ]
  let projFileName = $state('project.json')
  function toggleProj() { projOpen = !projOpen }
  // Save the whole project as a file the browser writes to the user's PC (cross-platform — no
  // server folder). The backend streams the project JSON; we download it under the chosen name.
  async function doSave() {
    projOpen = false
    try {
      const doc = await api.projDownload()
      doc.dingoConfigClient = gatherClientState()   // cross-module functions, Lua, bridges, layout
      const name = (projFileName || 'project').replace(/\.json$/i, '') + '.json'
      const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a'); a.href = url; a.download = name; a.click()
      URL.revokeObjectURL(url)
      toast(`Saved ${name}`, 'ok')
    } catch (e) { toast('Save failed: ' + e.message, 'error') }
  }
  // Open a project file the user picks from anywhere on their PC.
  let projOpenEl = $state(null)
  async function doOpenFile(ev) {
    const file = ev.target.files?.[0]; ev.target.value = ''
    if (!file) return
    projOpen = false
    try {
      const text = await file.text()
      const r = await api.projUpload(text)                                  // backend loads devices (ignores the client section)
      try { restoreClientState(JSON.parse(text).dingoConfigClient) } catch {}  // cross-module functions, Lua, bridges, layout
      scopeGuid = null
      toast(`Opened ${file.name} — ${r?.count ?? 0} module(s)`, 'ok')
    } catch (e) { toast('Open failed: ' + e.message, 'error') }
  }
  async function doNewProj() {
    projOpen = false
    if (!confirm('Start a new project? This clears every configured device.')) return
    try { await api.projNew(); scopeGuid = null; toast('New project started', 'ok') } catch (e) { toast('Could not clear project: ' + e.message, 'error') }
  }
  // Import a config JSON (apply-doc format, same as MCP apply_config / the downloadable
  // template). Reads the file, POSTs it, reports the per-device result.
  let importEl = $state(null)
  async function doImportFile(ev) {
    const file = ev.target.files?.[0]; ev.target.value = ''
    if (!file) return
    projOpen = false
    try {
      const doc = JSON.parse(await file.text())
      const r = await api.applyConfig(doc)
      if (r.ok) toast(`Imported ${file.name}: ${r.devicesTouched} device(s), ${r.paramsChanged} setting(s)`, 'ok')
      else toast(`Imported with ${r.errors.length} issue(s): ${r.errors[0] ?? ''}`, 'error')
    } catch (e) { toast('Import failed: ' + e.message, 'error') }
  }
  async function doDownloadTemplate() {
    projOpen = false
    try {
      const doc = await api.configTemplate()
      const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a'); a.href = url; a.download = 'dingopdm-template.json'; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { toast('Could not build template: ' + e.message, 'error') }
  }
  // Export the whole current config (every device + every setting + Lua) as a JSON file,
  // in the same apply-doc shape that Import and the template use — so it round-trips.
  async function doExportJson() {
    projOpen = false
    try {
      const doc = await api.configSnapshot(true)
      const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a'); a.href = url; a.download = (projFileName.replace(/\.json$/i, '') || 'dingopdm-config') + '-export.json'; a.click()
      URL.revokeObjectURL(url)
      toast(`Exported ${doc.devices?.length ?? 0} device(s)`, 'ok')
    } catch (e) { toast('Export failed: ' + e.message, 'error') }
  }
  function openSettings() { dialog = 'settings' }
  function openModify() { if (!current) return; dlgName = current.name; dlgBase = hex(current.baseId); dialog = 'modify' }
  async function saveDialog() {
    try {
      if (dialog === 'add') await api.addDevice(dlgType, dlgName || dlgType, dlgBase)
      else if (dialog === 'modify' && current) await api.modify(current.guid, dlgName, dlgBase)
    } catch (e) { toast(e.message, 'error'); return }
    dialog = null
  }

  const bitrates = ['1000K', '500K', '250K', '125K', '100K']
  const navs = [
    ['system', 'System'], ['dashboard', 'Dashboard'], ['outputs', 'Outputs'],
    ['signals', 'Signals & logic'], ['wiring', 'Wiring'], ['plot', 'Plot'], ['logs', 'Logs'],
    ['mcp', 'MCP'],
  ]

  // ---- contextual help (#40) ----
  let helpOpen = $state(false)
  const HELP = {
    outputs: { title: 'Outputs', body: [
      'Each output is a smart high-side switch with current sensing. Click a card to configure it.',
      'Input — the signal that turns it on (a pin, CAN signal, condition, or Lua slot).',
      'Current limit / inrush — trips the output off; inrush allows a higher current for the inrush time (bulbs, motors).',
      'Reset mode — none / count (retry N times) / endless. Warn & open-load limits flag a soft over-current or a disconnected load without tripping.',
      'PWM / soft-start — drive the output at a duty cycle or ramp it up.',
      'Save writes to the device live; Burn keeps it across a reboot.' ] },
    dashboard: { title: 'Dashboard', body: [
      'Live state of the selected module — battery, total current, board temperature, and every output.',
      'Read pulls the full config off the device; Write pushes the in-app config; Burn persists it.',
      'Sleep / Wakeup request the low-power state (sleep is ignored while USB is connected — see System ▸ Settings for the timeout).' ] },
    system: { title: 'System', body: [
      'All modules on the bus. Click a module to open it; drag its pin on the car map to match the install.',
      '⚙ Settings — auto-sleep enable + timeout, written and burned to the module.',
      '⬆ Firmware — flash a new .bin over USB DFU. Keep the module powered.',
      'Cross-module functions — define a behaviour once (a rule compiles to native CAN wiring; switch to Lua to write it yourself, needed for clock failover), then Deploy to the modules.' ] },
    signals: { title: 'Signals & logic', body: [
      'The module’s inputs and logic blocks: physical pins, CAN messages, and logic built from them.',
      'CAN input — pull a value/bit out of an incoming frame. Condition — true when a signal crosses a value. Virtual input — AND/OR up to 3 signals. Flasher — a blink pattern. Counter — count events. CAN output — transmit a variable.',
      'The mini chart on each row is that signal’s live value (last 30 s).',
      'Lua — any output / virtual input / CAN output can be driven by a Lua slot. Upload sends the program; Burn keeps it.' ] },
    wiring: { title: 'Wiring', body: [
      'A node-graph of the module’s functions. Drag from a purple output ● (right) to a green input ● (left) to wire one function’s output into another’s input.',
      'Delete a block with its ✕ or by selecting it and pressing Delete (the function is disabled on the device).',
      '+ Add node creates a function; + Remote signal grabs a signal from another module over CAN.',
      'Changes write live — press Burn to keep them.' ] },
    plot: { title: 'Plot', body: [
      'Chart any signal from any module, live. Pick a module + signal and + Add to plot — add as many as you like.',
      'Click a legend chip to show/hide its line; ✕ removes it. Pause freezes sampling; Window sets the visible time span.',
      '⬇ Export PNG saves the current chart as an image.' ] },
    logs: { title: 'Logs', body: [
      'CAN traffic and the system log. Export either to CSV for analysis.' ] },
  }
  const helpFor = () => HELP[view] ?? { title: navs.find((n) => n[0] === view)?.[1] ?? 'Help', body: ['No help for this view yet.'] }

  let t = $derived($telemetry)
  let devices = $derived(t.devices ?? [])
  let current = $derived(devices.find((d) => d.guid === scopeGuid) ?? devices[0] ?? null)
  // Keep the Base ID editor in sync with the selected device — but only when the device
  // actually changes, so live telemetry ticks don't clobber what the user is typing.
  let baseIdSyncedGuid = null
  $effect(() => {
    const g = current?.guid
    if (g && g !== baseIdSyncedGuid) { baseIdSyncedGuid = g; editBaseId = hex(current.baseId) }
  })
  let isPdm = $derived(current && !/keypad|dbc|canboard|can.?board/i.test(current.type))
  // Worst-case load: every enabled output drawing its full current limit at once.
  let maxAmps = $derived((current?.outputs ?? []).filter((o) => o.enabled).reduce((s, o) => s + (o.currentLimit ?? 0), 0))
  let readPct = $derived(current?.readTotal ? Math.round((current.readDone / current.readTotal) * 100) : 0)

  $effect(() => { if (current && !devices.find((d) => d.guid === scopeGuid)) scopeGuid = current.guid })

  async function loadPorts() {
    try {
      const a = await api.adapters(); ports = a.ports ?? []
      if (a.adapters?.length) { adapters = a.adapters; if (!adapters.includes(adapter)) adapter = adapters[0] }
      if (!ports.includes(port)) port = ports.find((p) => /COM3/i.test(p)) ?? ports[0] ?? ''
    } catch (e) { toast('Could not list adapters: ' + e.message, 'error') }
  }
  loadPorts()
  // Sim/SocketCAN don't use a serial port; only serial adapters need one picked.
  let needsPort = $derived(/usb|slcan|socketcan|pcan/i.test(adapter))

  async function connect() {
    busy = true
    try {
      // The backend returns HTTP 200 {ok:false} when the adapter can't actually open (port busy,
      // wrong/missing COM, init failure) — so a bare resolve is NOT proof of a link. Inspect ok.
      const r = await api.connect(adapter, port, bitrate)
      if (!r?.ok) { toast(`Connect failed — ${adapter}${needsPort ? ' ' + port : ''} didn't open. Check the port isn't already in use and the bitrate matches the bus.`, 'error'); return }
      toast(`Connected · ${adapter} ${bitrate}`, 'ok')
    } catch (e) { toast('Connect failed: ' + e.message, 'error') } finally { busy = false }
  }
  async function disconnect() { busy = true; try { await api.disconnect() } catch (e) { toast('Disconnect failed: ' + e.message, 'error') } finally { busy = false } }
  async function addPdm() { try { await api.addDevice('pdm', 'PDM', newBaseId) } catch (e) { toast(e.message, 'error') } }
  // Scan the bus and identify each module's type from its broadcast signature.
  let scanning = $state(false)
  let usbOpen = $state(false)
  let usbFound = $state([])
  let usbSeen = $state([])
  let manualBase = $state('0x7CE')
  let manualType = $state('pdm')
  const normType = (tp) => (tp === 'blinkkeypad' ? 'blinkkeypad-PKP-2400' : tp)
  async function scanUsb() {
    if (scanning) return                                    // in-flight guard (no double-scan)
    if (!t.connected) { toast('Connect to an adapter first, then scan.', 'error'); return }
    scanning = true; usbFound = []; usbSeen = []; usbOpen = true
    try {
      let res = await api.identify()
      // Devices broadcast on a ~1 s cycle — give a couple of windows to accumulate frames.
      if (!res.found.length) { await new Promise((r) => setTimeout(r, 1500)); res = await api.identify() }
      if (!res.found.length) { await new Promise((r) => setTimeout(r, 1500)); res = await api.identify() }
      const known = new Set(devices.map((d) => d.baseId))
      usbFound = res.found.map((r) => ({ ...r, type: normType(r.type), already: known.has(r.baseId), add: !known.has(r.baseId) }))
      usbSeen = res.seen ?? []
    } catch (e) { toast(e.message, 'error') } finally { scanning = false }
  }
  const typeLabel = (tp) => deviceTypes.find((x) => x[0] === tp)?.[1] ?? 'Module'
  async function addScanned() {
    let n = 0
    for (const d of usbFound.filter((x) => x.add && !x.already)) {
      // Name follows the chosen type, not the (possibly wrong) auto-detected label.
      try { await api.addDevice(d.type, typeLabel(d.type) + ' ' + d.hex, d.hex); n++ } catch (e) { toast(e.message, 'error') }
    }
    if (n) toast(`Added ${n} module${n === 1 ? '' : 's'}`, 'ok')
    usbOpen = false
  }
  async function addManual() {
    try { await api.addDevice(manualType, (deviceTypes.find((x) => x[0] === manualType)?.[1] ?? 'Device') + ' ' + manualBase, manualBase); toast('Module added', 'ok') }
    catch (e) { toast(e.message, 'error') }
    usbOpen = false
  }
  async function setBase() {
    if (!current) return
    try { await api.modify(current.guid, current.name, editBaseId); toast(`Base ID set to ${editBaseId}`, 'ok') }
    catch (e) { toast('Set base ID failed: ' + e.message, 'error') }
  }
  async function removeDev() { if (current) await removeByGuid(current.guid) }
  async function removeByGuid(g) {
    const d = devices.find((x) => x.guid === g)
    if (!confirm(`Remove "${d?.name ?? 'this module'}" from the project?`)) return
    try { await api.remove(g); if (scopeGuid === g) scopeGuid = null } catch (e) { toast(e.message, 'error') }
  }
  // Burn permanently writes the in-app config to the module's flash — confirm + feedback.
  let burning = $state(false)
  async function burn() {
    if (!current || burning) return
    if (!confirm(`Burn the current config to "${current.name}"? This writes it permanently to the module's flash.`)) return
    burning = true
    try { await api.action(current.guid, 'burn'); toast(`Burned to ${current.name}`, 'ok') }
    catch (e) { toast('Burn failed: ' + e.message, 'error') } finally { burning = false }
  }
  // 'read'/'write' = bulk modified-param sync (one fast burst, CRC-checked) — the proven
  // fast path. 'readall'/'writeall' (every param) exist on the API but burst far longer.
  // Read = bulk config sync, then pull the Lua program back onto the per-output tabs
  // (so opening on a fresh PC restores everything with one Read). Lua read is best-effort.
  async function readOne(g) { await api.action(g, 'read'); try { await luaReadToTabs(g) } catch (e) { toast('Lua read-back skipped: ' + e.message, 'info') } }
  let scopeBusy = $state(false)
  // Run an action over one/all modules, continuing past per-module failures and reporting them.
  async function eachScope(all, fn, verb) {
    if (scopeBusy) return
    scopeBusy = true
    const targets = all ? devices : (current ? [current] : [])
    const fails = []
    for (const d of targets) { try { await fn(d) } catch (e) { fails.push(`${d.name}: ${e.message}`) } }
    scopeBusy = false
    if (fails.length) toast(`${verb} failed for ${fails.length}/${targets.length}: ${fails.join('; ')}`, 'error', 8000)
    else if (targets.length) toast(`${verb} ${targets.length} module${targets.length === 1 ? '' : 's'} ✓`, 'ok')
  }
  async function readScope(all) { readOpen = false; await eachScope(all, (d) => readOne(d.guid), 'Read') }
  async function deployScope(all) { deployOpen = false; await eachScope(all, (d) => api.action(d.guid, 'write'), 'Deployed') }
  function pickModule(g) { scopeGuid = g; switchOpen = false; if (view === 'system') view = 'dashboard' }
  function addModule() { dlgName = ''; dlgType = 'pdm'; dlgBase = '0x7CE'; dialog = 'add' }
  function setMode(n, m) { cardMode = { ...cardMode, [n]: m } }

  const sc = (s) => (s === 'On' ? 'on' : s === 'Overcurrent' ? 'oc' : s === 'Fault' ? 'fault'
    : s === 'Warning' || s === 'OpenLoad' ? 'oc' : 'off')
  const stT = (s) => (s === 'On' ? 'ON' : s === 'Overcurrent' ? 'OC' : s === 'Fault' ? 'FAULT'
    : s === 'Warning' ? 'WARN' : s === 'OpenLoad' ? 'OPEN' : 'OFF')
  const hex = (n) => '0x' + (n ?? 0).toString(16).toUpperCase().padStart(3, '0')
  // Input is now the friendly source name resolved from the device's VarMap.
  function ruleText(inp) {
    if (!inp || inp === 'None') return null
    if (inp === 'Always On') return 'always on'
    return inp
  }
  function driverTag(inp) {
    if (!inp || inp === 'None') return 'no rule'
    if (inp === 'Always On') return 'always on'
    return 'driven'
  }
</script>

<div class="rx" class:dark={dark}>
  <header class="bar">
    <span class="logo">dingoConfig</span>

    <span class="switch" class:open={switchOpen}>
      <span class="chip-btn" use:clickable aria-haspopup="menu" aria-expanded={switchOpen} onclick={() => (switchOpen = !switchOpen)}>
        <span class="scope-kicker">Module</span>
        <b class="scope-label">{current ? current.name : '—'}</b> ▾
      </span>
      <div class="menu" role="menu">
        <div class="mh">{devices.length} module{devices.length === 1 ? '' : 's'}</div>
        {#each devices as d (d.guid)}
          <div class="mi" role="menuitem" use:clickable onclick={() => pickModule(d.guid)}>
            <span class="dot-live" style={d.connected ? '' : 'background:var(--faint)'}></span>
            {d.name}<span style="margin-left:auto;font-family:var(--mono);color:var(--muted)">{hex(d.baseId)}</span>
            <button class="x" style="margin-left:8px" title="Remove module" aria-label={'Remove ' + d.name} onclick={(e) => { e.stopPropagation(); removeByGuid(d.guid) }}>✕</button>
          </div>
        {/each}
        {#if devices.length === 0}<div class="mi muted">No modules yet</div>{/if}
      </div>
    </span>

    <span class="nav-seg">
      {#each navs as [id, label]}
        <button class:active={view === id} aria-current={view === id ? 'page' : undefined} onclick={() => (view = id)}>{label}</button>
      {/each}
    </span>
    <button class="btn ghost" title="Help for this view" aria-label="Help for this view" style="padding:6px 10px;font-weight:700" onclick={() => (helpOpen = true)}>?</button>

    <span class="live" style={t.connected && !t.stale ? '' : 'color:var(--muted)'}>
      {#if t.connected && !t.stale}<span class="pulse"></span>{t.adapter} · {bitrate}{:else}<span class="dot-live" style="background:var(--faint)"></span>{t.stale ? 'Feed lost' : 'Disconnected'}{/if}
    </span>

    <span class="spacer"></span>

    <!-- Project (save/open/import/export/template) works offline too — not gated on a CAN connection. -->
    <span class="switch" class:open={projOpen}>
      <button class="btn ghost" aria-haspopup="menu" aria-expanded={projOpen} onclick={toggleProj}>📁 Project ▾</button>
      <div class="menu" role="menu" style="min-width:250px">
        <div class="mh">Project file (on your PC)</div>
        <div style="display:flex;gap:8px;padding:8px 13px">
          <input class="in" style="flex:1" aria-label="Save file name" bind:value={projFileName} />
          <button class="btn primary" onclick={doSave}>⬇ Save</button>
        </div>
        <div class="mi" role="menuitem" use:clickable onclick={() => projOpenEl?.click()}>📂 Open project…</div>
        <input bind:this={projOpenEl} type="file" accept="application/json,.json" style="display:none" onchange={doOpenFile} />
        <div class="mi" role="menuitem" use:clickable onclick={doNewProj}>＋ New (clear devices)</div>
        <div class="mh">Config (apply-doc)</div>
        <div class="mi" role="menuitem" use:clickable onclick={() => importEl?.click()}>⬆ Import JSON…</div>
        <div class="mi" role="menuitem" use:clickable onclick={doExportJson}>⬇ Export config JSON</div>
        <div class="mi" role="menuitem" use:clickable onclick={doDownloadTemplate}>⬇ Download template</div>
        <input bind:this={importEl} type="file" accept="application/json,.json" style="display:none" onchange={doImportFile} />
      </div>
    </span>

    {#if !t.connected}
      <select class="in" bind:value={adapter} aria-label="CAN adapter">{#each adapters as a}<option value={a}>{a}</option>{/each}</select>
      {#if needsPort}
        <select class="in" bind:value={port} aria-label="Serial port">
          {#each ports as p}<option value={p}>{p}</option>{/each}
          {#if ports.length === 0}<option value="">(no ports)</option>{/if}
        </select>
      {/if}
      <select class="in" bind:value={bitrate} aria-label="CAN bitrate">{#each bitrates as b}<option value={b}>{b}</option>{/each}</select>
      <button class="btn primary" disabled={busy} onclick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
    {:else}
      <button class="btn ghost" disabled={scanning} onclick={scanUsb} title="Scan the bus and add detected modules">{scanning ? 'Scanning…' : '🔍 Add from USB'}</button>
      <span class="switch" class:open={readOpen}>
        <span style="display:inline-flex">
          <button class="btn ghost" style="border-radius:8px 0 0 8px" disabled={!current || current?.reading || scopeBusy} onclick={() => readScope(false)}>{current?.reading ? `Reading ${readPct}%` : `Read: ${current?.name ?? '—'}`}</button>
          <button class="btn ghost" aria-label="Read target options" style="border-radius:0 8px 8px 0;border-left:1px solid var(--line-2);padding:7px 9px" onclick={() => (readOpen = !readOpen)}>▾</button>
        </span>
        <div class="menu" role="menu" style="right:0;left:auto"><div class="mh">Read target</div>
          <div class="mi" role="menuitem" class:muted={scopeBusy} use:clickable onclick={() => !scopeBusy && readScope(false)}>This module only</div>
          <div class="mi" role="menuitem" class:muted={scopeBusy} use:clickable onclick={() => !scopeBusy && readScope(true)}>All {devices.length} modules</div>
        </div>
      </span>
      <button class="btn" disabled={!current || burning} onclick={burn}>{burning ? 'Burning…' : 'Burn'}</button>
      <span class="switch" class:open={deployOpen}>
        <span style="display:inline-flex">
          <button class="btn primary" style="border-radius:8px 0 0 8px" disabled={!current || scopeBusy} onclick={() => deployScope(false)}>{scopeBusy ? 'Deploying…' : `Deploy: ${current?.name ?? '—'}`}</button>
          <button class="btn primary" aria-label="Deploy target options" style="border-radius:0 8px 8px 0;border-left:1px solid rgba(255,255,255,.35);padding:7px 9px" onclick={() => (deployOpen = !deployOpen)}>▾</button>
        </span>
        <div class="menu" role="menu" style="right:0;left:auto"><div class="mh">Deploy target</div>
          <div class="mi" role="menuitem" class:muted={scopeBusy} use:clickable onclick={() => !scopeBusy && deployScope(false)}>This module only</div>
          <div class="mi" role="menuitem" class:muted={scopeBusy} use:clickable onclick={() => !scopeBusy && deployScope(true)}>All {devices.length} modules</div>
        </div>
      </span>
      <button class="btn ghost icon" title="Disconnect" aria-label="Disconnect" disabled={busy} onclick={disconnect}>⏏</button>
    {/if}
    <button class="btn ghost icon" title="Settings" aria-label="Settings" onclick={openSettings}>⚙</button>
    <button class="btn ghost icon" title="Theme" aria-label="Toggle dark theme" aria-pressed={dark} onclick={() => (dark = !dark)}>{dark ? '☀' : '🌙'}</button>
  </header>

  {#if $hubState !== 'live'}
    <div class="hub-banner">
      {#if $hubState === 'reconnecting'}⟳ Live feed lost — reconnecting…{:else}⚠ Live feed disconnected — data is frozen.
        <button class="btn ghost" style="padding:2px 10px;margin-left:8px" onclick={() => reconnectHub().catch((e) => toast('Reconnect failed: ' + e.message, 'error'))}>Reconnect</button>{/if}
    </div>
  {/if}

  <main class="wrap">
    {#if view === 'outputs'}
      {#if !current || isPdm}
        <div class="h-row">
          <div>
            <h1>{current ? current.name : '—'} · Outputs</h1>
            <p class="sub">{current ? 'Each output is on when its rule is true — live state and current from the device.' : 'Connect and bind a device to see its outputs.'}</p>
          </div>
          <span class="win-tog" style="display:flex;align-items:center;gap:14px;color:var(--muted)">
            {#if isPdm}<span title="Sum of the current limit of every enabled output — worst case if all switch on at their trip point">max load: <b style="color:var(--text)">{maxAmps} A</b></span>{/if}
            <span>graphs:
              <button type="button" class="linkbtn" aria-pressed={graphWin===60} onclick={()=>graphWin=60} style={graphWin===60?'color:var(--accent);font-weight:700':'color:var(--muted)'}>1 min</button> ·
              <button type="button" class="linkbtn" aria-pressed={graphWin===600} onclick={()=>graphWin=600} style={graphWin===600?'color:var(--accent);font-weight:700':'color:var(--muted)'}>10 min</button></span>
            <span class="live" style="color:var(--muted)"><span class="dot-live" style={t.connected && !t.stale ? '' : 'background:var(--faint)'}></span>{t.canRate} fps</span>
          </span>
        </div>
      {/if}

      {#if !current}
        <div class="card flat">
          <p class="muted">No device bound.</p>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">
            <input class="in" style="width:110px" bind:value={newBaseId} placeholder="0x7CE" />
            <button class="btn primary" onclick={addPdm}>+ Add dingoPDM</button>
            <button class="btn ghost" onclick={scanUsb} disabled={!t.connected || scanning} title={t.connected ? 'Scan the bus and add detected modules' : 'Connect to an adapter first to scan the bus'}>{scanning ? 'Scanning…' : '🔍 Add from USB'}</button>
            {#if t.ids.length}<span class="muted">IDs on bus:</span>
              {#each t.ids as id}<span class="idchip">{hex(id)}</span>{/each}{/if}
          </div>
        </div>
      {:else if /canboard|can.?board/i.test(current.type)}
        <SignalsView {current} ids={t.ids} mode="outputs" />
      {:else if /keypad/i.test(current.type)}
        <KeypadView device={current} {devices} />
      {:else if !isPdm}
        <DeviceTypeView device={current} />
      {:else}
        <div class="grid">
          {#each current.outputs as o (o.number)}
            {@const mode = cardMode[current.guid + ':' + o.number] ?? 'amps'}
            {@const rule = ruleText(o.input)}
            {@const wire = awgFor(o.currentLimit)}
            {@const ovr = o.wireGaugeMm2 > 0}
            {@const rating = outputRatingA($deviceDefs, current.type, o.number)}
            <div class="card" use:clickable aria-label={'Configure ' + (o.name?.trim() ? o.name : 'output ' + o.number)} onclick={() => (editNum = o.number)}>
              <div class="num">O{o.number}</div>
              <div class="top">
                <span class="state {sc(o.state)}"><span class="ic"></span>{stT(o.state)}</span>
                <span class="nm">{o.name?.trim() ? o.name : 'Output ' + o.number}</span>
                <span class="amp">{(o.current ?? 0).toFixed(1)} <span class="amp-lim">/ {o.currentLimit} A</span></span>
              </div>
              <div class="rule-txt">
                {#if rule}<span class="kw">ON when</span> <span class="sig">{rule}</span>{:else}<span class="muted">No rule set — tap edit to drive this output</span>{/if}
              </div>
              {#key mode}
                <Sparkline value={mode === 'amps' ? (o.current ?? 0) : (o.state === 'On' || o.state === 'Warning' || o.state === 'OpenLoad' ? 1 : 0)} win={graphWin}
                  tick={t.canTotal} color={o.state === 'Fault' ? '#d23b3b' : '#594ae2'} />
              {/key}
              <div class="spark-tog" role="group" aria-label="Graph mode">
                <span role="button" tabindex="0" use:clickable aria-pressed={mode === 'amps'} class:on={mode === 'amps'} onclick={(e) => { e.stopPropagation(); setMode(current.guid + ':' + o.number, 'amps') }}>Amps</span>
                <span role="button" tabindex="0" use:clickable aria-pressed={mode === 'trig'} class:on={mode === 'trig'} onclick={(e) => { e.stopPropagation(); setMode(current.guid + ':' + o.number, 'trig') }}>Trigger</span>
              </div>
              <div class="ft">
                <span class="tag">{driverTag(o.input)}</span>
                {#if rating}<span class="tag" style={(o.currentLimit ?? 0) > rating ? 'color:var(--err);border-color:var(--err)' : ''} title={`OUT${o.number} hardware channel rating is ${rating} A` + ((o.currentLimit ?? 0) > rating ? ` — your ${o.currentLimit} A trip is above it (allowed; size the wiring & load to suit)` : '')}>rated {rating} A</span>{/if}
                {#if o.enabled && ovr}<span class="tag" title={`Gauge set for this output (recommended ≥ ${wire?.mm2} mm²)`}>{awgForMm2(o.wireGaugeMm2)} AWG · {o.wireGaugeMm2} mm²</span>
                {:else if o.enabled && wire}<span class="tag" title={`Min wire for a ${o.currentLimit} A trip (short automotive run; step up for long runs)`}>≥ {wire.awg} AWG · {wire.mm2} mm²</span>{/if}
                {#if o.wireColor}<span class="tag" title={'Wire colour: ' + o.wireColor + (o.wireStripe ? ' / ' + o.wireStripe + ' stripe' : '')} style="display:inline-flex;align-items:center;gap:5px"><span style="width:11px;height:11px;border-radius:50%;border:1px solid var(--line-2);display:inline-block;background:{o.wireStripe ? `repeating-linear-gradient(135deg, ${o.wireColor} 0 3px, ${o.wireStripe} 3px 5px)` : o.wireColor}"></span>wire</span>{/if}
                {#if o.resetCount > 0}<span class="tag">{o.resetCount} resets</span>{/if}
                <span class="edit-hint" use:clickable onclick={(e) => { e.stopPropagation(); editNum = o.number }}>edit →</span>
              </div>
            </div>
          {/each}
          <div class="card add-card" use:clickable onclick={() => (editNum = current.outputs[0]?.number)}>+ configure outputs</div>
        </div>

        <div style="display:flex;gap:10px;align-items:center;margin-top:20px">
          <span class="muted">Base ID</span>
          <input class="in" style="width:100px" aria-label="Base ID" bind:value={editBaseId} />
          <button class="btn ghost" onclick={setBase}>Set</button>
          <button class="btn ghost" onclick={openModify}>Modify…</button>
          <button class="btn ghost" onclick={removeDev}>Remove</button>
        </div>
      {/if}
    {:else if view === 'dashboard'}
      <Dashboard {current} />
    {:else if view === 'system'}
      <SystemView {devices} pick={pickModule} {addModule} remove={removeByGuid} />
    {:else if view === 'signals'}
      <SignalsView {current} ids={t.ids} />
    {:else if view === 'wiring'}
      <GraphView device={current} {devices} />
    {:else if view === 'plot'}
      <PlotView {devices} />
    {:else if view === 'logs'}
      <LogsView />
    {:else if view === 'mcp'}
      <McpView />
    {/if}
  </main>

  {#if helpOpen}
    {@const h = helpFor()}
    <div class="modal-scrim show" onclick={() => (helpOpen = false)}>
      <div class="modal" use:dlg={{ onclose: () => (helpOpen = false) }} onclick={(e) => e.stopPropagation()} style="max-width:560px;padding:0 20px 16px">
        <div class="mh2" style="margin:0 -20px">❓ {h.title}</div>
        <div style="padding:8px 2px">
          {#each h.body as p}<p style="margin:0 0 10px;line-height:1.5;color:var(--ink)">{p}</p>{/each}
        </div>
        <div style="display:flex;justify-content:flex-end"><button class="btn primary" onclick={() => (helpOpen = false)}>Got it</button></div>
      </div>
    </div>
  {/if}

  {#if editNum != null && current}
    {@const eo = current.outputs.find((o) => o.number === editNum)}
    {#if eo}<OutputDrawer output={eo} guid={current.guid} connected={current.connected} deviceType={current.type} onclose={() => (editNum = null)} />{/if}
  {/if}

  {#if dialog === 'add' || dialog === 'modify'}
    <div class="modal-scrim show" onclick={() => (dialog = null)}>
      <div class="modal" use:dlg={{ onclose: () => (dialog = null) }} onclick={(e) => e.stopPropagation()}>
        <div class="mh2">{dialog === 'add' ? 'Add module' : 'Modify module'}</div>
        <div class="mb2" use:labelFields>
          <div class="field"><label>Name</label><input bind:value={dlgName} placeholder="e.g. Rear-Left" /></div>
          <div class="f2">
            <div class="field"><label>Device type</label>
              <select bind:value={dlgType} disabled={dialog === 'modify'}>
                {#each deviceTypes as [v, l]}<option value={v}>{l}</option>{/each}
              </select></div>
            <div class="field"><label>Base ID</label><input bind:value={dlgBase} /></div>
          </div>
          <div class="hint">Each module owns a CAN-ID span from its base — CANboard baseId…+10, dingoPDM baseId…+28 (incl. settings). Keep modules' spans from overlapping.</div>
        </div>
        <div class="mf2">
          <button class="btn ghost" onclick={() => (dialog = null)}>Cancel</button>
          <button class="btn primary" onclick={saveDialog}>{dialog === 'add' ? 'Create' : 'Save'}</button>
        </div>
      </div>
    </div>
  {:else if dialog === 'settings'}
    <div class="modal-scrim show" onclick={() => (dialog = null)}>
      <div class="modal" use:dlg={{ onclose: () => (dialog = null) }} onclick={(e) => e.stopPropagation()}>
        <div class="mh2">Settings</div>
        <div class="mb2">
          <div class="opts" style="margin-top:0">
            <div class="opt"><span class="sw" class:on={dark} role="switch" tabindex="0" aria-checked={dark} aria-label="Dark theme" use:clickable onclick={() => (dark = !dark)}></span> Dark theme</div>
          </div>
        </div>
        <div class="mf2"><button class="btn primary" onclick={() => (dialog = null)}>Done</button></div>
      </div>
    </div>
  {/if}

  {#if usbOpen}
    <div class="modal-scrim show" onclick={() => (usbOpen = false)}>
      <div class="modal" use:dlg={{ onclose: () => (usbOpen = false) }} onclick={(e) => e.stopPropagation()} style="min-width:480px">
        <div class="mh2">Devices on the bus</div>
        <div class="mb2">
          {#if scanning}
            <p class="muted">Scanning the bus…</p>
          {:else if usbFound.length === 0}
            <p class="muted">No modules auto-detected.
              {#if usbSeen.length === 0}<b>No CAN traffic seen</b> — check the adapter is connected, the bitrate matches, and the module is powered.{:else}Traffic is present but didn't match a known broadcast pattern — add the module by hand below using its base ID.{/if}</p>
          {:else}
            {#each usbFound as d (d.baseId)}
              <div class="field" style="flex-direction:row;align-items:center;gap:10px;border-bottom:1px solid var(--line);padding:8px 0">
                <input type="checkbox" bind:checked={d.add} disabled={d.already} aria-label={'Add ' + d.hex} />
                <div style="flex:1">
                  <div><b>{typeLabel(d.type)}</b> <span style="font-family:var(--mono);color:var(--muted)">{d.hex}</span>
                    {#if d.already}<span class="muted"> · already added</span>{:else}<span class="muted"> · detected {d.label} ({d.confidence})</span>{/if}</div>
                  <div class="muted" style="font-size:12px">{d.detail}</div>
                </div>
                <select bind:value={d.type} disabled={d.already} aria-label={'Type for ' + d.hex} style="width:160px">
                  {#each deviceTypes as [v, l]}<option value={v}>{l}</option>{/each}
                </select>
              </div>
            {/each}
            <div class="hint" style="margin-top:8px">Type is detected from the bus signature — override it here if a module is misidentified.</div>
          {/if}

          {#if !scanning && usbSeen.length}
            <div style="margin-top:14px">
              <div class="mh" style="padding-left:0">IDs seen on the bus ({usbSeen.length})</div>
              <div style="display:flex;flex-wrap:wrap;gap:5px;margin:6px 0">
                {#each usbSeen as s}<span class="idchip" title="{s.count}× · DLC {s.len}">{s.hex}</span>{/each}
              </div>
            </div>
          {/if}

          {#if !scanning}
            <div class="mh" style="padding-left:0;margin-top:10px">Add by hand</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <select bind:value={manualType} aria-label="Manual device type" style="width:150px">{#each deviceTypes as [v, l]}<option value={v}>{l}</option>{/each}</select>
              <input class="in" style="width:100px" aria-label="Manual base ID" bind:value={manualBase} placeholder="0x7CE" />
              <button class="btn ghost" onclick={addManual}>Add</button>
              <span class="hint" style="margin:0">For a dingoPDM, use its <b>base ID</b> (status frames − 2).</span>
            </div>
          {/if}
        </div>
        <div class="mf2">
          <button class="btn ghost" onclick={() => (usbOpen = false)}>Close</button>
          <button class="btn ghost" disabled={scanning} onclick={scanUsb}>Rescan</button>
          <button class="btn primary" disabled={scanning || !usbFound.some((d) => d.add && !d.already)} onclick={addScanned}>Add selected</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Non-blocking toasts (replaces alert() for write feedback) -->
  <div class="toaster" aria-live="polite" aria-atomic="false">
    {#each $toasts as t (t.id)}
      <div class="toast {t.kind}" role={t.kind === 'error' ? 'alert' : 'status'}>
        <span>{t.msg}</span>
        <button class="x" aria-label="Dismiss" onclick={() => dismiss(t.id)}>✕</button>
      </div>
    {/each}
  </div>
</div>
