<script>
  import { SvelteFlow, Background, Controls, MiniMap } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import FnNode from './FnNode.svelte'
  import SignalsView from './SignalsView.svelte'
  import { writable } from 'svelte/store'
  import { untrack } from 'svelte'
  import { dialog, labelFields, clickable } from './a11y.js'
  import { api, applyGraphConnection, enableFunction, bridgeRemoteSignal, addCanInputFromDbc, NODE_INPUTS, telemetry } from './store.js'
  import { toast } from './toast.js'
  import RemoteSourceAdd from './RemoteSourceAdd.svelte'

  let { device, devices = [], onOpenSettings, dark = true } = $props()   // dark follows the app theme (the canvas was a dark island in light mode)
  // graph kind -> the Signals & logic editor kind. Everything opens INLINE below the canvas (the
  // graph stays visible while you edit); PDM smart outputs are the exception — they edit in the
  // Outputs tab (their protection/PWM drawer lives there), via onOpenSettings.
  const SETTINGS_KIND = { digin: 'input', analogin: 'analoginput', caninput: 'caninput', virtualinput: 'virtualinput', condition: 'condition', counter: 'counter', flasher: 'flasher', timer: 'timer', table: 'table', canoutput: 'canoutput', output: 'output' }
  // Wiring edits persist to the project record even offline; they only reach the module over CAN
  // when it's live. Keep wiring enabled (offline authoring) but tell the truth about what landed.
  let live = $derived(!!device?.connected)
  const nodeTypes = { fn: FnNode }

  const META = {
    sys: ['#6f6f88', 'device'], digin: ['#2a9d8f', 'input'], analogin: ['#1f9e7a', 'analog'], caninput: ['#4361ee', 'CAN in'],
    virtualinput: ['#7209b7', 'virtual'], condition: ['#f77f00', 'condition'], counter: ['#d62828', 'counter'],
    flasher: ['#caa600', 'flasher'], timer: ['#e36414', 'timer'], table: ['#0a9396', 'table'],
    output: ['#594ae2', 'output'], canoutput: ['#06998b', 'CAN out'],
    lua: ['#2d6a4f', 'lua'], kpbtn: ['#b5179e', 'keypad'], kpdial: ['#b5179e', 'dial'], kpain: ['#b5179e', 'analog'],
    wiper: ['#457b9d', 'wiper'], remote: ['#e07a5f', 'remote'],
  }
  const COL = { sys: 0, digin: 0, analogin: 0, caninput: 0, lua: 0, kpbtn: 0, kpdial: 0, kpain: 0, remote: 0, virtualinput: 1, condition: 1, counter: 1, flasher: 1, timer: 1, table: 1, wiper: 1, output: 2, canoutput: 2 }
  // Creatable kinds → their /functions array (the Add menu shows how many slots are still free).
  const KIND_ARR = { condition: 'conditions', virtualinput: 'virtualInputs', counter: 'counters', flasher: 'flashers', timer: 'timers', table: 'tables', caninput: 'canInputs', canoutput: 'canOutputs' }
  const ADDABLE = [['condition', 'Condition (threshold → on/off)'], ['virtualinput', 'Virtual input (AND / OR)'], ['counter', 'Counter'], ['flasher', 'Flasher'], ['timer', 'Timer (delay / pulse)'], ['table', 'Lookup table (2-axis map)'], ['caninput', 'CAN input'], ['canoutput', 'CAN output']]
  const DELETABLE = new Set(Object.keys(KIND_ARR))
  // Human labels for each node's ports (handle id -> row label). Falls back to the raw id.
  const PORT_LABEL = {
    output: { input: 'Trigger', dutyCycleInput: 'Duty source', freqInput: 'Freq source', on: 'State', current: 'Current (A)', oc: 'Overcurrent', fault: 'Fault' },
    caninput: { state: 'State', value: 'Value' },
    virtualinput: { var0: 'In 1', var1: 'In 2', var2: 'In 3', out: 'Output' },
    condition: { input: 'In', out: 'Output' },
    counter: { incInput: 'Count +', decInput: 'Count −', resetInput: 'Reset', out: 'Count' },
    flasher: { input: 'Trigger', out: 'Output' }, timer: { input: 'Trigger', out: 'Output' },
    table: { xInput: 'X', yInput: 'Y', out: 'Value' }, canoutput: { input: 'Value' },
    analogin: { value: 'Raw ADC', mv: 'mV', pos: 'Position', switch: 'Switch', scaled: 'Scaled' },
    digin: { out: 'State' }, sys: { 1: 'Always On', 2: 'State', 3: 'Temperature', 4: 'Battery (V)', forceSleepInput: 'Force sleep', muteTxInput: 'Mute CAN TX' }, lua: { out: 'Out' },
    kpbtn: { out: 'Pressed' }, kpdial: { out: 'Value' }, kpain: { out: 'Value' }, remote: { out: 'Signal' },
    wiper: { slow: 'Slow', fast: 'Fast', park: 'Park', inter: 'Intermittent', wash: 'Wash', swipe: 'Swipe' },
  }
  // Which funcs array carries each kind's live signal (matched by function name).
  const SIGARR = { caninput: 'canInputs', virtualinput: 'virtualInputs', condition: 'conditions', counter: 'counters', flasher: 'flashers', timer: 'timers', table: 'tables' }
  const SIGKIND = { caninput: 'CAN input', virtualinput: 'Virtual input', condition: 'Condition', counter: 'Counter', flasher: 'Flasher', timer: 'Timer', table: 'Table' }   // /signals `kind` labels
  // Port data type → shown as a chip (B=bool, I=int, R=real) and as the dot colour; drives wire validation.
  const PORT_TYPE = {
    digin: { out: 'bool' }, analogin: { value: 'real', mv: 'real', pos: 'int', switch: 'bool', scaled: 'real' },
    caninput: { state: 'bool', value: 'real' }, virtualinput: { var0: 'bool', var1: 'bool', var2: 'bool', out: 'bool' },
    condition: { input: 'real', out: 'bool' }, counter: { incInput: 'bool', decInput: 'bool', resetInput: 'bool', out: 'int' },
    flasher: { input: 'bool', out: 'bool' }, timer: { input: 'bool', out: 'bool' }, table: { xInput: 'real', yInput: 'real', out: 'real' }, canoutput: { input: 'real' },
    output: { input: 'bool', dutyCycleInput: 'real', freqInput: 'real', on: 'bool', current: 'real', oc: 'bool', fault: 'bool' },
    sys: { 1: 'bool', 2: 'int', 3: 'real', 4: 'real', forceSleepInput: 'bool', muteTxInput: 'bool' },
    lua: { out: 'bool' }, remote: { out: 'bool' }, kpbtn: { out: 'bool' }, kpdial: { out: 'int' }, kpain: { out: 'real' },
    wiper: { slow: 'bool', fast: 'bool', park: 'bool', inter: 'bool', wash: 'bool', swipe: 'bool' },
  }
  const portType = (kind, port) => PORT_TYPE[kind]?.[port]
  // What a target accepts: a bool input wants a true/false source; int takes int or bool (0/1);
  // real takes anything. Unknown types never block a wire.
  const canConnect = (src, dst) => !src || !dst || dst === 'real' || src === dst || (dst === 'int' && src === 'bool')
  // Which graph kinds map to a setFunction kind for rename/auto-enable (PDM smart outputs excluded — use Outputs tab).
  const isCanboard = $derived(/can.?board/i.test(device?.type || ''))
  const FN_KIND = { digin: 'input', analogin: 'analoginput', caninput: 'caninput', virtualinput: 'virtualinput', condition: 'condition', counter: 'counter', flasher: 'flasher', timer: 'timer', table: 'table', canoutput: 'canoutput' }
  const fnKindOf = (kind) => kind === 'output' ? (isCanboard ? 'digitaloutput' : null) : FN_KIND[kind]
  const TIMER_MODE = ['on-delay', 'off-delay', 'pulse']
  const EDGE_OFF = 'stroke:#594ae2;stroke-width:1.5', EDGE_ON = 'stroke:#2fbf71;stroke-width:2.2'

  let nodes = $state.raw([])
  let edges = $state.raw([])
  let liveSig = $state({})   // signal name -> { value, on } from the telemetry poll
  let vmap = $state.raw([])      // the device's REAL VarMap [{index, name}] — authoritative idx↔source
  let funcs = $state.raw(null)   // the device's /functions config
  // Live readouts flow through this store (node id -> {values,status}) so node/handle DOM is NEVER
  // recreated on a value tick — reassigning `nodes` every poll recreated handles and made the dots
  // jump under the cursor while wiring. FnNode reads its own id from the store.
  const fnLive = writable({})
  let msg = $state('')
  let remotes = $state([])              // [{ srcGuid, srcVar, label, devName }]
  let remoteOpen = $state(false), remoteDev = $state(''), remoteSearch = $state(''), remoteSignals = $state([]), dbcMore = $state(false)
  // A DBC/ECU source isn't a configurable module (no varmap/functions) — it already transmits its
  // frames, so we list its DBC signals and decode them directly into a local CAN input (no bridge).
  const remoteIsDbc = $derived(/dbc/i.test(devices.find((d) => d.guid === remoteDev)?.type || ''))
  const hex = (n) => '0x' + (n ?? 0).toString(16).toUpperCase()
  // Inline editor (gear button): the Signals & logic drawer opens over the canvas for this item.
  let inlineTarget = $state(null)
  let targetNonce = 0
  // Depend on the guid, not the `device` object: telemetry re-materialises `device` 10×/s, which
  // would re-run every effect reading it (and reset its poll interval) on each push.
  let guid = $derived(device?.guid)

  const posKey = () => 'dingoGraphPos:' + device?.guid
  const remKey = () => 'dingoGraphRemotes:' + device?.guid
  const loadPos = () => { try { return JSON.parse(localStorage.getItem(posKey()) || '{}') } catch { return {} } }
  const savePos = () => { const p = {}; for (const n of nodes) p[n.id] = n.position; try { localStorage.setItem(posKey(), JSON.stringify(p)) } catch {} }
  const saveRemotes = () => { try { localStorage.setItem(remKey(), JSON.stringify(remotes)) } catch {} }
  const dName = (g) => devices.find((d) => d.guid === g)?.name ?? g?.slice(0, 6)

  // Output rows on the canvas: PDM smart outputs (device telemetry) or CANBoard low-side outputs (/functions).
  // `input` is the trigger var; duty/freq sources only count while that variable-PWM mode is on.
  const outputRows = () => device?.outputs?.length
    ? device.outputs.map((o) => ({ number: o.number, name: o.name, input: o.inputVal, dutyCycleInput: o.variableDutyCycle ? o.dutyCycleInput : 0, freqInput: o.variableFreq ? o.freqInput : 0 }))
    : (funcs?.digitalOut ?? []).map((o) => ({ number: o.number, name: o.name, input: o.input, dutyCycleInput: o.variableDutyCycle ? o.dutyCycleInput : 0, freqInput: o.variableFreq ? o.freqInput : 0 }))
  const diginArr = () => funcs?.inputs ?? funcs?.digitalIn ?? []

  // Source catalog: EVERY wireable source (node id, port) with its owner (function kind + slot number +
  // property, as the backend tags each var-map entry) and its VarLabel name as a fallback. Resolved
  // against the REAL VarMap (vmap) in maps() — owner first (exact, immune to a CAN input and a table
  // both called "Fan"), name second (older backends / keypad entries). Digital inputs are `inputs` on
  // a PDM but `digitalIn` on a CANBoard — unified. The device node ('sys') carries the system vars.
  function catalog() {
    const C = []; const P = (id, port, name, fk, num, prop) => C.push({ id, port, name, fk, num, prop })
    P('sys', '1', 'Always On', 'sys', 1, 'Value'); P('sys', '2', 'State', 'sys', 2, 'Value'); P('sys', '2', 'State', 'sys', 2, 'State'); P('sys', '3', 'Temperature', 'sys', 3, 'Value'); P('sys', '4', 'Battery Voltage', 'sys', 4, 'Value')
    ;diginArr().forEach((c, k) => P('digin:' + (k + 1), 'out', c.name, 'input', k + 1, 'State'))
    ;(funcs?.analogIn ?? []).forEach((c, k) => { const id = 'analogin:' + (k + 1), n = c.name, fk = 'analoginput', num = k + 1
      P(id, 'value', n + ' Raw ADC', fk, num, 'Raw ADC'); P(id, 'mv', n + ' Millivolts', fk, num, 'Millivolts'); P(id, 'pos', n + ' Rotary Position', fk, num, 'Rotary Position'); P(id, 'switch', n + ' Switch Value', fk, num, 'Switch Value'); P(id, 'scaled', n + ' Scaled Value', fk, num, 'Scaled Value') })
    ;outputRows().forEach((o) => { const id = 'output:' + o.number, n = o.name?.trim() ? o.name : 'output' + o.number
      if (isCanboard) P(id, 'on', n, 'digitaloutput', o.number, 'State')
      else { P(id, 'on', n, 'output', o.number, 'On'); P(id, 'current', n + ' Current', 'output', o.number, 'Current'); P(id, 'oc', n + ' Overcurrent', 'output', o.number, 'Overcurrent'); P(id, 'fault', n + ' Fault', 'output', o.number, 'Fault') } })
    ;(funcs?.canInputs ?? []).forEach((c, k) => { const id = 'caninput:' + (k + 1); P(id, 'state', c.name, 'caninput', k + 1, 'State'); P(id, 'value', c.name + ' Value', 'caninput', k + 1, 'Value') })
    ;(funcs?.virtualInputs ?? []).forEach((c, k) => P('virtualinput:' + (k + 1), 'out', c.name, 'virtualinput', k + 1, 'State'))
    ;(funcs?.flashers ?? []).forEach((c, k) => P('flasher:' + (k + 1), 'out', c.name, 'flasher', k + 1, 'State'))
    ;(funcs?.conditions ?? []).forEach((c, k) => P('condition:' + (k + 1), 'out', c.name + ' Value', 'condition', k + 1, 'Value'))
    ;(funcs?.counters ?? []).forEach((c, k) => P('counter:' + (k + 1), 'out', c.name + ' Value', 'counter', k + 1, 'Value'))
    ;(funcs?.timers ?? []).forEach((c, k) => P('timer:' + (k + 1), 'out', c.name, 'timer', k + 1, 'State'))
    ;(funcs?.tables ?? []).forEach((c, k) => P('table:' + (k + 1), 'out', c.name + ' Value', 'table', k + 1, 'Value'))
    if (funcs?.wiper) { const wn = funcs.wiper.name || 'wiper'
      for (const [port, prop] of [['slow', 'Slow Output'], ['fast', 'Fast Output'], ['park', 'Park Output'], ['inter', 'Inter Output'], ['wash', 'Wash Output'], ['swipe', 'Swipe Output']]) P('wiper', port, wn + ' ' + prop, 'wiper', 1, prop) }
    for (let l = 0; l < 32; l++) P('lua:' + l, 'out', 'Lua Out ' + (l + 1), 'lua', l + 1, 'Value')
    ;(funcs?.keypads ?? []).forEach((kp, ki) => {   // keypad vars are matched by NAME (one owner, many buttons)
      ;(kp.buttons ?? []).forEach((b, bi) => P(`kpbtn:${ki + 1}:${bi + 1}`, 'out', `${kp.name} - ${b.name}`))
      ;(kp.dials ?? []).forEach((d, di) => P(`kpdial:${ki + 1}:${di + 1}`, 'out', `${kp.name} - ${d.name}`))
      for (let a = 0; a < 4; a++) P(`kpain:${ki + 1}:${a + 1}`, 'out', `${kp.name} - analogIn${a}`) })
    return C
  }
  function maps() {
    const byName = {}, byOwner = {}
    for (const v of vmap) { byName[v.name] = v.index; if (v.kind) byOwner[`${v.kind}|${v.number}|${v.prop}`] = v.index }
    const srcToIdx = {}, idxToSrc = {}
    for (const c of catalog()) {
      const ix = (c.fk ? byOwner[`${c.fk}|${c.num}|${c.prop}`] : undefined) ?? byName[c.name]
      if (ix != null) { srcToIdx[c.id + '|' + c.port] = ix; idxToSrc[ix] = { id: c.id, port: c.port } }
    }
    return { srcToIdx, idxToSrc }
  }

  function nodeDef(id) {
    if (id.startsWith('remote:')) {
      const r = remotes.find((x) => 'remote:' + x.srcGuid + ':' + x.srcVar === id)
      return { color: META.remote[0], kind: 'remote', label: r?.label ?? 'remote', sub: r?.devName ?? '', inputs: [], outs: ['out'], inPorts: [], outPorts: [{ id: 'out', label: 'Signal', type: 'bool' }], remote: r?.devName, deletable: true }
    }
    const ci = id.indexOf(':'); const kind = ci < 0 ? id : id.slice(0, ci)
    const rest = ci < 0 ? '' : id.slice(ci + 1)
    const k1 = parseInt(rest, 10)
    const [color, klabel] = META[kind] ?? ['#888', kind]
    let label = id, sub = '', inputs = NODE_INPUTS[kind] ?? [], outs = ['out']
    const nm = (arr, idx) => (funcs?.[arr]?.[idx]?.name) || `${kind}${idx + 1}`
    if (kind === 'sys') {
      // one device node: only the system vars this board actually has (a CANBoard has no temp/battery)
      const { srcToIdx } = maps()
      label = device?.name ?? 'device'; sub = device?.type ?? ''
      outs = ['1', '2', '3', '4'].filter((p) => srcToIdx['sys|' + p] != null)
      // Inputs the module itself takes (device params): force sleep only on a board that can sleep, mute-TX on all.
      if (funcs?.device?.canSleep === false) inputs = ['muteTxInput']
    }
    else if (kind === 'analogin') { label = nm('analogIn', k1 - 1); outs = ['value', 'mv', 'pos', 'switch', 'scaled'] }
    else if (kind === 'digin') label = diginArr()[k1 - 1]?.name || `digitalInput${k1}`
    else if (kind === 'caninput') { label = nm('canInputs', k1 - 1); const c = funcs?.canInputs?.[k1 - 1]; sub = c ? ('0x' + (c.id ?? 0).toString(16)) : ''; outs = ['state', 'value'] }
    else if (kind === 'virtualinput') label = nm('virtualInputs', k1 - 1)
    else if (kind === 'condition') label = nm('conditions', k1 - 1)
    else if (kind === 'counter') label = nm('counters', k1 - 1)
    else if (kind === 'flasher') label = nm('flashers', k1 - 1)
    else if (kind === 'timer') { label = nm('timers', k1 - 1); const c = funcs?.timers?.[k1 - 1]; sub = c ? `${TIMER_MODE[c.mode] ?? ''} · ${((c.preset ?? 0) / 1000).toFixed(1)} s` : '' }
    else if (kind === 'table') { label = nm('tables', k1 - 1); const c = funcs?.tables?.[k1 - 1]; sub = c ? `${c.xSize}×${c.ySize}` : ''; if (c && (c.ySize ?? 1) <= 1) inputs = ['xInput'] }
    else if (kind === 'canoutput') { label = nm('canOutputs', k1 - 1); const c = funcs?.canOutputs?.[k1 - 1]; sub = c ? ('→0x' + (c.id ?? 0).toString(16)) : ''; outs = [] }
    else if (kind === 'output') {
      const o = outputRows().find((x) => x.number === k1)
      label = (isCanboard ? 'DO' : 'O') + k1 + (o?.name?.trim() ? ' ' + o.name : '')
      outs = isCanboard ? ['on'] : ['on', 'current', 'oc', 'fault']   // live state/current shown on the ports + STATUS badge
    }
    else if (kind === 'lua') label = 'Lua Out ' + (k1 + 1)
    else if (kind === 'wiper') { label = funcs?.wiper?.name || 'Wiper'; inputs = []; outs = ['slow', 'fast', 'park', 'inter', 'wash', 'swipe'] }
    else if (kind === 'kpbtn') { const p = rest.split(':'); const kp = funcs?.keypads?.[p[0] - 1]; label = (kp?.name ?? 'KP' + p[0]) + ' ' + (kp?.buttons?.[p[1] - 1]?.name ?? 'btn' + p[1]) }
    else if (kind === 'kpdial') { const p = rest.split(':'); const kp = funcs?.keypads?.[p[0] - 1]; label = (kp?.name ?? 'KP' + p[0]) + ' ' + (kp?.dials?.[p[1] - 1]?.name ?? 'dial' + p[1]) }
    else if (kind === 'kpain') { const p = rest.split(':'); label = (funcs?.keypads?.[p[0] - 1]?.name ?? 'KP' + p[0]) + ' analogIn' + (p[1] - 1) }
    const mk = (ids) => ids.map((pid) => ({ id: pid, label: PORT_LABEL[kind]?.[pid] ?? pid, type: portType(kind, pid) }))
    return { color, kind: klabel, label, sub, inputs, outs, inPorts: mk(inputs), outPorts: mk(outs),
      deletable: DELETABLE.has(kind), renamable: !!fnKindOf(kind) }
  }

  // Live values + status badge for a node, from the telemetry poll (liveSig) and output telemetry.
  function valuesFor(id) {
    const ci = id.indexOf(':'); const kind = ci < 0 ? id : id.slice(0, ci); const k1 = parseInt(id.slice(ci + 1), 10) || 0
    if (kind === 'sys') {
      return { values: { 1: 'on', 2: device?.state ?? '', 3: device?.temp != null ? (+device.temp).toFixed(1) : '', 4: device?.battery != null ? (+device.battery).toFixed(1) : '' } }
    }
    if (kind === 'output') {
      const o = (device?.outputs ?? []).find((x) => x.number === k1)
      if (o) {   // PDM smart output — state + current from device telemetry
        const pwm = o.pwmEnabled && o.state === 'On'
        return { status: { text: String(o.state ?? '').toUpperCase() + (pwm ? ` · ${o.duty}%` : ''), tone: o.state },
          values: { on: String(o.state ?? ''), current: (o.current ?? 0).toFixed(1) } }   // unit lives in the label "Current (A)"
      }
      // CANBoard low-side output — live state (and PWM duty) come from the named signal poll.
      const cfg = funcs?.digitalOut?.[k1 - 1]; const s = cfg ? (liveSig['Digital output|' + cfg.name] ?? liveSig[cfg.name]) : null
      if (!s) return { values: {}, status: null }
      const dutyTxt = cfg.pwmEnabled ? ` · ${s.value}%` : ''
      return { status: { text: (s.on ? 'ON' : 'OFF') + (s.on ? dutyTxt : ''), tone: s.on ? 'On' : '' },
        values: { on: s.on ? 'on' : 'off' } }
    }
    if (kind === 'digin') {
      const nm = diginArr()[k1 - 1]?.name; const s = nm ? (liveSig['Digital input|' + nm] ?? liveSig[nm]) : null
      return { values: { out: s ? (s.on ? 'on' : 'off') : '' }, status: s ? { text: s.on ? 'ON' : 'OFF', tone: s.on ? 'on' : '' } : null }
    }
    if (kind === 'analogin') {
      const nm = funcs?.analogIn?.[k1 - 1]?.name; if (!nm) return { values: {} }
      return { values: { mv: (liveSig['Analog input|' + nm] ?? liveSig[nm])?.value ?? '', pos: liveSig[nm + ' Pos']?.value ?? '', switch: liveSig[nm + ' Switch']?.on ? 'on' : 'off' } }
    }
    const arr = SIGARR[kind]
    if (arr) {
      const nm = funcs?.[arr]?.[k1 - 1]?.name; const s = nm ? (liveSig[SIGKIND[kind] + '|' + nm] ?? liveSig[nm]) : null
      if (kind === 'caninput') return { values: { state: s ? (s.on ? 'on' : 'off') : '', value: s ? s.value : '' } }
      if (!s) return { values: {} }
      return { values: { out: (kind === 'counter' || kind === 'table') ? s.value : (s.on ? 'on' : 'off') } }
    }
    return { values: {} }
  }
  // Push live readouts into the store (no node reassignment → handles/DOM stay put). Wires carrying
  // a true boolean light up (animated green) — only `edges` is reassigned, and only when one changes.
  function pushLive() {
    const m = {}; for (const n of nodes) m[n.id] = valuesFor(n.id); fnLive.set(m)
    let changed = false
    const next = edges.map((e) => {
      const on = String(m[e.source]?.values?.[e.sourceHandle] ?? '').toLowerCase() === 'on'
      if (on === !!e.animated) return e
      changed = true
      return { ...e, animated: on, style: on ? EDGE_ON : EDGE_OFF }
    })
    if (changed) edges = next
  }

  function build() {
    const outputs = outputRows()
    const { idxToSrc } = maps()
    const E = []
    const addEdge = (targetId, field, srcIdx) => {
      if (!srcIdx || srcIdx <= 0) return
      const s = idxToSrc[srcIdx]; if (!s) return
      E.push({ id: targetId + ':' + field, source: s.id, sourceHandle: s.port, target: targetId, targetHandle: field, animated: false, style: EDGE_OFF })
    }
    for (const o of outputs) { addEdge('output:' + o.number, 'input', o.input); addEdge('output:' + o.number, 'dutyCycleInput', o.dutyCycleInput); addEdge('output:' + o.number, 'freqInput', o.freqInput) }
    ;(funcs?.conditions ?? []).forEach((c, k) => { if (c.enabled) addEdge('condition:' + (k + 1), 'input', c.input) })
    ;(funcs?.flashers ?? []).forEach((c, k) => { if (c.enabled) addEdge('flasher:' + (k + 1), 'input', c.input) })
    ;(funcs?.timers ?? []).forEach((c, k) => { if (c.enabled) addEdge('timer:' + (k + 1), 'input', c.input) })
    ;(funcs?.tables ?? []).forEach((c, k) => { if (c.enabled) { addEdge('table:' + (k + 1), 'xInput', c.xInput); if ((c.ySize ?? 1) > 1) addEdge('table:' + (k + 1), 'yInput', c.yInput) } })
    ;(funcs?.canOutputs ?? []).forEach((c, k) => { if (c.enabled) addEdge('canoutput:' + (k + 1), 'input', c.input) })
    ;(funcs?.virtualInputs ?? []).forEach((c, k) => { if (c.enabled) { addEdge('virtualinput:' + (k + 1), 'var0', c.var0); addEdge('virtualinput:' + (k + 1), 'var1', c.var1); addEdge('virtualinput:' + (k + 1), 'var2', c.var2) } })
    ;(funcs?.counters ?? []).forEach((c, k) => { if (c.enabled) { addEdge('counter:' + (k + 1), 'incInput', c.incInput); addEdge('counter:' + (k + 1), 'decInput', c.decInput); addEdge('counter:' + (k + 1), 'resetInput', c.resetInput) } })
    addEdge('sys', 'forceSleepInput', funcs?.device?.forceSleepInput); addEdge('sys', 'muteTxInput', funcs?.device?.muteTxInput)   // the module's own inputs

    const ids = new Set(['sys'])
    ;diginArr().forEach((_, k) => ids.add('digin:' + (k + 1)))
    ;(funcs?.analogIn ?? []).forEach((_, k) => ids.add('analogin:' + (k + 1)))
    for (const o of outputs) ids.add('output:' + o.number)
    const en = (arr, pfx) => (funcs?.[arr] ?? []).forEach((c, k) => { if (c.enabled) ids.add(pfx + (k + 1)) })
    en('canInputs', 'caninput:'); en('virtualInputs', 'virtualinput:'); en('conditions', 'condition:')
    en('counters', 'counter:'); en('flashers', 'flasher:'); en('timers', 'timer:'); en('tables', 'table:'); en('canOutputs', 'canoutput:')
    for (const r of remotes) ids.add('remote:' + r.srcGuid + ':' + r.srcVar)
    for (const e of E) { ids.add(e.source); ids.add(e.target) }   // a disabled source still wired somewhere stays visible

    const saved = loadPos(); const colY = {}   // per-column running Y — height-aware so tall nodes don't overlap
    nodes = [...ids].map((id) => {
      const kind = id.split(':')[0]; const col = COL[kind] ?? 1
      const def = nodeDef(id); const vf = valuesFor(id)
      const rows = Math.max(def.inPorts.length, def.outPorts.length)
      const h = 22 + (def.sub ? 13 : 0) + rows * 18 + (vf.status ? 20 : 0) + 12   // matches FnNode geometry
      let pos
      if (saved[id]) pos = saved[id]
      else { const y = colY[col] ?? 20; pos = { x: col * 360 + 20, y }; colY[col] = y + h + 22 }
      const k1n = parseInt(id.slice(id.indexOf(':') + 1), 10) || 0
      return { id, type: 'fn', position: pos, deletable: def.deletable, data: { ...def, ...vf, fnLive, onDelete: () => deleteNode(id), onRename: def.renamable ? (name) => renameNode(id, name) : null, onSettings: SETTINGS_KIND[kind] ? () => openSettings(kind, k1n) : null } }
    })
    edges = E
    pushLive()
  }

  // Gear button: open this item's editor inline (PDM smart outputs → the Outputs tab, via the parent).
  function openSettings(kind, num) {
    if (kind === 'output' && !isCanboard) { onOpenSettings?.('output', num); return }
    inlineTarget = { kind: kind === 'output' ? 'digitaloutput' : SETTINGS_KIND[kind], number: num, n: ++targetNonce, nodeId: `${kind}:${num}` }
  }

  // Live telemetry poll → patch node values/status (the "instrument" readouts).
  $effect(() => {
    const g = guid
    if (!g) { liveSig = {}; return }
    let alive = true
    const tick = async () => {
      try {
        const s = await api.signals(g)
        if (!alive) return
        // Keyed by kind|name — a CAN input and an output both called “Horn” used to share one slot (the CAN block showed the output's state).
        const m = {}; for (const x of s) { const e = { value: x.value, on: x.on }; m[x.kind + '|' + x.name] = e; if (!(x.name in m)) m[x.name] = e }
        liveSig = m
        if (nodes.length) pushLive()   // update readouts via the store — never recreates nodes/handles
      } catch {}
    }
    tick(); const idv = setInterval(tick, 500)
    return () => { alive = false; clearInterval(idv) }
  })

  async function load() {
    if (!device?.guid) return
    try { remotes = JSON.parse(localStorage.getItem(remKey()) || '[]') } catch { remotes = [] }
    try {
      ;[funcs, vmap] = await Promise.all([api.functions(device.guid), api.inputs(device.guid).catch(() => [])])
      await loadSrcLists()
      build()
    } catch (e) { msg = 'load failed: ' + e.message }
  }
  // Typed source lists for the circuit builder pickers — refreshed on load and after a remote/ECU
  // signal is pulled in (so the new CAN input shows a label, not a bare index).
  async function loadSrcLists() {
    boolSrc = await api.inputs(device.guid, 'bool').catch(() => [])
    numSrc = [...await api.inputs(device.guid, 'float').catch(() => []), ...await api.inputs(device.guid, 'int').catch(() => [])]
  }
  $effect(() => { if (guid) untrack(load) })   // once per module, not once per telemetry push

  // Add menu: only kinds this board has, with the free-slot count (greyed when none left).
  const freeCount = (kind) => (funcs?.[KIND_ARR[kind]] ?? []).filter((x) => !x.enabled).length
  let addable = $derived(ADDABLE.filter(([k]) => funcs?.[KIND_ARR[k]] !== undefined).map(([k, l]) => [k, l, freeCount(k)]))

  // Enable the source function when it's wired (a disabled source produces nothing). sys/lua/keypad
  // have no enable → skipped. Toasts so the user sees it happened.
  async function enableSource(sourceId) {
    const ci = sourceId.indexOf(':'); const kind = ci < 0 ? sourceId : sourceId.slice(0, ci)
    const k = fnKindOf(kind); if (!k) return
    const num = parseInt(sourceId.slice(ci + 1), 10) || 0
    const arr = { input: 'inputs', analoginput: 'analogIn', caninput: 'canInputs', virtualinput: 'virtualInputs', condition: 'conditions', counter: 'counters', flasher: 'flashers', timer: 'timers', table: 'tables', canoutput: 'canOutputs', digitaloutput: 'digitalOut' }[k]
    const row = (k === 'input' ? diginArr() : funcs?.[arr])?.[num - 1]
    if (row && row.enabled === false) {
      await api.setFunction(device.guid, k, num, { enabled: true })
      msg = `enabled source ${row.name ?? sourceId} (was off)`
    }
  }
  // Rename a node's underlying function (label only — merges via partial setFunction).
  async function renameNode(id, name) {
    const ci = id.indexOf(':'); const kind = id.slice(0, ci); const num = parseInt(id.slice(ci + 1), 10) || 0
    const k = fnKindOf(kind); if (!k || !name?.trim()) return
    try { await api.setFunction(device.guid, k, num, { name: name.trim() }); await load(); msg = `renamed → ${name.trim()}` }
    catch (e) { msg = 'rename failed: ' + e.message; toast(msg, 'error') }
  }

  // Write one target input. CANBoard low-side outputs are functions (digitaloutput), PDM smart outputs
  // go through outputconfig. Wiring a duty/freq source switches that output to variable PWM (PWM on);
  // unwiring turns the mode off and drops PWM unless the other variable mode is still wired.
  const outputPwmOn = (num) => isCanboard ? !!funcs?.digitalOut?.[num - 1]?.pwmEnabled : !!(device?.outputs ?? []).find((x) => x.number === num)?.pwmEnabled
  async function wireTarget(targetId, field, idx) {
    const ci = targetId.indexOf(':'); const kind = targetId.slice(0, ci); const num = parseInt(targetId.slice(ci + 1), 10)
    if (kind === 'output' && isCanboard) {
      const o = funcs?.digitalOut?.[num - 1] ?? {}
      const body = { enabled: true, [field]: idx }
      const otherVar = field === 'dutyCycleInput' ? (o.variableFreq && o.freqInput > 0) : (o.variableDutyCycle && o.dutyCycleInput > 0)
      if (field === 'dutyCycleInput') Object.assign(body, { variableDutyCycle: idx > 0, pwmEnabled: idx > 0 || !!otherVar })
      if (field === 'freqInput') Object.assign(body, { variableFreq: idx > 0, pwmEnabled: idx > 0 || !!otherVar })
      await api.setFunction(device.guid, 'digitaloutput', num, body)
      return
    }
    await applyGraphConnection(device.guid, targetId, field, idx, devices)
  }

  // Type-check a wire before svelte-flow accepts it (the dots fade for handles that can't take it).
  function isValidConnection(c) {
    const sk = c.source.split(':')[0], tk = c.target.split(':')[0]
    const st = sk === 'remote' ? 'bool' : portType(sk, c.sourceHandle)
    return canConnect(st, portType(tk, c.targetHandle))
  }

  async function onconnect(conn) {
    const field = conn.targetHandle
    try {
      let srcIdx
      if (conn.source.startsWith('remote:')) {
        msg = 'bridging remote signal over CAN…'
        const r = remotes.find((x) => 'remote:' + x.srcGuid + ':' + x.srcVar === conn.source)
        srcIdx = await bridgeRemoteSignal(device.guid, r.srcGuid, r.srcVar, devices)
        if (srcIdx == null) { msg = 'bridge failed (no free CAN in/out slot)'; return }
      } else {
        const { srcToIdx } = maps()
        srcIdx = srcToIdx[conn.source + '|' + conn.sourceHandle]
      }
      // The module's own always-true signals can't drive its sleep/mute inputs (the module would park 1 s after
      // every boot, or mute itself for good) — same guard as System ▸ Settings, said before any wire is drawn.
      if (conn.target === 'sys' && conn.source === 'sys') {
        msg = `${PORT_LABEL.sys[conn.sourceHandle] ?? conn.sourceHandle} is always true on a running module — it can't be its ${PORT_LABEL.sys[field] ?? field} input; use a digital input, CAN input or Timer`
        toast(msg, 'error'); return
      }
      if (srcIdx == null) {   // a port this board's var map doesn't publish — say so instead of silently dropping the wire
        msg = `${nodeDef(conn.source).label} · ${PORT_LABEL[conn.source.split(':')[0]]?.[conn.sourceHandle] ?? conn.sourceHandle} isn't in this module's var map — it can't drive anything`
        toast(msg, 'error'); return
      }
      // Wiring a duty/freq source turns the output into a PWM output — a hardware-behaviour change
      // (chopped supply to the load). Confirm it the first time, like the Outputs drawer's PWM tick.
      if ((field === 'dutyCycleInput' || field === 'freqInput') && conn.target.startsWith('output:')) {
        const n = parseInt(conn.target.slice(7), 10)
        if (!outputPwmOn(n) && !confirm(`Wiring a ${field === 'dutyCycleInput' ? 'duty' : 'frequency'} source switches ${nodeDef(conn.target).label} to PWM (chopped output to the load). It goes back to plain on/off when you unwire it. Continue?`)) return
      }
      edges = [...edges.filter((e) => !(e.target === conn.target && e.targetHandle === field)),
        { id: conn.target + ':' + field, source: conn.source, sourceHandle: conn.sourceHandle, target: conn.target, targetHandle: field, animated: false, style: EDGE_OFF }]
      await wireTarget(conn.target, field, srcIdx)
      if (!conn.source.startsWith('remote:')) await enableSource(conn.source)   // a disabled source produces nothing
      msg = live ? `wired → ${conn.target}.${field} (Burn to keep)`
                 : `wired → ${conn.target}.${field} — saved to the project; connect + Deploy to apply`
      if (conn.source.startsWith('remote:') || field !== 'input') await load()   // new CAN-in node / PWM state changed
      else pushLive()
    } catch (e) { msg = 'write failed: ' + e.message; toast(msg, 'error'); await load() }   // drop the optimistic wire
  }
  // Every consumer input wired FROM this node's output ports: [targetId, field]. Used both to warn
  // before a delete and to clear those inputs — otherwise a disabled source still has consumers
  // pointing at its VarMap index, the edge is re-drawn, and the node reappears.
  function consumersOf(id) {
    const { srcToIdx } = maps()
    const def = nodeDef(id)
    const idxs = new Set(def.outPorts.map((p) => srcToIdx[id + '|' + p.id]).filter((x) => x != null && x > 0))
    const clears = []
    if (!idxs.size) return clears
    for (const o of outputRows()) for (const f of ['input', 'dutyCycleInput', 'freqInput']) if (idxs.has(o[f])) clears.push(['output:' + o.number, f])
    ;(funcs?.conditions ?? []).forEach((c, k) => { if (c.enabled && idxs.has(c.input)) clears.push(['condition:' + (k + 1), 'input']) })
    ;(funcs?.flashers ?? []).forEach((c, k) => { if (c.enabled && idxs.has(c.input)) clears.push(['flasher:' + (k + 1), 'input']) })
    ;(funcs?.timers ?? []).forEach((c, k) => { if (c.enabled && idxs.has(c.input)) clears.push(['timer:' + (k + 1), 'input']) })
    ;(funcs?.tables ?? []).forEach((c, k) => { if (c.enabled) for (const f of ['xInput', 'yInput']) if (idxs.has(c[f])) clears.push(['table:' + (k + 1), f]) })
    ;(funcs?.canOutputs ?? []).forEach((c, k) => { if (c.enabled && idxs.has(c.input)) clears.push(['canoutput:' + (k + 1), 'input']) })
    ;(funcs?.virtualInputs ?? []).forEach((c, k) => { if (c.enabled) for (const f of ['var0', 'var1', 'var2']) if (idxs.has(c[f])) clears.push(['virtualinput:' + (k + 1), f]) })
    ;(funcs?.counters ?? []).forEach((c, k) => { if (c.enabled) for (const f of ['incInput', 'decInput', 'resetInput']) if (idxs.has(c[f])) clears.push(['counter:' + (k + 1), f]) })
    for (const f of ['forceSleepInput', 'muteTxInput']) if (idxs.has(funcs?.device?.[f])) clears.push(['sys', f])
    return clears
  }
  async function unwireConsumers(id) { for (const [t, f] of consumersOf(id)) await wireTarget(t, f, 0) }
  // Confirm before disabling blocks that other inputs still use (upstream-style "N input(s) will be disconnected").
  function confirmRemove(ids) {
    const real = ids.filter((id) => !id.startsWith('remote:') && DELETABLE.has(id.split(':')[0]))
    if (!real.length) return true
    const refs = real.reduce((n, id) => n + consumersOf(id).length, 0)
    const names = real.map((id) => nodeDef(id).label).join(', ')
    return confirm(`Disable ${names}?` + (refs ? ` ${refs} input(s) wired from it will be disconnected.` : ''))
  }
  // Delete a single block: drop wires from it, disable its function (or drop a remote signal), refresh.
  async function deleteNode(id) {
    try {
      if (id.startsWith('remote:')) { remotes = remotes.filter((r) => 'remote:' + r.srcGuid + ':' + r.srcVar !== id); saveRemotes() }
      else {
        const ci = id.indexOf(':'); const kind = id.slice(0, ci); const num = parseInt(id.slice(ci + 1), 10)
        if (!DELETABLE.has(kind)) { msg = 'this block is physical — can’t delete'; return }
        if (!confirmRemove([id])) return
        await unwireConsumers(id); await api.setFunction(device.guid, kind, num, { enabled: false })
      }
      if (inlineTarget?.nodeId === id) inlineTarget = null   // the block being edited is gone
      msg = 'deleted ' + id; await load()
    } catch (e) { msg = 'delete failed: ' + e.message; toast(msg, 'error') }
  }
  // Delete-key path: svelte-flow asks first (onbeforedelete), then tells us what went (ondelete).
  const onbeforedelete = async ({ nodes: dn }) => confirmRemove((dn ?? []).map((n) => n.id))
  async function ondelete({ nodes: dn, edges: de }) {
    try {
      for (const e of (de ?? [])) await wireTarget(e.target, e.targetHandle, 0)
      for (const n of (dn ?? [])) {
        if (n.id.startsWith('remote:')) { remotes = remotes.filter((r) => 'remote:' + r.srcGuid + ':' + r.srcVar !== n.id); saveRemotes() }
        else { const ci = n.id.indexOf(':'); const kind = n.id.slice(0, ci); const num = parseInt(n.id.slice(ci + 1), 10); if (DELETABLE.has(kind)) { await unwireConsumers(n.id); await api.setFunction(device.guid, kind, num, { enabled: false }) } }
        if (inlineTarget?.nodeId === n.id) inlineTarget = null
      }
      msg = `deleted ${(dn ?? []).length} block(s) · ${(de ?? []).length} wire(s)`
    } catch (e) { msg = 'delete failed: ' + e.message; toast(msg, 'error') }
    await load()
  }

  // Add a block: claim the first free slot, drop it near the viewport centre and open its editor.
  async function addNode(kind) {
    try {
      const id = await enableFunction(device.guid, kind)
      if (!id) { msg = `no free ${kind} slot — disable one you don't use`; toast(msg, 'error'); return }
      await load(); msg = `added ${id} — set it up in the editor below`
      openSettings(kind, parseInt(id.slice(id.indexOf(':') + 1), 10))
    }
    catch (e) { msg = 'add failed: ' + e.message; toast(msg, 'error') }
  }

  function openRemote() { remoteOpen = true; remoteSearch = ''; remoteDev = devices.find((d) => d.guid !== device.guid)?.guid ?? '' }
  // Load the chosen source's signals: a DBC/ECU searches server-side (huge counts); a module lists its
  // varmap (which the grab then bridges over CAN). Reactive on the module + the DBC search term.
  $effect(() => {
    if (!remoteOpen || !remoteDev) { remoteSignals = []; return }
    const dbc = remoteIsDbc, g = remoteDev, term = remoteSearch
    let alive = true
    if (dbc) api.dbcSearch(g, term, 100).then((r) => { if (alive) { remoteSignals = r.items ?? []; dbcMore = !!r.more } }).catch(() => { if (alive) remoteSignals = [] })
    else api.inputs(g, 'bool').then((s) => { if (alive) remoteSignals = s }).catch(() => { if (alive) remoteSignals = [] })   // bool, configured: the bridge carries one bit
    return () => { alive = false }
  })
  function grabRemote(sig) {
    if (remotes.some((r) => r.srcGuid === remoteDev && r.srcVar === sig.index)) { remoteOpen = false; return }
    remotes = [...remotes, { srcGuid: remoteDev, srcVar: sig.index, label: sig.name, devName: dName(remoteDev) }]
    saveRemotes(); build(); remoteOpen = false
  }
  // ECU/DBC source: decode the chosen signal straight into a local CAN input (it already broadcasts),
  // then reload so the new CAN-input node appears in the graph, ready to wire to a target.
  async function grabDbc(sig) {
    try {
      const r = await addCanInputFromDbc(device.guid, sig)
      remoteOpen = false; remoteSearch = ''
      await load()
      msg = live ? `added CAN input “${r.name}” decoding ${hex(sig.id)} — drag it to a target, then Burn`
                 : `added CAN input “${r.name}” — saved to the project; connect + Deploy to apply`
    } catch (e) { msg = 'add failed: ' + e.message; toast(msg, 'error') }
  }

  // ===== Circuit Builders =====================================================================
  // Data-driven wizards that scaffold + auto-wire a set of functions. Each builder declares its
  // fields; build(ctx, sel) creates Conditions/Flashers/VirtualInputs and wires the outputs.
  let boolSrc = $state([]), numSrc = $state([])   // typed source lists (bool triggers / numeric)
  let bOpen = $state(false), bKey = $state(''), bSel = $state({}), bBusy = $state(false), bMsg = $state('')
  const bOps = [{ v: 2, t: 'greater than' }, { v: 3, t: 'less than' }, { v: 4, t: '≥' }, { v: 5, t: '≤' }, { v: 0, t: 'equals' }]
  // Outputs the builder can target: PDM smart outputs (device.outputs) OR CANBoard digital outputs.
  const builderOutputs = $derived(device?.outputs?.length ? device.outputs : (funcs?.digitalOut ?? []))
  const bOutName = (n) => builderOutputs.find((o) => o.number === +n)?.name?.trim() || ('output' + n)
  const And = 0, Or = 1   // BoolOperator

  const BUILDERS = [
    { key: 'simple', name: 'Simple switched circuit', desc: 'One input drives one output directly.',
      fields: [{ k: 'input', t: 'bool', label: 'Driven by' }, { k: 'output', t: 'out', label: 'Output' }],
      build: async (ctx, s) => { await ctx.wireOutput(s.output, +s.input) } },
    { key: 'analog', name: 'Analog triggered switch', desc: 'Output turns on when an analog signal crosses a threshold (creates a Condition).',
      fields: [{ k: 'analog', t: 'num', label: 'Analog signal' }, { k: 'op', t: 'op', label: 'Turn on when it is' }, { k: 'thr', t: 'number', label: 'Threshold', def: 0 }, { k: 'output', t: 'out', label: 'Output' }],
      build: async (ctx, s) => { const c = await ctx.condition(+s.analog, +s.op, +s.thr, 'CB ' + bOutName(s.output)); await ctx.wireOutput(s.output, c) } },
    { key: 'blinker', name: 'Blinker / hazard', desc: 'Left/right (+ optional hazard) blink two outputs. Optional US mode where the rear light is also the brake light (turn signal overrides brake on that side); the high-mount 3rd brake stays independent.',
      fields: [{ k: 'left', t: 'bool', label: 'Left trigger' }, { k: 'right', t: 'bool', label: 'Right trigger' },
        { k: 'hazard', t: 'bool', label: 'Hazard trigger', opt: true }, { k: 'leftOut', t: 'out', label: 'Left output' },
        { k: 'rightOut', t: 'out', label: 'Right output' }, { k: 'rate', t: 'number', label: 'Blink rate (ms, max 5000)', def: 400, min: 0, max: 5000 },
        { k: 'us', t: 'check', label: 'US: rear lamp is also the brake light' },
        { k: 'brake', t: 'bool', label: 'Brake input (US mode)', opt: true }, { k: 'brake3', t: 'out', label: '3rd (high-mount) brake output', opt: true }],
      build: async (ctx, s) => {
        const fl = await ctx.flasher(ctx.alwaysOn(), +s.rate, +s.rate, 'CB Blink')
        const haz = s.hazard ? +s.hazard : 0
        const us = !!s.us && s.brake, brake = s.brake ? +s.brake : 0
        const side = async (trig, nm) => {
          const turn = await ctx.anyOf([+trig, haz], 'CB ' + nm + ' Turn')        // trig OR hazard (passthrough if no hazard)
          if (us) {
            const t1 = await ctx.anyOf([brake, turn], 'CB ' + nm + ' On')         // brake OR turning
            const t2 = await ctx.virtual({ v0: fl, op0: Or, v1: turn, not1: true }, 'CB ' + nm + ' Phase') // blink OR not-turning
            return ctx.virtual({ v0: t1, op0: And, v1: t2 }, 'CB ' + nm)          // → turning blinks, else solid on brake
          }
          return ctx.virtual({ v0: turn, op0: And, v1: fl }, 'CB ' + nm)          // turning AND blink
        }
        await ctx.wireOutput(s.leftOut, await side(s.left, 'Left'))
        await ctx.wireOutput(s.rightOut, await side(s.right, 'Right'))
        if (us && s.brake3) await ctx.wireOutput(s.brake3, brake)                 // independent high-mount brake
      } },
    { key: 'fuelpump', name: 'Fuel pump', desc: 'Primes on power-up for a moment, then runs while the engine is turning (a run signal — e.g. RPM — above a threshold).',
      fields: [{ k: 'run', t: 'num', label: 'Run signal (e.g. RPM)' }, { k: 'thr', t: 'number', label: 'Running above', def: 300 },
        { k: 'prime', t: 'number', label: 'Prime time (ms, max 1 h)', def: 3000, min: 0, max: 3600000 }, { k: 'output', t: 'out', label: 'Pump output' }],
      build: async (ctx, s) => {
        const run = await ctx.condition(+s.run, 2, +s.thr, 'CB FuelRun')                  // run signal > threshold
        const prime = await ctx.timer(ctx.alwaysOn(), 2, +s.prime, 'CB Prime')             // one pulse at power-up (Timer, pulse mode)
        await ctx.wireOutput(s.output, await ctx.virtual({ v0: run, op0: Or, v1: prime }, 'CB FuelPump'))
      } },
    { key: 'wipers', name: 'Wipers (low / high / intermittent)', desc: 'Low/High run the wiper output; Intermittent pulses it on a gap. Combines whatever you provide.',
      fields: [{ k: 'low', t: 'bool', label: 'Low / On' }, { k: 'high', t: 'bool', label: 'High', opt: true },
        { k: 'int', t: 'bool', label: 'Intermittent', opt: true }, { k: 'intRate', t: 'number', label: 'Intermittent gap (ms, max 5000)', def: 3000, min: 0, max: 5000 },
        { k: 'output', t: 'out', label: 'Wiper output' }],
      build: async (ctx, s) => {
        const flInt = s.int ? await ctx.flasher(+s.int, 700, +s.intRate, 'CB WipeInt') : 0
        const drv = await ctx.anyOf([+s.low, s.high ? +s.high : 0, flInt], 'CB Wipers')
        await ctx.wireOutput(s.output, drv)
      } },
    { key: 'afterrun', name: 'After-run (stay on after switch-off)', desc: 'Output follows a trigger and keeps running for a hold time after it drops — radiator fan or turbo cooling after ignition off, courtesy light after the door closes (creates an off-delay Timer).',
      fields: [{ k: 'trig', t: 'bool', label: 'Trigger' }, { k: 'hold', t: 'number', label: 'Hold after off (ms, max 1 h)', def: 60000, min: 0, max: 3600000 }, { k: 'output', t: 'out', label: 'Output' }],
      build: async (ctx, s) => { await ctx.wireOutput(s.output, await ctx.timer(+s.trig, 1, +s.hold, 'CB ' + bOutName(s.output) + ' Hold')) } },
    { key: 'pwmfan', name: 'PWM fan (duty from analog)', desc: 'Fan output runs PWM with its duty following an analog signal (e.g. a temp sensor), with soft start. CANBoard outputs only — set a PDM output’s variable duty in its output editor.',
      fields: [{ k: 'analog', t: 'num', label: 'Duty source (e.g. temperature)' }, { k: 'full', t: 'number', label: 'Signal value at 100% duty', def: 5000 },
        { k: 'min', t: 'number', label: 'Min duty (%)', def: 0 }, { k: 'freq', t: 'number', label: 'PWM frequency (Hz)', def: 200 }, { k: 'output', t: 'out', label: 'Fan output' }],
      build: async (ctx, s) => { await ctx.setOutputPwm(s.output, { source: +s.analog, full: +s.full, min: +s.min, freq: +s.freq }) } },
  ]
  const curBuilder = $derived(BUILDERS.find((b) => b.key === bKey))

  function openBuilder(key) {
    bKey = key; bMsg = ''
    const b = BUILDERS.find((x) => x.key === key)
    bSel = {}; for (const f of b.fields) bSel[f.k] = f.def ?? ''
    bOpen = true
  }
  // ctx helpers — each create returns the new function's OUTPUT varmap index, ready to wire.
  async function bRefresh() { funcs = await api.functions(device.guid); vmap = await api.inputs(device.guid).catch(() => vmap) }
  function bIdx(nodeId) { return maps().srcToIdx[nodeId + '|out'] }
  function bFree(arr) { const s = (funcs?.[arr] ?? []).find((x) => !x.enabled); if (!s) throw new Error(`No free ${arr} slots`); return s.number }
  // Firmware ranges (core/param_defs.h): flasher on/off 0..5000 ms, timer preset 0..3600000 ms. A number
  // field with step="any" can emit 60000.5, and the device NAKs anything out of range — round + clamp
  // here so "built" means the device really got it.
  const ms = (v, max) => Math.min(max, Math.max(0, Math.round(+v || 0)))
  const builderCtx = {
    alwaysOn: () => vmap.find((v) => v.name === 'Always On')?.index ?? 1,
    wireOutput: (outNum, srcIdx) => wireTarget('output:' + outNum, 'input', srcIdx),
    condition: async (input, op, arg, name) => { const n = bFree('conditions'); await api.setFunction(device.guid, 'condition', n, { enabled: true, input, operator: op, arg: +arg || 0, name }); await bRefresh(); return bIdx('condition:' + n) },
    flasher: async (input, onTime, offTime, name, single = false) => { const n = bFree('flashers'); await api.setFunction(device.guid, 'flasher', n, { enabled: true, input, onTime: ms(onTime, 5000), offTime: ms(offTime, 5000), single, name }); await bRefresh(); return bIdx('flasher:' + n) },
    // mode: 0 on-delay, 1 off-delay, 2 pulse (firmware TimerMode)
    timer: async (input, mode, preset, name) => { const n = bFree('timers'); await api.setFunction(device.guid, 'timer', n, { enabled: true, input, mode, edge: 0, preset: ms(preset, 3600000), name }); await bRefresh(); return bIdx('timer:' + n) },
    virtual: async (c, name) => { const n = bFree('virtualInputs'); await api.setFunction(device.guid, 'virtualinput', n, { enabled: true, not0: !!c.not0, var0: c.v0 ?? 0, cond0: c.op0 ?? And, not1: !!c.not1, var1: c.v1 ?? 0, cond1: c.op1 ?? And, not2: !!c.not2, var2: c.v2 ?? 0, mode: 0, name }); await bRefresh(); return bIdx('virtualinput:' + n) },
    // OR-combine a list of source vars (1→passthrough, 2/3→one VirtualInput). >3 not supported.
    anyOf: async (vars, name) => { const v = vars.filter((x) => x > 0); if (v.length <= 1) return v[0] ?? 0; return builderCtx.virtual({ v0: v[0], op0: Or, v1: v[1], op1: Or, v2: v[2] ?? 0 }, name) },
    // Configure a CANBoard digital output for variable-duty PWM from an analog source + soft start.
    setOutputPwm: async (outNum, { source, full, min, freq, on }) => {
      if (!isCanboard) throw new Error('PWM-from-analog is wired on CANBoard outputs; for a PDM output set it in the output editor')
      await api.setFunction(device.guid, 'digitaloutput', outNum, { enabled: true, input: on ?? builderCtx.alwaysOn(), pwmEnabled: true, variableDutyCycle: true, dutyCycleInput: source, dutyCycleDenominator: Math.max(1, Math.round(full / 100)), minDutyCycle: min, frequency: freq, softStartEnabled: true, softStartRampTime: 500 })
    },
  }
  async function applyBuilder() {
    if (!curBuilder) return
    const missing = curBuilder.fields.filter((f) => !f.opt && f.t !== 'check' && (bSel[f.k] === '' || bSel[f.k] == null))
    if (missing.length) { bMsg = 'Fill in: ' + missing.map((f) => f.label).join(', '); return }
    const bad = curBuilder.fields.find((f) => f.t === 'number' && f.max != null && (+bSel[f.k] < (f.min ?? 0) || +bSel[f.k] > f.max))
    if (bad) { bMsg = `${bad.label}: must be ${bad.min ?? 0}–${bad.max} (the module rejects anything outside).`; return }
    bBusy = true; bMsg = ''
    try {
      await curBuilder.build(builderCtx, bSel)
      await load()
      localStorage.removeItem(posKey()); build()   // re-layout so the new blocks are visible
      bOpen = false
      msg = `built “${curBuilder.name}” — Burn to keep`
    } catch (e) { bMsg = 'Failed: ' + e.message; toast(bMsg, 'error') }
    finally { bBusy = false }
  }
</script>

<div class="h-row">
  <div><h1>{device?.name ?? '—'} · Wiring</h1>
    <p class="sub">Drag from an <b>output ●</b> (right) to an <b>input ●</b> (left) — dots are coloured by type (<span class="tyb">bool</span> · <span class="tyi">int</span> · <span class="tyr">real</span>); while you drag, the dot under the cursor rings <b style="color:#34d27b">green</b> if the types fit and <b style="color:#e5484d">red</b> if not, and a mismatched wire won't land. Wires glow green while their signal is on. <b>⚙</b> on a block edits it right here; <b>✕</b> or Delete removes it (you're asked if anything still uses it); then <b>Burn</b> to keep. {#if msg}— <b>{msg}</b>{/if}{#if !live}<br><span class="muted">Module offline — wiring saves to the project; connect + Deploy to apply it.</span>{/if}</p></div>
  <div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <select onchange={(e) => { if (e.target.value) { openBuilder(e.target.value); e.target.value = '' } }} style="font-size:13px" title="Scaffold a ready-made circuit">
      <option value="">⚡ Circuit builder…</option>
      {#each BUILDERS as b}<option value={b.key}>{b.name}</option>{/each}
    </select>
    <select onchange={(e) => { if (e.target.value) { addNode(e.target.value); e.target.value = '' } }} style="font-size:13px" title="Add a logic block (claims a free slot and opens its editor)">
      <option value="">+ Add block…</option>
      {#each addable as [k, l, free]}<option value={k} disabled={!free}>{l} · {free} free</option>{/each}
    </select>
    {#if devices.length > 1}<button class="btn ghost" onclick={openRemote}>+ Remote signal</button>{/if}
    <button class="btn ghost" onclick={() => { localStorage.removeItem(posKey()); build() }}>Re-layout</button>
    <button class="btn ghost" onclick={load}>Refresh</button>
  </div>
</div>

<div style="height:calc(100vh - 200px);min-height:480px;border:1px solid var(--line);border-radius:var(--r);overflow:hidden;background:var(--surface)">
  <SvelteFlow bind:nodes bind:edges {nodeTypes} {onconnect} {ondelete} {onbeforedelete} {isValidConnection} colorMode={dark ? 'dark' : 'light'} fitView minZoom={0.2}
    onnodedragstop={savePos} deleteKey={['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}>
    <Background gap={18} />
    <Controls />
    <MiniMap pannable zoomable nodeColor={(n) => n.data?.color ?? '#594ae2'} maskColor={dark ? 'rgba(0,0,0,.55)' : 'rgba(255,255,255,.6)'} bgColor={dark ? '#14141c' : '#f3f3f8'} />
  </SvelteFlow>
</div>

{#if inlineTarget}
  <!-- the Signals & logic editor drawer, hosted here so the canvas stays visible while editing -->
  <SignalsView current={device} ids={$telemetry.ids ?? []} mode="editor" openTarget={inlineTarget} onclose={() => { inlineTarget = null; load() }} />
{/if}

{#if remoteOpen}
  <div class="scrim show" onclick={() => (remoteOpen = false)}></div>
  <aside class="drawer show" use:dialog={{ onclose: () => (remoteOpen = false) }}>
    <div class="dh"><div><div class="nm">Grab a signal from another module or ECU</div>
      <div class="meta">{remoteIsDbc ? 'Decodes the ECU frame into a CAN input here' : "It's bridged over CAN (auto CAN-out on the source + CAN-in here)"}</div></div>
      <button class="x" aria-label="Close" onclick={() => (remoteOpen = false)}>✕</button></div>
    <div class="dbody" use:labelFields>
      <div class="field"><label>Source</label>
        <select bind:value={remoteDev}>
          {#each devices.filter((d) => d.guid !== device.guid) as d}<option value={d.guid}>{d.name}{d.type && /dbc/i.test(d.type) ? ' (ECU)' : ''}</option>{/each}
        </select></div>
      <div class="field"><label>Signal</label><input placeholder={remoteIsDbc ? 'search ECU signal…' : 'filter…'} bind:value={remoteSearch} /></div>
      <div style="max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:8px">
        {#if remoteIsDbc}
          {#each remoteSignals as s (s.name + s.id + s.startBit)}
            <div use:clickable onclick={() => grabDbc(s)} style="padding:5px 9px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:8px"><span>{s.name}</span><span class="muted" style="font-size:11px;white-space:nowrap">{hex(s.id)} · {s.length}b{s.unit ? ' · ' + s.unit : ''}</span></div>
          {/each}
          {#if !remoteSignals.length}<div class="muted" style="padding:6px 9px;font-size:12px">{remoteSearch ? 'no match' : 'type to search'}</div>{/if}
        {:else}
          {#each remoteSignals.filter((s) => s.index > 0 && (!remoteSearch || s.name.toLowerCase().includes(remoteSearch.toLowerCase()))).slice(0, 200) as s (s.index)}
            <div use:clickable onclick={() => grabRemote(s)} style="padding:5px 9px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--line)">{s.name} <span class="muted" style="font-size:11px">#{s.index}</span></div>
          {/each}
        {/if}
      </div>
      <p class="hint">{#if remoteIsDbc}Pick an ECU signal — it becomes a CAN input on this module that decodes the frame at its message ID, ready to wire. Burn to keep.{:else}Pick a signal (e.g. a switch or output state). It appears as a remote node — wire it to a local input
        and the tool auto-creates the CAN broadcast on “{dName(remoteDev)}” and the CAN receive here. Deploy/Burn both modules.{/if}</p>
    </div>
  </aside>
{/if}

{#if bOpen && curBuilder}
  <div class="scrim show" onclick={() => (bOpen = false)}></div>
  <aside class="drawer show" use:dialog={{ onclose: () => (bOpen = false) }}>
    <div class="dh"><div><div class="nm">⚡ {curBuilder.name}</div>
      <div class="meta">{curBuilder.desc}</div></div>
      <button class="x" aria-label="Close" onclick={() => (bOpen = false)}>✕</button></div>
    <div class="dbody" use:labelFields>
      {#each curBuilder.fields as f}
        {#if f.t === 'check'}
          <label class="opt" style="border:0"><input type="checkbox" bind:checked={bSel[f.k]} /> {f.label}</label>
        {:else}
        <div class="field"><label>{f.label}{#if f.opt}<span class="muted">&nbsp;(optional)</span>{/if}</label>
          {#if f.t === 'bool'}
            <select bind:value={bSel[f.k]}><option value="">{f.opt ? '— none —' : 'Choose…'}</option>{#each boolSrc as v}<option value={v.index}>{v.name}</option>{/each}</select>
            <RemoteSourceAdd guid={device.guid} {devices} kind="bool" onadded={(idx) => loadSrcLists().then(() => bSel[f.k] = idx)} />
          {:else if f.t === 'num'}
            <select bind:value={bSel[f.k]}><option value="">Choose…</option>{#each numSrc as v}<option value={v.index}>{v.name}</option>{/each}</select>
            <RemoteSourceAdd guid={device.guid} {devices} kind="num" onadded={(idx) => loadSrcLists().then(() => bSel[f.k] = idx)} />
          {:else if f.t === 'out'}
            <select bind:value={bSel[f.k]}><option value="">Choose…</option>{#each builderOutputs as o}<option value={o.number}>{(isCanboard ? 'DO' : 'O') + o.number}{o.name?.trim() ? ' · ' + o.name : ''}</option>{/each}</select>
          {:else if f.t === 'op'}
            <select bind:value={bSel[f.k]}>{#each bOps as o}<option value={o.v}>{o.t}</option>{/each}</select>
          {:else if f.t === 'number'}
            <input type="number" step={f.min != null ? 1 : 'any'} min={f.min} max={f.max} bind:value={bSel[f.k]} />
          {/if}
        </div>
        {/if}
      {/each}
      <p class="hint">Creates the needed Conditions / Flashers / Timers / Virtual inputs and wires the outputs. You can tweak or delete
        any of the generated blocks afterwards in the graph. {#if !live}Module offline — saved to the project; Deploy to apply.{/if}</p>
      {#if bMsg}<p class="hint"><b>{bMsg}</b></p>{/if}
    </div>
    <div class="dfoot">
      <span style="margin-left:auto"></span>
      <button class="btn ghost" onclick={() => (bOpen = false)}>Cancel</button>
      <button class="btn primary" disabled={bBusy} onclick={applyBuilder}>{bBusy ? 'Building…' : 'Build circuit'}</button>
    </div>
  </aside>
{/if}

<style>
  .tyb, .tyi, .tyr { font-weight: 700; padding: 0 4px; border-radius: 3px; font-size: 11px; }
  .tyb { background: #1f6f50; color: #bdf0d4; } .tyi { background: #26408b; color: #c2d0ff; } .tyr { background: #7a5a12; color: #f3dca0; }
</style>
