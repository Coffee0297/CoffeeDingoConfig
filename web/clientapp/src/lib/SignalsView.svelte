<script>
  import { api, luaGet, luaSet, luaAssemble, luaReadToTabs, luaSnippets } from './store.js'
  import { toast } from './toast.js'
  import { dialog, labelFields, clickable } from './a11y.js'
  import LuaEditor from './LuaEditor.svelte'
  import Sparkline from './Sparkline.svelte'
  let { current, ids = [] } = $props()
  // Writes/uploads only reach hardware when the module is live on the bus; config edits still
  // persist to the project offline. Read-backs (Lua read, error check) need a live module.
  let live = $derived(!!current?.connected)

  // ---- Live values for per-function mini charts (#17) ----
  let liveByName = $state({})   // name -> { value:number, on:bool }
  let liveTick = $state(0)
  $effect(() => {
    const g = current?.guid
    if (!g) { liveByName = {}; return }
    let alive = true
    const load = async () => {
      try {
        const sigs = await api.signals(g)
        if (!alive) return
        const m = {}
        for (const s of sigs) { const n = parseFloat(s.value); m[s.name] = { value: Number.isFinite(n) ? n : (s.on ? 1 : 0), on: s.on } }
        liveByName = m; liveTick++
      } catch {}
    }
    load(); const id = setInterval(load, 400)
    return () => { alive = false; clearInterval(id) }
  })

  // Config arrays (editable). Reloaded on device change + after every save.
  let funcs = $state(null)
  let inputsBool = $state([])   // bool-typed VarMap entries (edges, on/off sources)
  let inputsAll = $state([])    // every VarMap entry (values to compare / send)

  let loadErr = $state('')
  async function reload() {
    const g = current?.guid
    if (!g) { funcs = null; return }
    try {
      funcs = await api.functions(g)
      inputsBool = await api.inputs(g, 'bool')
      inputsAll = await api.inputs(g)
      loadErr = ''
    } catch (e) { loadErr = 'Could not load this module’s signals — ' + e.message }
  }
  $effect(() => { current?.guid; reload() })

  const hex = (n) => '0x' + (n ?? 0).toString(16).toUpperCase()
  const opTxt = ['=', '≠', '>', '<', '≥', '≤', '&', '!&']
  const condTxt = ['AND', 'OR', 'NOR']

  // Every editable kind. `arr` is its key on /functions; only kinds whose array is present
  // for the current device render. `physical` kinds are fixed channels (show all, no wizard).
  const ALLKINDS = [
    { key: 'caninput', arr: 'canInputs', icon: '📡', label: 'CAN input', tile: 'CAN message', desc: 'value or bit from an incoming frame', addable: true },
    { key: 'input', arr: 'inputs', icon: '🔌', label: 'Digital pin', tile: 'Digital pin', desc: 'a physical input pin', addable: true },
    { key: 'condition', arr: 'conditions', icon: '🔢', label: 'Condition', tile: 'Comparison', desc: 'true when a signal crosses a value', addable: true },
    { key: 'virtualinput', arr: 'virtualInputs', icon: '🧩', label: 'Virtual input', tile: 'Combination', desc: 'AND/OR up to 3 signals', addable: true },
    { key: 'flasher', arr: 'flashers', icon: '💡', label: 'Flasher', tile: 'Flasher', desc: 'a blink pattern', addable: true },
    { key: 'counter', arr: 'counters', icon: '⏱', label: 'Counter', tile: 'Counter', desc: 'count events', addable: true },
    { key: 'canoutput', arr: 'canOutputs', icon: '📤', label: 'CAN output', tile: 'CAN output', desc: 'transmit a variable on CAN', addable: true },
    // CANBoard physical I/O — fixed channels, configured in place
    { key: 'analoginput', arr: 'analogIn', icon: '🎚', label: 'Analog input', physical: true },
    { key: 'input', arr: 'digitalIn', icon: '🔌', label: 'Digital input', physical: true },
    { key: 'digitaloutput', arr: 'digitalOut', icon: '⭘', label: 'Digital output', physical: true },
  ]
  let KINDS = $derived(funcs ? ALLKINDS.filter((k) => funcs[k.arr] !== undefined) : [])
  const meta = (k) => ALLKINDS.find((x) => x.key === k)
  const labelFor = (k) => meta(k)?.label ?? (k === 'keypad' ? 'Keypad' : k === 'keypadbutton' ? 'Button' : k)
  const list = (kd) => funcs?.[kd.arr] ?? []
  const rowsFor = (kd) => kd.physical ? list(kd) : list(kd).filter((x) => x.enabled)
  const varName = (idx) => inputsAll.find((v) => v.index === idx)?.name ?? (idx ? `#${idx}` : '—')

  // ---- editor drawer ----
  let drawer = $state(false)
  let editing = $state(null)   // { kind, number, isNew }
  let f = $state({})
  let idHex = $state('0x100')
  let saving = $state(false)

  function openNew(kd) {
    const slot = list(kd).find((x) => !x.enabled)
    if (!slot) { toast(`All ${kd.label.toLowerCase()} slots are in use.`, 'error'); return }
    seed(kd.key, slot, true)
  }
  function openEdit(kd, row) { seed(kd.key, row, false) }
  function seed(kind, row, isNew) {
    editing = { kind, number: row.number ?? 1, isNew }
    f = { ...row, enabled: isNew ? true : row.enabled }
    idHex = hex(row.id ?? 0x100)
    drawer = true
  }
  function close() { drawer = false; editing = null }

  async function save() {
    if (!current || !editing) return
    const body = { ...f }
    // Only CAN kinds carry a hex frame id; keypad master's id is a plain decimal node id.
    if (editing.kind === 'caninput' || editing.kind === 'canoutput') {
      const id = parseInt(String(idHex).replace(/^0x/i, ''), 16)
      if (!Number.isInteger(id) || id < 0) { toast(`"${idHex}" is not a valid CAN ID (use hex, e.g. 0x18F).`, 'error'); return }
      const max = f.ide ? 0x1FFFFFFF : 0x7FF
      if (id > max) { toast(`CAN ID 0x${id.toString(16).toUpperCase()} exceeds the ${f.ide ? '29' : '11'}-bit max (0x${max.toString(16).toUpperCase()}). ${id > 0x7FF ? 'Set Frame = Extended.' : ''}`, 'error'); return }
      body.id = id
    }
    saving = true
    try {
      const r = await api.setFunction(current.guid, editing.kind, editing.number, body)
      await reload()
      toast(r?.written
        ? `Saved ${labelFor(editing.kind)} ${editing.number} to device`
        : `Saved ${labelFor(editing.kind)} ${editing.number} to the project — module offline; Deploy when connected`, r?.written ? 'ok' : 'info')
      close()
    } catch (e) { toast('Save failed: ' + e.message, 'error') }
    finally { saving = false }
  }
  async function remove(kind, row) {
    if (!current) return
    try { await api.setFunction(current.guid, kind, row.number, { ...row, enabled: false }); await reload() }
    catch (e) { toast(e.message, 'error') }
  }

  // ---- Lua: global/shared section (per-output snippets live in each output's
  // Lua tab). Upload assembles global + all output snippets into one program. ----
  let luaOpen = $state(false)
  let luaSrc = $state('')
  let luaSeededFor = $state(null)
  $effect(() => {
    const g = current?.guid
    if (g && g !== luaSeededFor) {
      luaSrc = luaGet(g, 'global') ||
        '-- Shared/global Lua. Runs on the device.\n' +
        '-- API: readVar(i) setLuaOut(slot,v) | txCan(bus,id,ext,{bytes}) canRxAdd(id)\n' +
        '--      onCanRx(bus,id,dlc,data) onTick() setTickRate(hz) Timer.new()\n' +
        '-- Per-output logic goes in each output’s Lua tab.\n\n' +
        'setTickRate(50)\n'
      luaSeededFor = g
    }
  })
  let luaBusy = $state(false), luaMsg = $state(''), luaTab = $state('global')
  // persist global edits + a reactive read-only view of the full assembled program
  $effect(() => { if (current && luaSeededFor === current.guid) luaSet(current.guid, 'global', luaSrc) })
  let assembled = $derived.by(() => { $luaSnippets; return current ? luaAssemble(current.guid) : '' })

  // per-function Lua snippet (shown in the function editor drawer)
  let fnLua = $state(''), fnLuaSeeded = $state(null)
  $effect(() => {
    if (editing && current) {
      const k = editing.kind + editing.number
      if (k !== fnLuaSeeded) { fnLua = luaGet(current.guid, k); fnLuaSeeded = k }
    } else { fnLuaSeeded = null }
  })
  $effect(() => { if (editing && current && (editing.kind + editing.number) === fnLuaSeeded) luaSet(current.guid, fnLuaSeeded, fnLua) })
  async function uploadLua() {
    if (!current) return
    luaSet(current.guid, 'global', luaSrc)
    luaBusy = true; luaMsg = ''
    try {
      await api.luaUpload(current.guid, luaAssemble(current.guid))
      luaMsg = 'Uploaded ✓ — Burn to keep across reboot'
      luaDevErr = ''
      setTimeout(checkLuaError, 1000)   // let it run a couple ticks, then pull any runtime error
    }
    catch (e) { luaMsg = 'Upload failed: ' + e.message }
    finally { luaBusy = false }
  }
  async function readLua() {
    if (!current) return
    luaBusy = true; luaMsg = ''
    try {
      await luaReadToTabs(current.guid)
      luaSrc = luaGet(current.guid, 'global'); luaSeededFor = current.guid
      luaMsg = 'Read from device ✓ — split onto output tabs'
    } catch (e) { luaMsg = 'Read failed: ' + e.message }
    finally { luaBusy = false }
  }
  let luaDevErr = $state('')
  async function checkLuaError() {
    if (!current) return
    try { const r = await api.luaError(current.guid); luaDevErr = (r.error || '').trim() }
    catch (e) { luaDevErr = ''; luaMsg = 'Could not read the device error state (no response) — a failed read is not proof the Lua is healthy.' }
  }

  // ---- keypad config (PDM keypad masters: buttons → LED colour / drives) ----
  const COLORS = ['Off', 'Red', 'Green', 'Orange', 'Blue', 'Violet', 'Cyan', 'White']
  const swatch = ['#37474f', '#d32f2f', '#2e7d32', '#ff9800', '#1565c0', '#7e57c2', '#26c6da', '#eceff1']
  const MODELS = [[6, 'Blink 12-key'], [7, 'Blink 15-key'], [4, 'Blink 8-key'], [3, 'Blink 6-key'], [22, 'Grayhill 12-key'], [24, 'Grayhill 20-key']]
  const keypads = () => funcs?.keypads ?? []

  function openKeypad(ki) {
    const m = keypads()[ki]
    editing = { kind: 'keypad', number: ki + 1, isNew: false }
    f = { ...m, enabled: m.enabled }
    drawer = true
  }
  function openButton(ki, b, isNew) {
    editing = { kind: 'keypadbutton', number: ki * 32 + b.number, isNew }
    f = JSON.parse(JSON.stringify({ ...b, enabled: true }))   // deep copy so array edits don't touch live state
    drawer = true
  }
  function addButton(ki) {
    const b = keypads()[ki].buttons.find((x) => !x.enabled)
    if (!b) { toast('All buttons on this keypad are in use.', 'error'); return }
    openButton(ki, b, true)
  }
</script>

<div class="h-row">
  <div><h1>{current ? current.name : '—'} · Signals &amp; logic</h1>
    <p class="sub">The device's inputs and logic blocks — physical pins, CAN messages, and logic built from them. Edit a row or define a new one; Save writes to the device, Burn persists.</p></div>
  <button class="btn primary" disabled={!current} onclick={() => { editing = null; drawer = true }}>+ Define new signal</button>
</div>

{#if !current}
  <div class="card flat"><p class="muted">No device bound.</p></div>
{:else if !funcs}
  <div class="card flat"><p class="muted">Loading…</p></div>
{:else}
  {#if loadErr}<div class="sys-alert">⚠ {loadErr}</div>{/if}
  <div class="cat-grp">⚡ Lua program
    <span style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted)">— global/shared section · per-output logic is in each output’s Lua tab</span>
    <span class="ct"></span>
    <button class="btn ghost" style="margin-left:8px;padding:2px 8px;font-size:12px" onclick={() => (luaOpen = !luaOpen)}>{luaOpen ? 'hide' : 'edit'}</button></div>
  {#if luaOpen}
    <div class="card" style="cursor:default;padding:14px">
      <div class="tabs" role="tablist" style="margin-bottom:10px">
        <span class="t" role="tab" tabindex="0" aria-selected={luaTab === 'global'} use:clickable class:active={luaTab === 'global'} onclick={() => (luaTab = 'global')}>Global (shared)</span>
        <span class="t" role="tab" tabindex="0" aria-selected={luaTab === 'program'} use:clickable class:active={luaTab === 'program'} onclick={() => (luaTab = 'program')}>Full program (read-only)</span>
      </div>
      {#if luaTab === 'global'}
        <LuaEditor bind:value={luaSrc} minHeight={220} />
      {:else}
        <textarea readonly value={assembled} spellcheck="false"
          style="width:100%;min-height:260px;font-family:var(--mono);font-size:12px;line-height:1.5;border:1px solid var(--line-2);border-radius:8px;padding:10px;resize:vertical;background:var(--surface-2,#f6f6fa);color:var(--ink)"></textarea>
        <p class="hint">This is the assembled program (global + every function snippet) that gets
          uploaded. Edit the pieces in the Global tab and each function's Lua tab — not here.</p>
      {/if}
      <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
        <button class="btn primary" disabled={luaBusy || !live} title={live ? '' : 'Connect the module to upload Lua'} onclick={uploadLua}>{luaBusy ? 'Uploading…' : 'Upload to device'}</button>
        <button class="btn ghost" disabled={luaBusy || !live} title={live ? '' : 'Connect the module to read its Lua'} onclick={readLua}>Read from device</button>
        <button class="btn ghost" disabled={luaBusy || !live} title={live ? '' : 'Connect the module to read its error state'} onclick={checkLuaError}>Check error</button>
        {#if luaMsg}<span class="muted">{luaMsg}</span>{:else if !live}<span class="muted" style="font-size:12px">Module offline — Lua is saved locally; connect to upload.</span>{/if}
      </div>
      {#if luaDevErr}
        <div class="sys-alert" style="margin-top:8px">⚠ Device Lua error: <span style="font-family:var(--mono)">{luaDevErr}</span></div>
      {/if}
      <p class="hint">Drive any output / virtual input / CAN output by setting its input to a
        <b>Lua slot</b> and writing it with <code>setLuaOut(n, v)</code>. Upload sends the program
        now; press <b>Burn</b> to keep it across reboot.</p>
    </div>
  {/if}

  {#each KINDS as k}
    {@const rows = rowsFor(k)}
    {@const used = list(k).filter((x) => x.enabled).length}
    <div class="cat-grp">{k.icon} {k.label}s <span style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted)">— {used} / {list(k).length} {k.physical ? 'enabled' : 'used'}</span><span class="ct"></span></div>
    {#each rows as s (k.key + ":" + s.number)}
      <div class="sig-row" style="cursor:pointer" use:clickable onclick={() => openEdit(k, s)}>
        <span class="ico">{k.icon}</span>
        <div style="flex:1">
          <div class="nm2">{s.name} {#if k.physical && !s.enabled}<span class="muted" style="font-weight:400">(disabled)</span>{/if}</div>
          <div class="def">
            {#if k.key === 'caninput'}{hex(s.id)} · bit {s.startBit}+{s.bitLength}{#if s.factor !== 1} · ×{s.factor}{/if}
            {:else if k.key === 'condition'}{varName(s.input)} {opTxt[s.operator]} {s.arg}
            {:else if k.key === 'virtualinput'}{s.not0 ? '!' : ''}{varName(s.var0)} {condTxt[s.cond0]} {s.not1 ? '!' : ''}{varName(s.var1)}
            {:else if k.key === 'flasher'}{s.onTime}ms on / {s.offTime}ms off
            {:else if k.key === 'counter'}+{varName(s.incInput)} · max {s.maxCount}
            {:else if k.key === 'canoutput'}send {varName(s.input)} → {hex(s.id)} every {s.interval}ms
            {:else if k.key === 'digitaloutput'}driven by {varName(s.input)}
            {:else if k.key === 'input'}{s.mode === 1 ? 'latched' : 'momentary'}{s.invert ? ' · inverted' : ''}
            {:else}{k.label}{/if}
          </div>
        </div>
        {#if liveByName[s.name]}
          <div class="minichart" onclick={(e) => e.stopPropagation()} title="live ({liveByName[s.name].value})">
            <Sparkline value={liveByName[s.name].value} tick={liveTick} win={30} color={['caninput', 'condition', 'counter'].includes(k.key) ? '#594ae2' : '#2a9d8f'} />
          </div>
        {/if}
        {#if !k.physical}<button class="rm" title="Disable" onclick={(e) => { e.stopPropagation(); remove(k.key, s) }}>✕</button>{/if}
      </div>
    {/each}
    {#if rows.length === 0}<div class="sig-row muted"><span class="ico">{k.icon}</span><div class="def">None defined</div></div>{/if}
  {/each}

  {#each keypads() as m, ki}
    <div class="cat-grp">🎛 Keypad {m.number}
      <span style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted)">— {m.enabled ? 'enabled' : 'disabled'}</span>
      <span class="ct"></span>
      <button class="btn ghost" style="margin-left:8px;padding:2px 8px;font-size:12px" onclick={() => openKeypad(ki)}>settings</button></div>
    {#if m.enabled}
      {#each m.buttons.filter((b) => b.enabled) as b (b.number)}
        <div class="sig-row" style="cursor:pointer" use:clickable onclick={() => openButton(ki, b, false)}>
          <span class="ico">🔘</span>
          <div style="flex:1"><div class="nm2">{b.name}</div>
            <div class="def">{b.mode === 1 ? 'latched' : 'momentary'} · LED <span style="display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;background:{swatch[b.valColors?.[0] ?? 0]}"></span> {COLORS[b.valColors?.[0] ?? 0]} shows {varName(b.valVars?.[0])}</div></div>
          <button class="rm" title="Disable" onclick={(e) => { e.stopPropagation(); remove('keypadbutton', { ...b, number: ki * 32 + b.number }) }}>✕</button>
        </div>
      {/each}
      <button class="addbtn" onclick={() => addButton(ki)}>+ configure a button</button>
    {/if}
  {/each}
{/if}

{#if drawer}
  <div class="scrim show" onclick={close}></div>
  <aside class="drawer show" use:dialog={{ onclose: close }}>
    <div class="dh"><div>
      <div class="nm">{editing ? (editing.isNew ? 'New ' : 'Edit ') + labelFor(editing.kind) : 'Define a signal'}</div>
      <div class="meta">{editing ? `slot ${editing.number}` : 'Pick a source, then describe it'}</div></div>
      <button class="x" onclick={close}>✕</button></div>
    <div class="dbody" use:labelFields>
      {#if !editing}
        <p class="lbl">Source</p>
        <div class="tiles">
          {#each KINDS.filter((k) => k.addable) as k}
            <div class="tile" use:clickable onclick={() => openNew(k)}>
              <div class="ti">{k.icon}</div><div class="tt">{k.tile}</div><div class="td">{k.desc}</div>
            </div>
          {/each}
        </div>
      {:else if editing.kind === 'caninput'}
        <div class="field"><label>Name</label><input bind:value={f.name} placeholder="e.g. Engine RPM" /></div>
        <p class="lbl">IDs seen on the bus</p>
        <div class="bus"><div class="bh"><span class="pulse" style="background:var(--ok);border-radius:50%"></span> live</div>
          <div class="scroll">
            {#each ids as id}<div class="r" style="cursor:pointer" use:clickable onclick={() => (idHex = hex(id))}><span class="id">{hex(id)}</span><span class="dat">use</span></div>{/each}
            {#if ids.length === 0}<div class="r"><span class="dat">No CAN traffic</span></div>{/if}
          </div></div>
        <div class="f2">
          <div class="field"><label>CAN ID</label><input bind:value={idHex} /></div>
          <div class="field"><label>Frame</label><select bind:value={f.ide}><option value={false}>Standard (11-bit)</option><option value={true}>Extended (29-bit)</option></select></div>
        </div>
        <div class="f3">
          <div class="field"><label>Start bit</label><input type="number" bind:value={f.startBit} /></div>
          <div class="field"><label>Length</label><input type="number" bind:value={f.bitLength} /></div>
          <div class="field"><label>Byte order</label><select bind:value={f.byteOrder}><option value={0}>Little-endian</option><option value={1}>Big-endian</option></select></div>
        </div>
        <div class="f3">
          <div class="field"><label>Factor</label><input type="number" step="any" bind:value={f.factor} /></div>
          <div class="field"><label>Offset</label><input type="number" step="any" bind:value={f.offset} /></div>
          <div class="field"><label>Signed</label><select bind:value={f.signed}><option value={false}>No</option><option value={true}>Yes</option></select></div>
        </div>
      {:else if editing.kind === 'input'}
        <label class="opt" style="border:0;padding-top:0"><input type="checkbox" bind:checked={f.enabled} /> Input enabled</label>
        <div class="field"><label>Name</label><input bind:value={f.name} /></div>
        <div class="f2">
          <div class="field"><label>Mode</label><select bind:value={f.mode}><option value={0}>Momentary</option><option value={1}>Latched</option></select></div>
          <div class="field"><label>Pull resistor</label><select bind:value={f.pull}><option value={0}>None</option><option value={1}>Pull-up</option><option value={2}>Pull-down</option></select></div>
        </div>
        <div class="field" style="max-width:230px"><label>Debounce (ms)</label><input type="number" bind:value={f.debounceTime} /></div>
        <label class="chk"><input type="checkbox" bind:checked={f.invert} /> Invert (treat low as "on")</label>
      {:else if editing.kind === 'condition'}
        <div class="field"><label>Name</label><input bind:value={f.name} /></div>
        <div class="field"><label>Signal</label>
          <select bind:value={f.input}>{#each inputsAll as v}<option value={v.index}>{v.name}</option>{/each}</select></div>
        <div class="f2">
          <div class="field"><label>Operator</label>
            <select bind:value={f.operator}>{#each opTxt as o, i}<option value={i}>{o}</option>{/each}</select></div>
          <div class="field"><label>Value</label><input type="number" step="any" bind:value={f.arg} /></div>
        </div>
      {:else if editing.kind === 'virtualinput'}
        <div class="field"><label>Name</label><input bind:value={f.name} /></div>
        <div class="field"><label>Mode</label><select bind:value={f.mode}><option value={0}>Momentary</option><option value={1}>Latched</option></select></div>
        {#each [0, 1, 2] as i}
          <div class="f3" style="align-items:end">
            <label class="chk"><input type="checkbox" bind:checked={f['not' + i]} /> NOT</label>
            <div class="field"><label>Signal {i + 1}</label>
              <select bind:value={f['var' + i]}><option value={0}>—</option>{#each inputsBool as v}<option value={v.index}>{v.name}</option>{/each}</select></div>
            {#if i < 2}<div class="field"><label>Join</label><select bind:value={f['cond' + i]}>{#each condTxt as c, ci}<option value={ci}>{c}</option>{/each}</select></div>{:else}<div></div>{/if}
          </div>
        {/each}
      {:else if editing.kind === 'flasher'}
        <div class="field"><label>Name</label><input bind:value={f.name} /></div>
        <div class="field"><label>Driven by</label>
          <select bind:value={f.input}><option value={0}>—</option>{#each inputsBool as v}<option value={v.index}>{v.name}</option>{/each}</select></div>
        <div class="f2">
          <div class="field"><label>On time (ms)</label><input type="number" bind:value={f.onTime} /></div>
          <div class="field"><label>Off time (ms)</label><input type="number" bind:value={f.offTime} /></div>
        </div>
        <label class="chk"><input type="checkbox" bind:checked={f.single} /> Single shot (one blink per trigger)</label>
      {:else if editing.kind === 'counter'}
        <div class="field"><label>Name</label><input bind:value={f.name} /></div>
        <div class="f3">
          <div class="field"><label>Count up on</label><select bind:value={f.incInput}><option value={0}>—</option>{#each inputsBool as v}<option value={v.index}>{v.name}</option>{/each}</select></div>
          <div class="field"><label>Count down on</label><select bind:value={f.decInput}><option value={0}>—</option>{#each inputsBool as v}<option value={v.index}>{v.name}</option>{/each}</select></div>
          <div class="field"><label>Reset on</label><select bind:value={f.resetInput}><option value={0}>—</option>{#each inputsBool as v}<option value={v.index}>{v.name}</option>{/each}</select></div>
        </div>
        <div class="f3">
          <div class="field"><label>Min</label><input type="number" bind:value={f.minCount} /></div>
          <div class="field"><label>Max</label><input type="number" bind:value={f.maxCount} /></div>
          <label class="chk" style="align-self:end"><input type="checkbox" bind:checked={f.wrapAround} /> Wrap</label>
        </div>
      {:else if editing.kind === 'canoutput'}
        <div class="field"><label>Name</label><input bind:value={f.name} /></div>
        <div class="field"><label>Variable to send</label>
          <select bind:value={f.input}>{#each inputsAll as v}<option value={v.index}>{v.name}</option>{/each}</select></div>
        <div class="f2">
          <div class="field"><label>CAN ID</label><input bind:value={idHex} /></div>
          <div class="field"><label>Frame</label><select bind:value={f.ide}><option value={false}>Standard</option><option value={true}>Extended</option></select></div>
        </div>
        <div class="f3">
          <div class="field"><label>Start bit</label><input type="number" bind:value={f.startBit} /></div>
          <div class="field"><label>Length</label><input type="number" bind:value={f.bitLength} /></div>
          <div class="field"><label>Byte order</label><select bind:value={f.byteOrder}><option value={0}>Little-endian</option><option value={1}>Big-endian</option></select></div>
        </div>
        <div class="f3">
          <div class="field"><label>Factor</label><input type="number" step="any" bind:value={f.factor} /></div>
          <div class="field"><label>Offset</label><input type="number" step="any" bind:value={f.offset} /></div>
          <div class="field"><label>Interval (ms)</label><input type="number" bind:value={f.interval} /></div>
        </div>
      {:else if editing.kind === 'digitaloutput'}
        <label class="opt" style="border:0;padding-top:0"><input type="checkbox" bind:checked={f.enabled} /> Output enabled</label>
        <div class="field"><label>Name</label><input bind:value={f.name} /></div>
        <div class="field"><label>Driven by</label>
          <select bind:value={f.input}><option value={0}>—</option>{#each inputsBool as v}<option value={v.index}>{v.name}</option>{/each}</select></div>
      {:else if editing.kind === 'analoginput'}
        <label class="opt" style="border:0;padding-top:0"><input type="checkbox" bind:checked={f.enabled} /> Input enabled</label>
        <div class="field"><label>Name</label><input bind:value={f.name} /></div>
        <p class="hint">Analog channel. Use a Condition to turn its value into an on/off signal, or read it on CAN via a CAN output.</p>
      {:else if editing.kind === 'keypad'}
        <label class="opt" style="border:0;padding-top:0"><input type="checkbox" bind:checked={f.enabled} /> Keypad enabled <span class="desc">this PDM drives the keypad's LEDs</span></label>
        <div class="field"><label>Name</label><input bind:value={f.name} /></div>
        <div class="f2">
          <div class="field"><label>Model</label><select bind:value={f.model}>{#each MODELS as [v, l]}<option value={v}>{l}</option>{/each}</select></div>
          <div class="field"><label>Keypad node ID</label><input type="number" bind:value={f.id} /></div>
        </div>

        <p class="lbl" style="margin-top:14px">Backlight &amp; LEDs</p>
        <div class="f2">
          <div class="field"><label>Backlight colour</label><select bind:value={f.backlightButtonColor}>{#each COLORS as c, i}<option value={i}>{c}</option>{/each}</select></div>
          <div class="field"><label>Dim source (signal)</label>
            <select bind:value={f.dimmingVar}><option value={0}>— always full</option>{#each inputsBool as v}<option value={v.index}>{v.name}</option>{/each}</select></div>
        </div>
        <div class="f2">
          <div class="field"><label>Backlight brightness (0–63)</label><input type="number" min="0" max="63" bind:value={f.backlightBrightness} /></div>
          <div class="field"><label>… dimmed</label><input type="number" min="0" max="63" bind:value={f.dimBacklightBrightness} /></div>
        </div>
        <div class="f2">
          <div class="field"><label>Button-LED brightness (0–63)</label><input type="number" min="0" max="63" bind:value={f.buttonBrightness} /></div>
          <div class="field"><label>… dimmed</label><input type="number" min="0" max="63" bind:value={f.dimButtonBrightness} /></div>
        </div>

        <p class="lbl" style="margin-top:14px">Comms timeout</p>
        <label class="opt" style="border:0;padding-top:0"><input type="checkbox" bind:checked={f.timeoutEnabled} /> Fault if the keypad stops reporting</label>
        {#if f.timeoutEnabled}<div class="field" style="max-width:230px"><label>Timeout (ms)</label><input type="number" bind:value={f.timeout} /></div>{/if}
        <p class="hint">Brightness 0–63. Pick a <b>dim source</b> (e.g. a “lights on” signal) to drop to the dimmed levels — leave it as “always full” for constant brightness.</p>
      {:else if editing.kind === 'keypadbutton'}
        <div class="field"><label>Name</label><input bind:value={f.name} /></div>
        <div class="field"><label>Action</label><select bind:value={f.mode}><option value={0}>Momentary</option><option value={1}>Latched</option></select></div>
        <div class="f2">
          <div class="field"><label>LED colour</label><select bind:value={f.valColors[0]}>{#each COLORS as c, i}<option value={i}>{c}</option>{/each}</select></div>
          <div class="field"><label>LED shows</label><select bind:value={f.valVars[0]}><option value={0}>—</option>{#each inputsBool as v}<option value={v.index}>{v.name}</option>{/each}</select></div>
        </div>
        <div class="field"><label>Fault colour</label><select bind:value={f.faultColor}>{#each COLORS as c, i}<option value={i}>{c}</option>{/each}</select></div>
        <p class="hint">The button is usable as an input anywhere (Outputs, Conditions) under its name. The LED mirrors the "LED shows" signal in the chosen colour.</p>
      {/if}

      {#if editing && editing.kind !== 'keypad' && editing.kind !== 'keypadbutton'}
        <p class="lbl" style="margin-top:16px">⚡ Lua (optional) — runs every tick, merged into the one program</p>
        <LuaEditor bind:value={fnLua} minHeight={120}
          placeholder={`-- custom logic for this ${labelFor(editing.kind)} ${editing.number}\n-- e.g. setLuaOut(0, readVar(1))`} />
        <div style="display:flex;gap:10px;align-items:center;margin-top:8px">
          <button class="btn ghost" disabled={luaBusy || !live} title={live ? '' : 'Connect the module to upload Lua'} onclick={uploadLua}>{luaBusy ? 'Uploading…' : 'Upload Lua program'}</button>
          {#if luaMsg}<span class="muted" style="font-size:12px">{luaMsg}</span>{/if}
        </div>
      {/if}
    </div>
    {#if editing}
      <div class="dfoot"><span class="res">slot {editing.number}</span><span style="margin-left:auto"></span>
        <button class="btn ghost" onclick={close}>Cancel</button>
        <button class="btn primary" disabled={saving} onclick={save}>{saving ? 'Saving…' : (live ? 'Save to device' : 'Save to project')}</button></div>
    {/if}
  </aside>
{/if}

<style>
  .minichart { width: 132px; flex: 0 0 auto; margin-right: 6px; opacity: .92; }
  .minichart :global(.spark) { width: 132px; height: 30px; display: block; }
</style>
