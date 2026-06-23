<script>
  import { api, luaGet, luaSet, luaAssemble, luaReadToTabs, luaSnippets, deviceHasLua, telemetry, remoteLinks, remoteLinkFor, setRemoteLink, clearRemoteLink } from './store.js'
  import { recommendResistors, deriveBands, nodeVoltageMv, resistorForMv, nearestStandard, recommendPullup, supplyCurrentMa, ocVoltageMv, autoTolerance, decodePoints, R_IN } from './ladder.js'
  import { toast } from './toast.js'
  import { dialog, labelFields, clickable } from './a11y.js'
  import LuaEditor from './LuaEditor.svelte'
  import Sparkline from './Sparkline.svelte'
  let { current, ids = [], mode = 'all' } = $props()  // 'all' = full signals list; 'outputs' = digital-output cards only
  // Writes/uploads only reach hardware when the module is live on the bus; config edits still
  // persist to the project offline. Read-backs (Lua read, error check) need a live module.
  let live = $derived(!!current?.connected)
  // Only PDMs run Lua — the CANBoard has no engine. Hide every Lua affordance on boards without it.
  let hasLua = $derived(deviceHasLua(current?.type))

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
  // Ordered so a board's PHYSICAL I/O leads (its reason to exist), then the logic built on top.
  // `group` drives the section headers; the Outputs group renders as cards on the Outputs tab.
  const ALLKINDS = [
    // physical inputs — fixed hardware channels (CANBoard) + the PDM's digital pins
    { key: 'analoginput', arr: 'analogIn', icon: '🎚', label: 'Analog input', physical: true, group: 'Inputs' },
    { key: 'input', arr: 'digitalIn', icon: '🔌', label: 'Digital input', physical: true, group: 'Inputs' },
    { key: 'input', arr: 'inputs', icon: '🔌', label: 'Digital pin', tile: 'Digital pin', desc: 'a physical input pin', addable: true, group: 'Inputs' },
    // logic & messaging — built from the inputs above
    { key: 'caninput', arr: 'canInputs', icon: '📡', label: 'CAN input', tile: 'CAN message', desc: 'value or bit from an incoming frame', addable: true, group: 'Logic & messaging' },
    { key: 'condition', arr: 'conditions', icon: '🔢', label: 'Condition', tile: 'Comparison', desc: 'true when a signal crosses a value', addable: true, group: 'Logic & messaging' },
    { key: 'virtualinput', arr: 'virtualInputs', icon: '🧩', label: 'Virtual input', tile: 'Combination', desc: 'AND/OR up to 3 signals', addable: true, group: 'Logic & messaging' },
    { key: 'flasher', arr: 'flashers', icon: '💡', label: 'Flasher', tile: 'Flasher', desc: 'a blink pattern', addable: true, group: 'Logic & messaging' },
    { key: 'counter', arr: 'counters', icon: '⏱', label: 'Counter', tile: 'Counter', desc: 'count events', addable: true, group: 'Logic & messaging' },
    { key: 'canoutput', arr: 'canOutputs', icon: '📤', label: 'CAN output', tile: 'CAN output', desc: 'transmit a variable on CAN', addable: true, group: 'Logic & messaging' },
    // physical outputs (CANBoard) — shown as cards on the Outputs tab, not in this list
    { key: 'digitaloutput', arr: 'digitalOut', icon: '⭘', label: 'Digital output', physical: true, group: 'Outputs' },
  ]
  let KINDS = $derived(funcs ? ALLKINDS.filter((k) => funcs[k.arr] !== undefined) : [])
  // The full-signals list shows everything except the physical outputs (those live on the Outputs tab).
  let visibleKinds = $derived(KINDS.filter((k) => k.group !== 'Outputs'))
  let outRows = $derived(funcs?.digitalOut ?? [])
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

  // ---- Remote signal reference (feature B): fill this CAN input from another module's broadcast
  // frame (base+offset, from the CAN frame map). Staged only — nothing writes until Save. ----
  let allDevices = $derived($telemetry.devices ?? [])
  let sources = $derived(allDevices.filter((d) => d.guid !== current?.guid && /pdm|canboard/i.test(d.type)))
  let links = $derived($remoteLinks)
  const linkFor = (num) => links.find((l) => l.consumerGuid === current?.guid && l.canInput === num)
  const devName = (g) => allDevices.find((d) => d.guid === g)?.name ?? '(module)'
  const prettySig = (n) => (n || '').replace(/\./g, ' · ')
  let remoteSrc = $state('')      // source device guid
  let remoteSel = $state('')      // chosen signal name
  let remoteSearch = $state('')
  let remoteSigsRaw = $state([])  // [{name, offset, startBit, bitLength, factor, valueOffset, byteOrder, signed, unit, kind}]
  let remoteFuncs = $state(null)  // the source's /functions config (to tell which signals are in use)
  let remoteBusy = $state(false)
  $effect(() => {
    const g = remoteSrc
    if (!g) { remoteSigsRaw = []; remoteFuncs = null; return }
    let alive = true; remoteBusy = true
    Promise.all([api.broadcastSignals(g), api.functions(g).catch(() => null)])
      .then(([s, fx]) => { if (alive) { remoteSigsRaw = Array.isArray(s) ? s : []; remoteFuncs = fx; remoteBusy = false } })
      .catch(() => { if (alive) { remoteSigsRaw = []; remoteFuncs = null; remoteBusy = false } })
    return () => { alive = false }
  })
  // A broadcast signal is "in use" only when the function producing it is enabled on the source
  // (system telemetry is always live). Hides the dozens of unconfigured CAN/virtual/condition slots.
  // srcDev = the source's telemetry record (PDM smart-output enabled lives there — /functions
  // omits `outputs`). fx = the source's /functions config (everything else).
  function signalInUse(name, fx, srcDev) {
    if (!fx) return true   // config unavailable — don't hide everything
    if (/^(DeviceState|PdmType|TotalCurrent|BatteryVoltage|BoardTemp|Heartbeat)/.test(name)) return true
    const m = name.match(/^([A-Za-z]+?)(\d+)/)
    if (!m) return true
    const n = +m[2]
    const at = (arr) => (arr || []).find((x) => x.number === n)
    switch (m[1]) {
      case 'RotarySwitch': { const a = at(fx.analogIn); return !!(a?.enabled && a.rotary?.enabled) }
      case 'AnalogInput': { const a = at(fx.analogIn); return /DigitalMode/.test(name) ? !!(a?.enabled && a.switch?.enabled) : !!a?.enabled }
      case 'Input': return !!at(fx.inputs)?.enabled
      case 'DigitalInput': return !!at(fx.digitalIn)?.enabled
      case 'Output': return !!at(srcDev?.outputs)?.enabled         // PDM smart outputs (telemetry, not /functions)
      case 'DigitalOutput': return !!at(fx.digitalOut)?.enabled    // CANBoard low-side outputs
      case 'CanInput': return !!at(fx.canInputs)?.enabled
      case 'VirtualInput': return !!at(fx.virtualInputs)?.enabled
      case 'Condition': return !!at(fx.conditions)?.enabled
      case 'Counter': return !!at(fx.counters)?.enabled
      case 'Flasher': return !!at(fx.flashers)?.enabled
      default: return /^Wiper/.test(name) ? !!fx.wiper?.enabled : true   // /functions key is `wiper`
    }
  }
  let remoteSrcDev = $derived(allDevices.find((d) => d.guid === remoteSrc) ?? null)
  let remoteSigs = $derived(remoteSigsRaw.filter((s) => signalInUse(s.name, remoteFuncs, remoteSrcDev)))
  let remoteSigsFiltered = $derived(remoteSearch
    ? remoteSigs.filter((s) => (s.name + ' ' + (s.unit || '')).toLowerCase().includes(remoteSearch.toLowerCase()))
    : remoteSigs)
  function applyRemote() {
    const src = allDevices.find((d) => d.guid === remoteSrc)
    const sig = remoteSigs.find((s) => s.name === remoteSel)
    if (!src || !sig) { toast('Pick a module and a signal first.', 'error'); return }
    idHex = hex(src.baseId + sig.offset)
    f.ide = false                                   // native broadcast frames are 11-bit standard
    f.startBit = sig.startBit; f.bitLength = sig.bitLength
    f.byteOrder = sig.byteOrder; f.factor = sig.factor; f.offset = sig.valueOffset; f.signed = sig.signed
    if (!f.name || /^canInput\d+$/i.test(f.name)) f.name = `${src.name} ${sig.name}`
    f._remote = { sourceGuid: src.guid, signal: sig.name, label: prettySig(sig.name), offset: sig.offset,
      startBit: sig.startBit, bitLength: sig.bitLength, factor: sig.factor, valueOffset: sig.valueOffset,
      byteOrder: sig.byteOrder, signed: sig.signed }
    f = { ...f }
    toast(`Filled from ${src.name} · ${prettySig(sig.name)} → ${idHex}. Save to apply.`, 'info')
  }
  function clearRemote() { remoteSrc = ''; remoteSel = ''; delete f._remote; f = { ...f } }

  // ---- multi-position switch designer (analog input → firmware RotarySwitch) ----
  // FW decodes pos = clamp(floor((mV-offset)/step), 0, maxPos). This panel picks resistor
  // values for an even voltage spread, then derives offset/step/maxPos to burn.
  let mp = $state({ on: false, positions: 5, autoRpu: true, autoR: true, tolerance: 200, autoTol: true, vsup: 5, rpu: 4700, series: 'E24', invert: false, burn: false, rows: [] })
  const mpOpts = () => ({ vsupMv: (+mp.vsup || 0) * 1000, rpu: +mp.rpu || 1, rin: R_IN })
  let bands = $derived(deriveBands(mp.rows.map((r) => r.mv)))
  // Worst-case standing current the pull-up + ladder pulls from V+ (highest at the lowest position).
  let peakMa = $derived(mp.rows.length ? Math.max(...mp.rows.map((r) => supplyCurrentMa(r.r, mpOpts()))) : 0)
  // The sensing window auto-follows the position spacing unless the user overrode it.
  $effect(() => { if (mp.autoTol && mp.rows.length) mp.tolerance = autoTolerance(mp.rows.map((r) => r.mv)) })
  // Calibrated-points decode sanity: voltages must rise with position, and each must land in its window.
  let ptsInfo = $derived.by(() => {
    const pts = mp.rows.map((r) => Math.round(r.mv))
    let minGap = Infinity, mono = true
    for (let i = 1; i < pts.length; i++) { minGap = Math.min(minGap, pts[i] - pts[i - 1]); if (pts[i] <= pts[i - 1]) mono = false }
    const ok = mono && pts.every((mv, k) => decodePoints(mv, pts, +mp.tolerance || 1) === k)
    return { minGap: isFinite(minGap) ? minGap : 0, mono, ok }
  })

  function initMp(rot) {
    // The calibrated config carries numPos + points[] (mV per position); reconstruct the rows from them.
    const usePoints = !!rot.enabled && (rot.numPos ?? 0) >= 2 && Array.isArray(rot.points)
    const n = usePoints ? rot.numPos : 5
    mp = { on: !!rot.enabled, positions: n, autoRpu: true, autoR: !usePoints,
           tolerance: usePoints && rot.tolerance > 0 ? rot.tolerance : 200, autoTol: !usePoints,
           vsup: 5, rpu: 4700, series: 'E24', invert: !!rot.invert, burn: false, rows: [] }
    mp.rpu = recommendPullup({ vsupMv: (+mp.vsup || 0) * 1000, n, rin: R_IN, series: mp.series })
    if (usePoints) {
      // calibrated points: the stored voltages are the source of truth; suggest a resistor for each
      for (let k = 0; k < n; k++) {
        const mv = rot.points[k] ?? 0
        mp.rows.push({ mv, r: nearestStandard(resistorForMv(mv, mpOpts()), mp.series) })
      }
    } else { recommend() }
  }
  // Recompute the ladder from the live-bound Positions field (mp.positions). Because it reads
  // bound state — not the rendered row count — a button press right after editing Positions (or
  // on a freshly opened input) always uses the current value; no stale first press.
  function recommend() {
    const n = Math.max(2, Math.min(10, (+mp.positions | 0) || 2))
    if (n !== mp.positions) mp.positions = n
    // when the pull-up is on Auto, re-size it for this position count; a manual pull-up stays put
    if (mp.autoRpu) mp.rpu = recommendPullup({ vsupMv: (+mp.vsup || 0) * 1000, n, rin: R_IN, series: mp.series })
    mp.rows = recommendResistors(n, { ...mpOpts(), series: mp.series }).map((x) => ({ r: x.r, mv: x.mv }))
    mp.autoR = true   // fresh recommendation → resistors are auto again
  }
  // Pull-up value changed (manual edit or Auto button). Re-solve the switch resistors for the new
  // pull-up — unless they were hand-entered, in which case keep them and just recompute voltages.
  function onRpuChanged() {
    if (mp.autoR) {
      const n = Math.max(2, Math.min(10, (+mp.positions | 0) || 2))
      mp.rows = recommendResistors(n, { ...mpOpts(), series: mp.series }).map((x) => ({ r: x.r, mv: x.mv }))
    } else { rescale() }
  }
  // rescale = keep chosen resistors, recompute their voltages (after V+ / pull-up change)
  function rescale() { mp.rows = mp.rows.map((x) => ({ r: x.r, mv: nodeVoltageMv(isFinite(x.r) ? x.r : Infinity, mpOpts()) })) }
  function setR(i, v) { const r = +v; mp.rows[i] = { r, mv: nodeVoltageMv(r > 0 ? r : Infinity, mpOpts()) }; mp.rows = [...mp.rows]; mp.autoR = false }
  function setV(i, volts) { const mv = (+volts || 0) * 1000; mp.rows[i] = { mv, r: nearestStandard(resistorForMv(mv, mpOpts()), mp.series) }; mp.rows = [...mp.rows]; mp.autoR = false }
  // Pick the pull-up that fills the readable range (biggest margins), then re-solve the ladder.
  function autoPullup() {
    mp.autoRpu = true
    mp.rpu = recommendPullup({ vsupMv: (+mp.vsup || 0) * 1000, n: mp.positions, rin: R_IN, series: mp.series })
    onRpuChanged()
  }

  // ---- Calibrate: capture the live voltage into a position's field (complements manual entry).
  // It just writes into the existing voltage column via setV — same path as typing it by hand. ----
  let calibrating = $state(false)
  let calStep = $state(0)
  const liveMv = () => (live && f?.name ? liveByName[f.name]?.value : 0) ?? 0
  function capturePos(i) { setV(i, liveMv() / 1000) }                                   // live mV → this row's voltage
  function captureStep() { capturePos(calStep); if (calStep < mp.rows.length - 1) calStep++ }

  // ---- linear sensor scaling (analog input → firmware AnalogScale): scaled = gain*mV + offset ----
  // Two datasheet points (mV → engineering value) define the line; the tool sends gain/offset.
  let sc = $state({ on: false, units: '', inLowMv: 500, outLow: 0, inHighMv: 4500, outHigh: 100 })
  let scGain = $derived(((+sc.outHigh || 0) - (+sc.outLow || 0)) / (((+sc.inHighMv || 0) - (+sc.inLowMv || 0)) || 1))
  let scOffset = $derived((+sc.outLow || 0) - scGain * (+sc.inLowMv || 0))
  let scLive = $derived(sc.on && live && f?.name ? scGain * (liveByName[f.name]?.value ?? 0) + scOffset : null)
  function initScale(s) {
    s = s ?? {}
    sc = { on: !!s.enabled, units: s.units ?? '',
           inLowMv: s.inLowMv ?? 500, outLow: s.outLow ?? 0,
           inHighMv: s.inHighMv ?? 4500, outHigh: s.outHigh ?? 100 }
  }

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
    // deep-copy the nested objects so editing the drawer doesn't mutate the shared list
    if (kind === 'analoginput') {
      // an input is on/off OR multi-position OR linear-scale, never more than one
      f.rotary = { ...(row.rotary ?? {}) }; f.switch = { ...(row.switch ?? {}) }; f.scale = { ...(row.scale ?? {}) }
      initMp(f.rotary); initScale(f.scale)
      if (f.switch.enabled) { mp.on = false; sc.on = false }
      else if (mp.on) { sc.on = false }
    }
    if (kind === 'caninput') {
      const lk = remoteLinkFor(current?.guid, editing.number)
      remoteSrc = lk?.sourceGuid ?? ''; remoteSel = lk?.signal ?? ''; remoteSearch = ''
      if (lk) f._remote = { ...lk }
    }
    drawer = true
  }
  function close() { drawer = false; editing = null }

  async function save() {
    if (!current || !editing) return
    const body = { ...f }
    delete body._remote   // client-only metadata; never sent to the device
    // Multi-position switch: write the derived bands onto the analog input's RotarySwitch.
    if (editing.kind === 'analoginput') {
      body.rotary = { ...f.rotary, enabled: mp.on, invert: mp.invert,
        numPos: mp.rows.length, tolerance: Math.round(+mp.tolerance || 200),
        points: Array.from({ length: 10 }, (_, k) => (k < mp.rows.length ? Math.round(mp.rows[k].mv) : 0)) }
      body.scale = { ...f.scale, enabled: sc.on, units: sc.units, gain: scGain, offset: scOffset,
        inLowMv: +sc.inLowMv || 0, outLow: +sc.outLow || 0, inHighMv: +sc.inHighMv || 0, outHigh: +sc.outHigh || 0 }
      // firmware reads nothing on this channel unless it's enabled
      if (mp.on || sc.on || f.switch.enabled) body.enabled = true
    }
    // Only CAN kinds carry a hex frame id; keypad master's id is a plain decimal node id.
    if (editing.kind === 'caninput' || editing.kind === 'canoutput') {
      const id = parseInt(String(idHex).replace(/^0x/i, ''), 16)
      if (!Number.isInteger(id) || id < 0) { toast(`"${idHex}" is not a valid CAN ID (use hex, e.g. 0x18F).`, 'error'); return }
      const max = f.ide ? 0x1FFFFFFF : 0x7FF
      if (id > max) { toast(`CAN ID 0x${id.toString(16).toUpperCase()} exceeds the ${f.ide ? '29' : '11'}-bit max (0x${max.toString(16).toUpperCase()}). ${id > 0x7FF ? 'Set Frame = Extended.' : ''}`, 'error'); return }
      body.id = id
    }
    // Record/clear the cross-module link (feature B). Client-side only — this is what lets a
    // base-ID change later flag which CAN inputs need re-applying.
    if (editing.kind === 'caninput') {
      if (f._remote) setRemoteLink(current.guid, editing.number, f._remote)
      else clearRemoteLink(current.guid, editing.number)
    }
    saving = true
    try {
      const r = await api.setFunction(current.guid, editing.kind, editing.number, body)
      await reload()
      toast(r?.written
        ? `Saved ${labelFor(editing.kind)} ${editing.number} to device`
        : `Saved ${labelFor(editing.kind)} ${editing.number} to the project — module offline; Deploy when connected`, r?.written ? 'ok' : 'info')
      if (editing.kind === 'analoginput' && mp.burn && r?.written) {
        try { await api.action(current.guid, 'burn'); toast('Burned to flash — persists across reboot', 'ok') }
        catch (e) { toast('Saved, but burn failed: ' + e.message, 'error') }
      }
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
  <div><h1>{current ? current.name : '—'} · {mode === 'outputs' ? 'Outputs' : 'Signals & logic'}</h1>
    <p class="sub">{mode === 'outputs'
      ? "The board's digital outputs — each switches on when the signal driving it is true. Click one to choose its driver."
      : "The device's inputs and logic blocks — physical pins, CAN messages, and logic built from them. Edit a row or define a new one; Save writes to the device, Burn persists."}</p></div>
  {#if mode !== 'outputs'}<button class="btn primary" disabled={!current} onclick={() => { editing = null; drawer = true }}>+ Define new signal</button>{/if}
</div>

{#if !current}
  <div class="card flat"><p class="muted">No device bound.</p></div>
{:else if !funcs}
  <div class="card flat"><p class="muted">Loading…</p></div>
{:else}
  {#if loadErr}<div class="sys-alert">⚠ {loadErr}</div>{/if}

  {#if mode === 'outputs'}
    <div class="grid">
      {#each outRows as o (o.number)}
        {@const lv = liveByName[o.name]}
        {@const on = !!lv?.on}
        {@const drv = o.enabled ? varName(o.input) : null}
        <div class="card" use:clickable aria-label={'Configure ' + o.name} onclick={() => openEdit(meta('digitaloutput'), o)}>
          <div class="num">DO{o.number}</div>
          <div class="top">
            <span class="state {on ? 'on' : 'off'}" style={live ? '' : 'opacity:.65'}><span class="ic"></span>{on ? 'ON' : 'OFF'}</span>
            <span class="nm">{o.name}{#if !o.enabled} <span class="muted" style="font-weight:400">· off</span>{/if}</span>
          </div>
          <div class="rule-txt">
            {#if drv && drv !== '—' && drv !== 'None'}<span class="kw">ON when</span> <span class="sig">{drv}</span>{:else}<span class="muted">No driver set — tap to choose what switches it</span>{/if}
          </div>
          <Sparkline value={lv?.value ?? 0} win={30} tick={liveTick} color="#2a9d8f" />
          <div class="ft">
            <span class="tag" title="Low-side (ground) switch: wire the load between +12 V and this terminal — the board switches its ground. On/off only — no PWM, soft-start, or current sensing (those are PDM smart-output features).">low-side · on/off</span>
            <span class="edit-hint">edit →</span>
          </div>
        </div>
      {/each}
      {#if outRows.length === 0}<p class="muted">This board has no digital outputs.</p>{/if}
    </div>
  {/if}

  {#if mode !== 'outputs'}
  {#if hasLua}
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
        <button class="btn ghost" disabled={luaBusy} title={live ? 'Read the running program off the device' : 'Show the program stored in the project (e.g. deployed offline via cross-module functions)'} onclick={readLua}>{live ? 'Read from device' : 'Show stored Lua'}</button>
        <button class="btn ghost" disabled={luaBusy || !live} title={live ? '' : 'Connect the module to read its error state'} onclick={checkLuaError}>Check error</button>
        {#if luaMsg}<span class="muted">{luaMsg}</span>{:else if !live}<span class="muted" style="font-size:12px">Module offline — “Show stored Lua” reveals the saved/deployed program; connect to upload changes.</span>{/if}
      </div>
      {#if luaDevErr}
        <div class="sys-alert" style="margin-top:8px">⚠ Device Lua error: <span style="font-family:var(--mono)">{luaDevErr}</span></div>
      {/if}
      <p class="hint">Drive any output / virtual input / CAN output by setting its input to a
        <b>Lua slot</b> and writing it with <code>setLuaOut(n, v)</code>. Upload sends the program
        now; press <b>Burn</b> to keep it across reboot.</p>
    </div>
  {/if}
  {/if}

  {#each visibleKinds as k, ki}
    {@const rows = rowsFor(k)}
    {@const used = list(k).filter((x) => x.enabled).length}
    {#if ki === 0 || visibleKinds[ki - 1].group !== k.group}<div class="grp-hd">{k.group}</div>{/if}
    <div class="cat-grp">{k.icon} {k.label}s <span style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted)">— {used} / {list(k).length} {k.physical ? 'enabled' : 'used'}</span><span class="ct"></span></div>
    {#each rows as s (k.key + ":" + s.number)}
      <div class="sig-row" style="cursor:pointer" use:clickable onclick={() => openEdit(k, s)}>
        <span class="ico">{k.icon}</span>
        <div style="flex:1">
          <div class="nm2">{s.name} {#if k.physical && !s.enabled}<span class="muted" style="font-weight:400">(disabled)</span>{/if}</div>
          <div class="def">
            {#if k.key === 'caninput'}{hex(s.id)} · bit {s.startBit}+{s.bitLength}{#if s.factor !== 1} · ×{s.factor}{/if}{#if linkFor(s.number)} · 🔗 {devName(linkFor(s.number).sourceGuid)}{/if}
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
          <div class="minichart" style={live ? '' : 'opacity:.4'} onclick={(e) => e.stopPropagation()} title={live ? `live (${liveByName[s.name].value})` : `module offline — last value (${liveByName[s.name].value}), not live`}>
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
        {#if sources.length}
          <p class="lbl" style="margin-top:12px">🔗 Pull from another module (optional)</p>
          <div class="f2">
            <div class="field"><label>Source module</label>
              <select bind:value={remoteSrc}><option value="">— manual entry —</option>{#each sources as d}<option value={d.guid}>{d.name} ({hex(d.baseId)})</option>{/each}</select></div>
            <div class="field"><label>Signal{#if remoteBusy} …{/if}</label>
              <select bind:value={remoteSel} disabled={!remoteSrc}><option value="">— pick a broadcast signal —</option>{#each remoteSigsFiltered as s}<option value={s.name}>{prettySig(s.name)}{s.unit ? ' (' + s.unit + ')' : ''} · {s.kind}</option>{/each}</select></div>
          </div>
          {#if remoteSrc}
            <div class="f2">
              <div class="field"><label>Filter signals</label><input bind:value={remoteSearch} placeholder="switch, rotary, output…" /></div>
              <div class="field" style="align-self:end"><button class="btn primary" type="button" disabled={!remoteSel} onclick={applyRemote}>Use this signal</button></div>
            </div>
          {/if}
          {#if remoteSrc && !remoteBusy && remoteSigs.length === 0}<p class="hint">No signals are wired up on <b>{devName(remoteSrc)}</b> yet — enable an input / output / logic block there first, or use manual entry.</p>{/if}
          {#if f._remote}<p class="hint">Linked to <b>{devName(f._remote.sourceGuid)}</b> · {f._remote.label} (base+{f._remote.offset}). The fields below are filled from its broadcast frame; re-basing that module flags this input for re-save. <button type="button" class="linkbtn" onclick={clearRemote}>unlink</button></p>{/if}
        {/if}
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
        <p class="hint"><b>Low-side (ground) switch.</b> Wire the load between +12&nbsp;V and this output terminal — the board switches its ground when the driving signal is true. On/off only: no PWM, soft-start, or current sensing (those are PDM smart-output features).</p>
      {:else if editing.kind === 'analoginput'}
        <label class="opt" style="border:0;padding-top:0"><input type="checkbox" bind:checked={f.enabled} /> Input enabled</label>
        <div class="field"><label>Name</label><input bind:value={f.name} /></div>

        <p class="lbl" style="margin-top:14px">🔘 On/off switch (single threshold)</p>
        <label class="chk"><input type="checkbox" bind:checked={f.switch.enabled} onchange={() => { if (f.switch.enabled) { mp.on = false; sc.on = false } }} /> Use this input as an on/off switch at a voltage threshold</label>
        {#if f.switch.enabled}
          <div class="f3" style="margin-top:6px">
            <div class="field"><label>Threshold (mV)</label><input type="number" bind:value={f.switch.threshold} /></div>
            <div class="field"><label>Mode</label><select bind:value={f.switch.mode}><option value={0}>Momentary</option><option value={1}>Latched</option></select></div>
            <label class="chk" style="align-self:end"><input type="checkbox" bind:checked={f.switch.invert} /> Invert</label>
          </div>
          <p class="hint">On when the voltage is {f.switch.invert ? 'below' : 'above'} {f.switch.threshold || 0} mV{#if live} · live {Math.round(liveByName[f.name]?.value ?? 0)} mV → <b>{liveByName[f.name + ' Switch']?.on ? 'ON' : 'OFF'}</b>{/if}. Use it anywhere as “{f.name} Switch”.</p>
        {/if}

        <p class="lbl" style="margin-top:14px">🎚 Multi-position switch</p>
        <label class="chk"><input type="checkbox" bind:checked={mp.on} onchange={() => { if (mp.on) { f.switch.enabled = false; sc.on = false; if (mp.rows.length === 0) recommend() } }} /> Decode this input as a rotary / multi-position switch</label>

        {#if mp.on}
          {@const livePos = live ? liveByName[f.name + ' Pos']?.value : undefined}
          <div class="f2" style="margin-top:8px">
            <div class="field"><label>Positions</label><input type="number" min="2" max="10" bind:value={mp.positions} onchange={() => recommend()} /></div>
            <div class="field"><label>Pull-up to 5&nbsp;V (Ω)</label>
              <div style="display:flex;gap:6px">
                <input type="number" style="flex:1;min-width:0" bind:value={mp.rpu} onchange={() => { mp.autoRpu = false; onRpuChanged() }} />
                <button class="btn ghost" type="button" class:active={mp.autoRpu} style="padding:6px 10px" title="Auto-size the pull-up so the open (top) detent reads the 4.85 V max" onclick={autoPullup}>Auto{mp.autoRpu ? ' ✓' : ''}</button>
              </div></div>
          </div>
          <div class="f2">
            <div class="field"><label>Resistor series</label><select value={mp.series} onchange={(e) => { mp.series = e.target.value; recommend() }}><option value="E24">E24 (5%)</option><option value="E12">E12 (10%)</option></select></div>
            <div class="field" style="align-self:end"><button class="btn ghost" type="button" onclick={() => recommend()}>↻ Recommend resistors</button></div>
          </div>
          <div class="f2">
            <div class="field"><label>Sensing ± (mV)</label>
              <div style="display:flex;gap:6px">
                <input type="number" style="flex:1;min-width:0" bind:value={mp.tolerance} onchange={() => (mp.autoTol = false)} />
                <button class="btn ghost" type="button" class:active={mp.autoTol} style="padding:6px 10px" title="Auto-size the sensing window from the position spacing (capped)" onclick={() => { mp.autoTol = true; mp.tolerance = autoTolerance(mp.rows.map((r) => r.mv)) }}>Auto{mp.autoTol ? ' ✓' : ''}</button>
              </div></div>
            <div class="field"></div>
          </div>

          <table class="ladder">
            <thead><tr><th>Pos</th><th>Resistor to GND (Ω)</th><th>Voltage</th></tr></thead>
            <tbody>
              {#each mp.rows as row, i}
                <tr class:activepos={livePos != null && livePos === (mp.invert ? mp.rows.length - 1 - i : i)} class:calrow={calibrating && calStep === i}>
                  <td>{mp.invert ? mp.rows.length - 1 - i : i}</td>
                  <td>{#if isFinite(row.r)}<input type="number" value={Math.round(row.r)} onchange={(e) => setR(i, e.target.value)} />{:else}<span class="muted" title="Switch open — no resistor; this detent reads the pull-up (max) voltage">open</span>{/if}</td>
                  <td><input type="number" step="0.01" value={(row.mv / 1000).toFixed(2)} onchange={(e) => setV(i, e.target.value)} /> V{#if calibrating}<button class="btn ghost" type="button" style="padding:2px 7px;font-size:11px;margin-left:6px" disabled={!live} title={live ? 'Capture the live voltage into this position' : 'Connect the module to capture'} onclick={() => capturePos(i)}>⦿</button>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>

          <label class="chk"><input type="checkbox" bind:checked={calibrating} onchange={() => (calStep = 0)} /> 🎯 Calibrate from a connected switch — capture the live voltage into each position</label>
          {#if calibrating}
            {#if live}
              <div class="livepos on"><span class="pulse"></span> live <b>{Math.round(liveMv())} mV</b> — set the switch to <b>position {calStep}</b>, then capture (or use ⦿ on any row).</div>
              <button class="btn primary" type="button" onclick={captureStep}>📍 Capture position {calStep} → {(liveMv() / 1000).toFixed(2)} V{calStep < mp.rows.length - 1 ? ' · then next' : ' · last'}</button>
            {:else}
              <p class="hint">Connect the module to capture live voltages, then step through each switch position. You can still type voltages by hand.</p>
            {/if}
          {/if}

          <div class="livepos" class:on={livePos != null}>
            {#if live}<span class="pulse"></span> live: <b>position {livePos ?? '—'}</b> · {Math.round(liveByName[f.name]?.value ?? 0)} mV — turn the switch to watch it land
            {:else}Connect the module to watch the live position as you turn the switch.{/if}
          </div>

          <p class="hint" class:warn={!ptsInfo.ok}>
            {#if !ptsInfo.mono}⚠ Position voltages must increase with the position number — recapture or reorder.
            {:else if !ptsInfo.ok}⚠ Some positions are too close to tell apart at ±{mp.tolerance} mV. Lower the sensing window or spread the positions.
            {:else}Decodes {mp.rows.length} calibrated positions · sensing ±{mp.tolerance} mV · tightest gap {ptsInfo.minGap} mV. A reading outside every window reports “no position”.{/if}
          </p>
          <p class="hint">Pull-up {mp.rpu}Ω{#if mp.autoRpu} (auto — open top detent reads the 4.85&nbsp;V max){/if} draws up to <b>{peakMa.toFixed(1)} mA</b> from the 5&nbsp;V supply (worst case, lowest position){#if peakMa > 25} — high{/if}.{#if !mp.autoRpu} <button type="button" class="linkbtn" onclick={autoPullup}>Auto-size pull-up</button> to put the open detent at 4.85&nbsp;V.{/if}</p>
          <label class="chk"><input type="checkbox" bind:checked={mp.invert} /> Invert (reverse position order)</label>
          <label class="chk"><input type="checkbox" bind:checked={mp.burn} /> Burn to flash on save (persist across reboot)</label>
          <p class="hint">Wire the 5&nbsp;V supply —[pull-up {mp.rpu}Ω]— input pin; the switch grounds the pin through the listed resistor at each position — the top detent leaves it open (reads the pull-up max). The board's own {(R_IN / 1000)}kΩ to GND is already included. Read the position anywhere as “{f.name}” — a Condition, an output's driver, or a CAN output.</p>
        {:else}
          <p class="hint">Analog channel. Turn on the multi-position switch above, or use a Condition to make an on/off signal, or read the raw value on CAN.</p>
        {/if}

        <p class="lbl" style="margin-top:14px">📈 Linear scaling (sensor)</p>
        <label class="chk"><input type="checkbox" bind:checked={sc.on} onchange={() => { if (sc.on) { f.switch.enabled = false; mp.on = false } }} /> Scale this input to engineering units (pressure, temperature, …)</label>
        {#if sc.on}
          <p class="hint">Enter two points from the sensor's datasheet (input voltage → reading). The tool sends gain &amp; offset; the module publishes “{f.name}” in your units for use in Conditions, outputs and CAN.</p>
          <div class="f3" style="margin-top:6px">
            <div class="field"><label>Units</label><input bind:value={sc.units} placeholder="bar, °C, psi…" /></div>
            <div class="field"></div><div class="field"></div>
          </div>
          <table class="ladder">
            <thead><tr><th>Point</th><th>Input (mV)</th><th>Reads ({sc.units || 'units'})</th></tr></thead>
            <tbody>
              <tr><td>Low</td><td><input type="number" bind:value={sc.inLowMv} /></td><td><input type="number" step="any" bind:value={sc.outLow} /></td></tr>
              <tr><td>High</td><td><input type="number" bind:value={sc.inHighMv} /></td><td><input type="number" step="any" bind:value={sc.outHigh} /></td></tr>
            </tbody>
          </table>
          <p class="hint">gain <b>{scGain.toFixed(5)}</b> {sc.units || 'units'}/mV · offset <b>{scOffset.toFixed(3)}</b> {sc.units || 'units'}{#if live} · live {Math.round(liveByName[f.name]?.value ?? 0)} mV → <b>{scLive != null ? scLive.toFixed(2) : '—'} {sc.units}</b>{/if}</p>
          <label class="chk"><input type="checkbox" bind:checked={mp.burn} /> Burn to flash on save (persist across reboot)</label>
        {/if}
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

      {#if editing && hasLua && editing.kind !== 'keypad' && editing.kind !== 'keypadbutton'}
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
  table.ladder { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
  table.ladder th, table.ladder td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--line-2, #e0e0e8); }
  table.ladder th { color: var(--muted); font-weight: 600; }
  table.ladder input { width: 90px; }
  .hint.warn { color: var(--err, #d32f2f); font-weight: 500; }
  tr.activepos td { background: color-mix(in srgb, var(--ok, #2a9d8f) 18%, transparent); font-weight: 600; }
  tr.calrow td { background: color-mix(in srgb, var(--accent, #594ae2) 16%, transparent); }
  .livepos { margin: 10px 0; padding: 8px 11px; border-radius: 8px; font-size: 13px; color: var(--muted); background: var(--surface-2, #f6f6fa); display: flex; align-items: center; gap: 7px; }
  .livepos.on { color: var(--ink, #222); }
  .livepos .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--ok, #2a9d8f); flex: 0 0 auto; animation: lp 1.4s ease-in-out infinite; }
  @keyframes lp { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }

  /* Section group headers in the signals list */
  .grp-hd { font: 700 12px/1 var(--font, inherit); text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 24px 0 4px; padding-bottom: 6px; border-bottom: 1px solid var(--line-2, #e0e0e8); }
  .grp-hd:first-child { margin-top: 4px; }
</style>
