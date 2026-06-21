<script>
  import { crossFns, deployCrossModule, cmfTrigId, cmfClkId, cmfIsLua, cmfSlotOf, nextCmfSlot, api } from './store.js'
  import { toast } from './toast.js'
  import { dialog, labelFields, clickable } from './a11y.js'
  import LuaEditor from './LuaEditor.svelte'
  let { devices = [], pick, addModule, remove } = $props()
  const hex = (n) => '0x' + (n ?? 0).toString(16).toUpperCase().padStart(3, '0')

  // ---- Cross-module functions (persisted; rule→native firmware wiring, lua→Lua) ----
  let fnDrawer = $state(false)
  let fnTab = $state('rule')      // 'rule' | 'lua'
  let editIdx = $state(-1)        // -1 = new
  let f = $state(blank())
  let triggerInputs = $state([])  // var-map of the selected trigger module
  let luaMod = $state('')         // which module's Lua is being edited
  let deploying = $state(false), deployMsg = $state('')

  function blank() {
    return { name: '', mode: 'rule', blink: true, blinkRateMs: 350,
      trigger: { guid: '', varIndex: null, varName: '' },
      targets: [], clockMaster: '', clockBackup: '', luaByModule: {} }
  }
  // Modules this function touches (trigger owner + clock master + targets).
  function involvedOf(fn) {
    const s = new Set()
    if (fn.trigger?.guid) s.add(fn.trigger.guid)
    if (fn.clockMaster) s.add(fn.clockMaster)
    for (const t of fn.targets ?? []) if (t.guid) s.add(t.guid)
    return [...s]
  }
  function openFn(idx = -1) {
    editIdx = idx
    f = idx >= 0 ? structuredClone($crossFns[idx]) : blank()
    if (!f.luaByModule) f.luaByModule = {}
    fnTab = 'rule'
    luaMod = involvedOf(f)[0] ?? ''
    triggerInputs = []
    if (f.trigger.guid) loadTriggerInputs(f.trigger.guid)
    fnDrawer = true
  }
  const dName2 = (g) => devices.find((d) => d.guid === g)?.name ?? g?.slice(0, 6)
  // Lua editing uses a local buffer bound to the editor (no reactive feedback loop), flushed
  // into f.luaByModule when switching module sub-tabs or saving.
  let luaBuf = $state('')
  function flushLua() { if (luaMod) f.luaByModule = { ...(f.luaByModule || {}), [luaMod]: luaBuf } }
  function openLuaTab() { luaMod = involvedOf(f)[0] ?? ''; luaBuf = f.luaByModule?.[luaMod] ?? ''; fnTab = 'lua' }
  function pickLuaMod(g) { flushLua(); luaMod = g; luaBuf = f.luaByModule?.[g] ?? '' }
  async function loadTriggerInputs(guid) {
    try { triggerInputs = await api.inputs(guid) } catch { triggerInputs = [] }
  }
  function onTriggerModule(guid) {
    f.trigger = { guid, varIndex: null, varName: '' }
    loadTriggerInputs(guid)
  }
  function addTarget() { f.targets = [...f.targets, { guid: devices[0]?.guid ?? '', output: 1 }] }
  function rmTarget(i) { f.targets = f.targets.filter((_, k) => k !== i) }
  function outputsOf(guid) { return (devices.find((d) => d.guid === guid)?.outputs ?? []) }

  function saveFn() {
    if (!f.name.trim()) return
    flushLua()   // persist the open Lua editor's buffer
    // Written in Lua → deploy as Lua; otherwise it's a native rule.
    f.mode = Object.values(f.luaByModule || {}).some((t) => t && t.trim()) ? 'lua' : 'rule'
    // capture the trigger signal's friendly name for display
    if (f.trigger.varIndex != null) {
      f.trigger.varName = triggerInputs.find((x) => x.index === Number(f.trigger.varIndex))?.name ?? ''
      f.trigger.varIndex = Number(f.trigger.varIndex)
    }
    crossFns.update((list) => {
      const next = [...list]
      if (editIdx >= 0) next[editIdx] = f
      else { if (typeof f.slot !== 'number') f.slot = nextCmfSlot(next); next.push(f) }   // stable CAN-ID slot
      return next
    })
    fnDrawer = false
  }
  // Preview the reserved CAN IDs for the function being edited (stable slot, not list position).
  let previewSlot = $derived(editIdx >= 0 ? cmfSlotOf($crossFns[editIdx], editIdx) : nextCmfSlot($crossFns))
  function delFn(idx) {
    if (!confirm('Delete this cross-module function? Re-deploy to clear it from the modules.')) return
    crossFns.update((list) => list.filter((_, k) => k !== idx))
  }
  async function deploy() {
    deploying = true; deployMsg = ''
    try {
      const res = await deployCrossModule(devices)
      const ok = res.filter((r) => r.ok), bad = res.filter((r) => !r.ok)
      deployMsg = `Deployed to ${ok.length} module(s)${bad.length ? `, ${bad.length} failed` : ''}. Burn each to keep.`
    } catch (e) { deployMsg = 'Deploy failed: ' + e.message }
    finally { deploying = false }
  }
  const dName = (g) => devices.find((d) => d.guid === g)?.name ?? '—'
  // Escape-to-close for whichever drawer is open (respects in-flight guards).
  function closeDrawer() {
    if (fnDrawer) fnDrawer = false
    else if (setDrawer && !setBusy) setDrawer = false
    else if (flashDrawer && !flashBusy) flashDrawer = false
  }

  // ---- Firmware update (in-app DFU flash) — dedicated flasher drawer ----
  let fwInput                                   // hidden <input type=file>
  let flashDrawer = $state(false)
  let flashGuid = $state(null)
  let fwFile = $state(null)
  let flashBusy = $state(false), flashLog = $state(''), flashOk = $state(null)
  let flashPct = $state(0), flashPhase = $state('')
  function openFlash(guid) { flashGuid = guid; fwFile = null; flashLog = ''; flashOk = null; flashPct = 0; flashPhase = ''; flashDrawer = true }
  function pickFile() { fwInput?.click() }
  function onFwFile(e) { fwFile = e.target.files?.[0] ?? null; e.target.value = '' }
  async function doFlash() {
    if (!fwFile || !flashGuid || flashBusy) return
    flashBusy = true; flashOk = null; flashPct = 0; flashPhase = 'Starting…'
    flashLog = `Flashing ${fwFile.name} (${(fwFile.size / 1024).toFixed(0)} KB) to ${dName(flashGuid)}… keep the module powered.`
    // poll live progress from the backend while the flash POST is in flight
    const poll = setInterval(async () => {
      try { const s = await api.flashStatus(); if (flashBusy && (s.busy || s.percent)) { flashPct = s.percent; flashPhase = s.phase } } catch {}
    }, 300)
    try {
      const r = await api.flash(flashGuid, await fwFile.arrayBuffer())
      flashBusy = false                                  // stop late poll callbacks clobbering the final state
      flashOk = r.ok; flashPct = r.ok ? 100 : flashPct; flashPhase = r.ok ? 'Done' : 'Failed'
      flashLog = (r.log || (r.ok ? 'Done.' : 'Failed.')).trimEnd()
      toast(r.ok ? `Firmware flashed to ${dName(flashGuid)}` : 'Firmware flash failed', r.ok ? 'ok' : 'error')
    } catch (err) { flashOk = false; flashPhase = 'Failed'; flashLog += '\nFlash failed: ' + err.message; toast('Flash failed: ' + err.message, 'error') }
    finally { clearInterval(poll); flashBusy = false }
  }

  // ---- Device settings (sleep) — writes config params then burns ----
  let setDrawer = $state(false), setGuid = $state(null)
  let setSleepEnabled = $state(false), setSleepTimeoutS = $state(30)
  let setInputEnabled = $state(false), setInput = $state(1), setInputSleepHigh = $state(false), setIgnoreAlwaysOn = $state(true)
  let setBusy = $state(false), setMsg = $state('')
  function openSettings(g) {
    const d = devices.find((x) => x.guid === g)
    setGuid = g; setSleepEnabled = !!d?.sleepEnabled; setSleepTimeoutS = Math.round((d?.sleepTimeoutMs ?? 30000) / 1000)
    setInputEnabled = !!d?.sleepInputEnabled; setInput = d?.sleepInput || 1
    setInputSleepHigh = !!d?.sleepInputActiveHigh; setIgnoreAlwaysOn = d?.sleepIgnoreAlwaysOn !== false
    setMsg = ''; setDrawer = true
  }
  async function saveSettings() {
    if (!setGuid || setBusy) return
    setBusy = true; setMsg = ''
    try {
      const ms = Math.min(60000, Math.max(1000, Math.round(setSleepTimeoutS * 1000)))
      const inputPin = Math.min(8, Math.max(1, setInput | 0))                  // clamp to a real 1–8 input
      await api.writeParam(setGuid, 0x0000, 2, setSleepEnabled ? 1 : 0)        // device.sleepEnabled
      await api.writeParam(setGuid, 0x0000, 5, ms)                             // device.sleepTimeoutMs
      await api.writeParam(setGuid, 0x0000, 6, setInputEnabled ? 1 : 0)        // device.sleepInputEnabled
      await api.writeParam(setGuid, 0x0000, 7, setInputEnabled ? inputPin : 0) // device.sleepInput
      await api.writeParam(setGuid, 0x0000, 8, setInputSleepHigh ? 1 : 0)      // device.sleepInputActiveHigh
      await api.writeParam(setGuid, 0x0000, 9, setIgnoreAlwaysOn ? 1 : 0)      // device.sleepIgnoreAlwaysOn
      await api.action(setGuid, 'burn')
      setMsg = 'Saved + burned.'
    } catch (e) { setMsg = 'Failed: ' + e.message }
    finally { setBusy = false }
  }

  // ---- car layout (drag pins), unchanged ----
  let pos = $state(load())
  function load() { try { return JSON.parse(localStorage.getItem('pinpos') || '{}') } catch { return {} } }
  function save() { try { localStorage.setItem('pinpos', JSON.stringify(pos)) } catch {} }
  // Spread default pins around the car so 8+ modules don't overlap or wrap onto the front-left.
  const defaults = [[25, 22], [75, 22], [25, 80], [75, 80], [50, 50], [50, 14], [50, 90], [50, 36], [25, 50], [75, 50]]
  function posOf(g, i) { return pos[g] ?? { x: defaults[i % defaults.length][0], y: defaults[i % defaults.length][1] } }
  let stage
  let drag = null
  function down(e, g) { drag = g; e.preventDefault() }
  function move(e) {
    if (!drag || !stage) return
    const r = stage.getBoundingClientRect()
    const x = Math.max(2, Math.min(98, ((e.clientX - r.left) / r.width) * 100))
    const y = Math.max(2, Math.min(98, ((e.clientY - r.top) / r.height) * 100))
    pos = { ...pos, [drag]: { x, y } }
  }
  function up() { if (drag) { save(); drag = null } }

  const onCount = (d) => (d.outputs ?? []).filter((o) => o.state === 'On').length
  const totalA = (d) => (d.outputs ?? []).reduce((a, o) => a + o.current, 0)
  // Worst-case load per module: every enabled output at its current limit.
  const maxA = (d) => (d.outputs ?? []).filter((o) => o.enabled).reduce((a, o) => a + (o.currentLimit ?? 0), 0)
  let sysMaxA = $derived(devices.reduce((a, d) => a + maxA(d), 0))
</script>

<svelte:window onpointermove={move} onpointerup={up} />

<div class="h-row">
  <div><h1>System — {devices.length} module{devices.length === 1 ? '' : 's'}</h1>
    <p class="sub">All modules on the CAN bus. Click a module to open it; drag a pin to match your install.</p></div>
  <div class="stat" style="text-align:right" title="Sum across every module of every enabled output's current limit — worst case if the whole vehicle's loads switch on at their trip point at once">
    <div class="v">{sysMaxA} A</div><div class="k">System max load</div>
  </div>
</div>

{#if devices.some((d) => !d.connected)}
  <div class="sys-alert">⚠ {devices.filter((d) => !d.connected).length} module(s) in the project not seen on the bus — check power/wiring/base ID.</div>
{/if}

<div class="cat-grp">Modules <span class="ct"></span></div>
<div class="fleet">
  {#each devices as d}
    <div class="pdm" class:err={!d.connected} use:clickable aria-label={"Open " + d.name} onclick={() => pick(d.guid)} style="position:relative">
      <button class="x" style="position:absolute;top:8px;right:8px" title="Remove module" aria-label={"Remove " + d.name} onclick={(e) => { e.stopPropagation(); remove?.(d.guid) }}>✕</button>
      <div class="pt">{d.name}</div>
      <div class="role">{d.type} · {hex(d.baseId)}</div>
      <div class="st"><span class="dot-live" style={d.connected ? '' : 'background:var(--err)'}></span>
        {d.connected ? `live · ${onCount(d)} on · ${totalA(d).toFixed(1)} A` : 'not found'}</div>
      {#if /pdm/i.test(d.type)}<div class="role" style="margin-top:2px">max load {maxA(d)} A</div>{/if}
      {#if /pdm|canboard/i.test(d.type)}
        <div style="display:flex;gap:6px;margin-top:8px">
          <button class="btn ghost" style="flex:1;font-size:12px"
            onclick={(e) => { e.stopPropagation(); openSettings(d.guid) }}>⚙ Settings</button>
          <button class="btn ghost" style="flex:1;font-size:12px" disabled={flashBusy}
            onclick={(e) => { e.stopPropagation(); openFlash(d.guid) }}>⬆ Firmware</button>
        </div>
      {/if}
    </div>
  {/each}
  <div class="pdm add-module" use:clickable onclick={addModule}>+ Add module</div>
</div>
<input type="file" accept=".bin" bind:this={fwInput} onchange={onFwFile} style="display:none" />

{#if setDrawer}
  <div class="scrim show" onclick={() => { if (!setBusy) setDrawer = false }}></div>
  <aside class="drawer show" use:dialog={{ onclose: closeDrawer }}>
    <div class="dh"><div><div class="nm">Device settings</div>
      <div class="meta">{dName(setGuid)} — sleep behaviour (written to the module + burned)</div></div>
      <button class="x" aria-label="Close" onclick={() => { if (!setBusy) setDrawer = false }}>✕</button></div>
    <div class="dbody" use:labelFields>
      <label class="chk"><input type="checkbox" bind:checked={setSleepEnabled} /> Auto-sleep enabled</label>
      <div class="field" style="max-width:240px;margin-top:12px"><label>Sleep timeout (seconds)</label>
        <input type="number" min="1" max="60" bind:value={setSleepTimeoutS} disabled={!setSleepEnabled} /></div>
      <label class="chk" style="margin-top:8px"><input type="checkbox" bind:checked={setIgnoreAlwaysOn} /> Ignore always-on outputs when sleeping</label>
      <p class="hint" style="margin-top:6px">The module sleeps after outputs are off, USB is unplugged and the CAN bus is idle
        for this long (1–60 s). Sleeping is ignored while USB is connected to avoid a soft-lock. A CAN sleep command
        waits ~2 s for the bus to settle before sleeping.</p>

      <p class="lbl" style="margin-top:16px">Sleep input</p>
      <label class="chk"><input type="checkbox" bind:checked={setInputEnabled} /> A digital input controls sleep</label>
      {#if setInputEnabled}
        <div class="f2" style="margin-top:8px">
          <div class="field"><label>Digital input #</label><input type="number" min="1" max="8" bind:value={setInput} /></div>
          <div class="field"><label>Sleep when input is</label>
            <select bind:value={setInputSleepHigh}><option value={false}>Low</option><option value={true}>High</option></select></div>
        </div>
        <p class="hint">When the input enters its sleep state the module sleeps immediately (ignoring the CAN/outputs
          checks) and only this input wakes it — no waking on other inputs or CAN. USB still wakes it for config.</p>
      {/if}
      {#if setMsg}<p class="lbl" style="margin-top:10px">{setMsg}</p>{/if}
    </div>
    <div class="dfoot"><span style="margin-left:auto"></span>
      <button class="btn ghost" disabled={setBusy} onclick={() => (setDrawer = false)}>Close</button>
      <button class="btn primary" disabled={setBusy} onclick={saveSettings}>{setBusy ? 'Saving…' : 'Save + burn'}</button></div>
  </aside>
{/if}

{#if flashDrawer}
  <div class="scrim show" onclick={() => { if (!flashBusy) flashDrawer = false }}></div>
  <aside class="drawer show" use:dialog={{ onclose: closeDrawer }}>
    <div class="dh"><div><div class="nm">Update firmware</div>
      <div class="meta">{dName(flashGuid)} — flashes over USB DFU</div></div>
      <button class="x" aria-label="Close" onclick={() => { if (!flashBusy) flashDrawer = false }}>✕</button></div>
    <div class="dbody" use:labelFields>
      <p class="lbl">Firmware file (.bin)</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn ghost" disabled={flashBusy} onclick={pickFile}>📂 Choose .bin…</button>
        {#if fwFile}<span class="muted">{fwFile.name} · {(fwFile.size / 1024).toFixed(0)} KB</span>{/if}
      </div>
      <p class="hint" style="margin-top:10px">The module is commanded into its DFU bootloader, the binary is written with
        dfu-util, then it reboots into the new firmware. <b>Keep it powered</b> (~20 s). If it can't enter DFU, hold
        <b>BOOT0</b> and reset, then flash. The ROM bootloader is always recoverable via BOOT0.</p>
      {#if flashLog}
        <p class="lbl" style="margin-top:14px">Progress
          {#if flashBusy}<span class="muted">— {flashPhase || 'working'}… {flashPct}%</span>
          {:else if flashOk === true}<span style="color:var(--ok,#3aa)">✓ done</span>
          {:else if flashOk === false}<span style="color:var(--err)">✗ failed</span>{/if}</p>
        {#if flashBusy || flashOk !== null}
          <div style="height:10px;border-radius:5px;background:var(--line);overflow:hidden;margin-bottom:8px">
            <div style="height:100%;width:{flashPct}%;background:{flashOk === false ? 'var(--err)' : 'var(--accent)'};transition:width .25s"></div>
          </div>
        {/if}
        <pre style="background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;max-height:240px;overflow:auto;white-space:pre-wrap">{flashLog}</pre>
      {/if}
    </div>
    <div class="dfoot"><span style="margin-left:auto"></span>
      <button class="btn ghost" disabled={flashBusy} onclick={() => (flashDrawer = false)}>Close</button>
      <button class="btn primary" disabled={flashBusy || !fwFile} onclick={doFlash}>{flashBusy ? 'Flashing…' : 'Flash firmware'}</button></div>
  </aside>
{/if}

<div class="cat-grp">Cross-module functions
  <span style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted)">— define once; rule = native wiring, Lua = written in Lua</span><span class="ct"></span></div>

<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px">
  {#each $crossFns as f, i}
    <div class="card" style="cursor:pointer;padding:14px" use:clickable onclick={() => openFn(i)}>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <b style="flex:1">{f.name || 'Function ' + (i + 1)}</b>
        <span class="state {cmfIsLua(f) ? 'oc' : 'on'}" style="transform:scale(.85)"><span class="ic"></span>{cmfIsLua(f) ? 'LUA' : 'NATIVE'}</span>
        <button class="x" title="Delete" aria-label="Delete function" onclick={(e) => { e.stopPropagation(); delFn(i) }}>✕</button>
      </div>
      <div class="rule-txt" style="margin:6px 0">
        <span class="kw">when</span> <span class="sig">{f.trigger?.varName || '—'}</span>
        {#if f.blink}<span class="muted"> · blink {f.blinkRateMs}ms{f.clockBackup ? ' + backup' : ''}</span>{/if}
      </div>
      <div><span class="arrow" style="color:var(--muted)">drives →</span>
        {#each f.targets ?? [] as t}<span class="tag" style="margin-left:4px">{dName(t.guid)}·O{t.output}</span>{/each}
        {#if !(f.targets ?? []).length}<span class="muted">no targets</span>{/if}</div>
      <div style="text-align:right;margin-top:8px"><span class="sig">edit →</span></div>
    </div>
  {/each}
  <div class="card add-module" style="display:flex;align-items:center;justify-content:center;min-height:120px;cursor:pointer" use:clickable onclick={() => openFn(-1)}>+ New cross-module function</div>
</div>

<div style="display:flex;gap:10px;align-items:center;margin-top:12px">
  {#if $crossFns.length}<button class="btn primary" disabled={deploying} onclick={deploy}>{deploying ? 'Deploying…' : 'Deploy to modules'}</button>{/if}
  {#if deployMsg}<span style="color:var(--muted)">{deployMsg}</span>{/if}
</div>
{#if devices.length < 2}
  <p class="hint">Tip: cross-module functions shine with 2+ modules. A <b>rule</b> compiles to native CAN-input/flasher/output
    wiring (no Lua); switch to <b>Lua</b> to write it yourself — needed for backup-clock failover.</p>
{/if}

{#if fnDrawer}
  <div class="scrim show" onclick={() => (fnDrawer = false)}></div>
  <aside class="drawer show" use:dialog={{ onclose: closeDrawer }}>
    <div class="dh"><div><div class="nm">{f.name?.trim() ? f.name : (editIdx >= 0 ? 'Cross-module function' : 'New cross-module function')}</div>
      <div class="meta">{cmfIsLua(f) ? 'Written in Lua — deploys Lua' : 'Rule — compiles to native firmware wiring'}</div></div>
      <button class="x" aria-label="Close" onclick={() => (fnDrawer = false)}>✕</button></div>

    <div class="tabs">
      <span class="t" role="tab" tabindex="0" aria-selected={fnTab === 'rule'} use:clickable class:active={fnTab === 'rule'} onclick={() => (fnTab = 'rule')}>Rule</span>
      <span class="t" role="tab" tabindex="0" aria-selected={fnTab === 'lua'} use:clickable class:active={fnTab === 'lua'} onclick={openLuaTab}>Lua</span>
    </div>

    {#if fnTab === 'rule'}
    <div class="dbody" use:labelFields>
      <div class="field"><label>Name</label><input bind:value={f.name} placeholder="e.g. Left Blinker" /></div>

      <p class="lbl">Trigger</p>
      <div class="f2">
        <div class="field"><label>Module</label>
          <select value={f.trigger.guid} onchange={(e) => onTriggerModule(e.target.value)}>
            <option value="">—</option>
            {#each devices as d}<option value={d.guid}>{d.name}</option>{/each}
          </select></div>
        <div class="field"><label>Signal</label>
          <select bind:value={f.trigger.varIndex} disabled={!f.trigger.guid}>
            <option value={null}>—</option>
            {#each triggerInputs as s}<option value={s.index}>{s.name}</option>{/each}
          </select></div>
      </div>

      <p class="lbl" style="margin-top:14px">Target outputs</p>
      {#each f.targets as t, i}
        <div class="f2" style="align-items:end">
          <div class="field"><label>Module</label>
            <select bind:value={t.guid}>{#each devices as d}<option value={d.guid}>{d.name}</option>{/each}</select></div>
          <div class="field"><label>Output</label>
            <select bind:value={t.output}>{#each outputsOf(t.guid) as o}<option value={o.number}>O{o.number} {o.name?.trim() ? o.name : ''}</option>{/each}</select></div>
          <button class="x" title="Remove" onclick={() => rmTarget(i)}>✕</button>
        </div>
      {/each}
      <button class="addbtn" style="margin-top:4px" onclick={addTarget}>+ Add target output</button>

      <p class="lbl" style="margin-top:16px">Synchronised blink</p>
      <label class="chk"><input type="checkbox" bind:checked={f.blink} /> Blink — outputs flash in lock-step with a shared clock</label>
      {#if f.blink}
        <div class="f2">
          <div class="field"><label>Clock master</label>
            <select bind:value={f.clockMaster}>
              <option value="">trigger module</option>
              {#each devices as d}<option value={d.guid}>{d.name}</option>{/each}
            </select></div>
          <div class="field"><label>Backup master (failover)</label>
            <select bind:value={f.clockBackup}>
              <option value="">none (native)</option>
              {#each devices as d}<option value={d.guid}>{d.name}</option>{/each}
            </select></div>
        </div>
        <div class="field" style="max-width:230px"><label>Half-period (ms)</label><input type="number" bind:value={f.blinkRateMs} /></div>
        <p class="hint">Native: the master runs a trigger-gated flasher and broadcasts the lamp state; targets follow it.
          Picking a <b>backup master</b> needs failover arbitration native CAN can't do — that switches this function to
          <b>Lua</b> (the Lua tab). CAN IDs 0x{cmfTrigId(previewSlot).toString(16)}/0x{cmfClkId(previewSlot).toString(16)} are auto-assigned.</p>
      {/if}
    </div>
    {:else}
    <div class="dbody" use:labelFields>
      <p class="lbl">Write this function in Lua (per module)</p>
      {#if involvedOf(f).length === 0}
        <p class="muted">Add a trigger + targets on the Rule tab first, so there are modules to write Lua for.</p>
      {:else}
        <div class="tabs" style="margin-bottom:10px">
          {#each involvedOf(f) as g}<span class="t" role="tab" tabindex="0" aria-selected={luaMod === g} use:clickable class:active={luaMod === g} onclick={() => pickLuaMod(g)}>{dName2(g)}</span>{/each}
        </div>
        {#key luaMod}
          <LuaEditor bind:value={luaBuf} minHeight={220}
            placeholder={`-- Lua for ${dName2(luaMod)} (this module).\n-- Use txCan(1, id, false, {data}) / canRxAdd(id) / onCanRx / readVar / setLuaOut.\n-- See the templates: "Blinker synced to a master clock (CAN)".`} />
        {/key}
        <p class="hint">Writing Lua here makes this function deploy as <b>Lua</b> (not native). Each module gets its own
          block. For synced blinkers with failover, use the <b>Blinker synced to a master clock</b> template and the
          CAN IDs 0x{cmfTrigId(previewSlot).toString(16)}/0x{cmfClkId(previewSlot).toString(16)}.</p>
      {/if}
    </div>
    {/if}

    <div class="dfoot"><span style="margin-left:auto"></span>
      <button class="btn ghost" onclick={() => (fnDrawer = false)}>Cancel</button>
      <button class="btn primary" onclick={saveFn}>{editIdx >= 0 ? 'Save' : 'Add'} function</button></div>
  </aside>
{/if}

<div class="cat-grp">Car layout <span class="ct"></span></div>
<div class="carmap" style="background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px">
  <div class="carstage" bind:this={stage} style="position:relative;width:100%;max-width:420px;margin:0 auto;aspect-ratio:5/7">
    <svg viewBox="0 0 200 280" preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block">
      <rect x="5" y="55" width="16" height="44" rx="7" fill="var(--car-wheel)"/><rect x="179" y="55" width="16" height="44" rx="7" fill="var(--car-wheel)"/>
      <rect x="5" y="188" width="16" height="44" rx="7" fill="var(--car-wheel)"/><rect x="179" y="188" width="16" height="44" rx="7" fill="var(--car-wheel)"/>
      <rect x="24" y="14" width="152" height="252" rx="48" fill="var(--car-body)" stroke="var(--car-stroke)" stroke-width="2"/>
      <path d="M58 72 L142 72 L128 108 L72 108 Z" fill="var(--car-glass)"/><rect x="66" y="108" width="68" height="66" rx="12" fill="var(--car-glass2)"/>
      <path d="M72 174 L128 174 L142 210 L58 210 Z" fill="var(--car-glass)"/>
      <rect x="42" y="20" width="22" height="9" rx="4" fill="#f4d35e"/><rect x="136" y="20" width="22" height="9" rx="4" fill="#f4d35e"/>
      <rect x="42" y="252" width="22" height="8" rx="4" fill="#e07a5f"/><rect x="136" y="252" width="22" height="8" rx="4" fill="#e07a5f"/>
      <text x="100" y="48" text-anchor="middle" font-size="8" fill="var(--faint)">FRONT</text>
      <text x="100" y="246" text-anchor="middle" font-size="8" fill="var(--faint)">REAR</text>
    </svg>
    {#each devices as d, i}
      {@const p = posOf(d.guid, i)}
      <div class="pin pdm" class:err={!d.connected} style="position:absolute;left:{p.x}%;top:{p.y}%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:7px;cursor:grab;z-index:2"
        onpointerdown={(e) => down(e, d.guid)} ondblclick={() => pick(d.guid)}>
        <span class="marker" style="width:17px;height:17px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);background:{d.connected ? 'var(--accent)' : 'var(--err)'}"></span>
        <span class="plabel" style="background:var(--surface);color:var(--ink);border:1px solid var(--line-2);border-radius:8px;padding:3px 9px;font-size:11px;font-weight:700;white-space:nowrap">{d.name}<span style="font-family:var(--mono);color:var(--muted);font-weight:500;margin-left:5px">{hex(d.baseId)}</span></span>
      </div>
    {/each}
  </div>
  <div class="maphint" style="font-size:12px;color:var(--muted);text-align:center;margin-top:10px">Drag a pin to where the module sits · double-click to open it.</div>
</div>
