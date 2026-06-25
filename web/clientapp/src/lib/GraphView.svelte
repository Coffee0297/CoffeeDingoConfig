<script>
  import { SvelteFlow, Background, Controls, MiniMap } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import FnNode from './FnNode.svelte'
  import { writable } from 'svelte/store'
  import { dialog, labelFields, clickable } from './a11y.js'
  import { api, varMapSources, applyGraphConnection, enableFunction, bridgeRemoteSignal, NODE_INPUTS, SYS_VARS } from './store.js'

  let { device, devices = [] } = $props()
  // Wiring edits persist to the project record even offline; they only reach the module over CAN
  // when it's live. Keep wiring enabled (offline authoring) but tell the truth about what landed.
  let live = $derived(!!device?.connected)
  const nodeTypes = { fn: FnNode }

  const META = {
    sys: ['#6f6f88', 'source'], digin: ['#2a9d8f', 'input'], analogin: ['#1f9e7a', 'analog'], caninput: ['#4361ee', 'CAN in'],
    virtualinput: ['#7209b7', 'virtual'], condition: ['#f77f00', 'condition'], counter: ['#d62828', 'counter'],
    flasher: ['#caa600', 'flasher'], output: ['#594ae2', 'output'], canoutput: ['#06998b', 'CAN out'],
    lua: ['#2d6a4f', 'lua'], kpbtn: ['#b5179e', 'keypad'], kpdial: ['#b5179e', 'dial'], kpain: ['#b5179e', 'analog'],
    wiper: ['#457b9d', 'wiper'], remote: ['#e07a5f', 'remote'],
  }
  const COL = { sys: 0, digin: 0, analogin: 0, caninput: 0, lua: 0, kpbtn: 0, kpdial: 0, kpain: 0, remote: 0, virtualinput: 1, condition: 1, counter: 1, flasher: 1, wiper: 1, output: 2, canoutput: 2 }
  const ADDABLE = [['condition', 'Threshold → bool (Condition)'], ['virtualinput', 'Combine (Virtual input)'], ['counter', 'Counter'], ['flasher', 'Flasher'], ['caninput', 'CAN input'], ['canoutput', 'CAN output']]
  const DELETABLE = new Set(['caninput', 'virtualinput', 'condition', 'counter', 'flasher', 'canoutput'])
  // Human labels for each node's ports (handle id -> row label). Falls back to the raw id.
  const PORT_LABEL = {
    output: { input: 'Trigger', on: 'State', current: 'Current (A)', oc: 'Overcurrent', fault: 'Fault' },
    caninput: { state: 'State', value: 'Value' },
    virtualinput: { var0: 'In 1', var1: 'In 2', var2: 'In 3', out: 'Output' },
    condition: { input: 'In', out: 'Output' },
    counter: { incInput: 'Count +', decInput: 'Count −', resetInput: 'Reset', out: 'Count' },
    flasher: { input: 'Trigger', out: 'Output' }, canoutput: { input: 'Value' },
    digin: { out: 'State' }, sys: { out: '' }, lua: { out: 'Out' },
    kpbtn: { out: 'Pressed' }, kpdial: { out: 'Value' }, kpain: { out: 'Value' }, remote: { out: 'Signal' },
  }
  // Which funcs array carries each kind's live signal (matched by function name).
  const SIGARR = { caninput: 'canInputs', virtualinput: 'virtualInputs', condition: 'conditions', counter: 'counters', flasher: 'flashers' }
  // Port data type → shown as a chip (B=bool, I=int, R=real). Drives the convert hint too.
  const PORT_TYPE = {
    digin: { out: 'bool' }, analogin: { value: 'real', mv: 'real', pos: 'int', switch: 'bool', scaled: 'real' },
    caninput: { state: 'bool', value: 'real' }, virtualinput: { var0: 'bool', var1: 'bool', var2: 'bool', out: 'bool' },
    condition: { input: 'real', out: 'bool' }, counter: { incInput: 'bool', decInput: 'bool', resetInput: 'bool', out: 'int' },
    flasher: { input: 'bool', out: 'bool' }, canoutput: { input: 'real' },
    output: { input: 'bool', on: 'bool', current: 'real', oc: 'bool', fault: 'bool' },
    lua: { out: 'bool' }, remote: { out: 'bool' }, kpbtn: { out: 'bool' }, kpdial: { out: 'int' }, kpain: { out: 'real' },
  }
  const portType = (kind, port, id) => kind === 'sys' ? (id === 'sys:2' ? 'int' : 'bool') : PORT_TYPE[kind]?.[port]
  // Which graph kinds map to a setFunction kind for rename/auto-enable (PDM smart outputs excluded — use Outputs tab).
  const isCanboard = $derived(/can.?board/i.test(device?.type || ''))
  const FN_KIND = { digin: 'input', analogin: 'analoginput', caninput: 'caninput', virtualinput: 'virtualinput', condition: 'condition', counter: 'counter', flasher: 'flasher', canoutput: 'canoutput' }
  const fnKindOf = (kind) => kind === 'output' ? (isCanboard ? 'digitaloutput' : null) : FN_KIND[kind]

  // Source catalog: every wireable source (node id, port) → its exact VarMap name (VarLabel convention:
  // name alone when the property is State/On, else "name <Property>"). Names matched against the REAL
  // VarMap (vmap) to get correct firmware indices — replaces the stale hardcoded varMapSources.
  // Digital inputs are `inputs` on a PDM but `digitalIn` on a CANBoard — unify.
  const diginArr = () => funcs?.inputs ?? funcs?.digitalIn ?? []
  function catalog() {
    const C = []; const P = (id, port, name) => C.push({ id, port, name })
    P('sys:0', 'out', 'None'); P('sys:1', 'out', 'Always On'); P('sys:2', 'out', 'State')
    ;diginArr().forEach((c, k) => P('digin:' + (k + 1), 'out', c.name))
    ;(funcs?.analogIn ?? []).forEach((c, k) => { const id = 'analogin:' + (k + 1), n = c.name
      P(id, 'value', n + ' Value'); P(id, 'mv', n + ' Value Millivolts'); P(id, 'pos', n + ' Rotary Position'); P(id, 'switch', n + ' Switch Value'); P(id, 'scaled', n + ' Scaled Value') })
    ;(device?.outputs ?? []).forEach((o) => P('output:' + o.number, 'on', o.name?.trim() ? o.name : 'output' + o.number))
    ;(funcs?.canInputs ?? []).forEach((c, k) => { const id = 'caninput:' + (k + 1); P(id, 'state', c.name); P(id, 'value', c.name + ' Value') })
    ;(funcs?.virtualInputs ?? []).forEach((c, k) => P('virtualinput:' + (k + 1), 'out', c.name))
    ;(funcs?.flashers ?? []).forEach((c, k) => P('flasher:' + (k + 1), 'out', c.name))
    ;(funcs?.conditions ?? []).forEach((c, k) => P('condition:' + (k + 1), 'out', c.name + ' Value'))
    ;(funcs?.counters ?? []).forEach((c, k) => P('counter:' + (k + 1), 'out', c.name + ' Value'))
    return C
  }
  function maps() {
    const nameToIdx = {}; for (const v of vmap) nameToIdx[v.name] = v.index
    const srcToIdx = {}, idxToSrc = {}
    for (const c of catalog()) { const ix = nameToIdx[c.name]; if (ix != null) { srcToIdx[c.id + '|' + c.port] = ix; idxToSrc[ix] = { id: c.id, port: c.port } } }
    return { srcToIdx, idxToSrc }
  }

  let nodes = $state.raw([])
  let edges = $state.raw([])
  let liveSig = $state({})   // signal name -> { value, on } from the telemetry poll
  let vmap = $state([])      // the device's REAL VarMap [{index, name}] — authoritative idx↔source
  // Live readouts flow through this store (node id -> {values,status}) so node/handle DOM is NEVER
  // recreated on a value tick — reassigning `nodes` every poll recreated handles and made the dots
  // jump under the cursor while wiring. FnNode reads its own id from the store.
  const fnLive = writable({})
  let msg = $state('')
  let funcs = null
  let remotes = $state([])              // [{ srcGuid, srcVar, label, devName }]
  let remoteOpen = $state(false), remoteDev = $state(''), remoteSearch = $state(''), remoteSignals = $state([])

  const posKey = () => 'dingoGraphPos:' + device?.guid
  const remKey = () => 'dingoGraphRemotes:' + device?.guid
  const loadPos = () => { try { return JSON.parse(localStorage.getItem(posKey()) || '{}') } catch { return {} } }
  const savePos = () => { const p = {}; for (const n of nodes) p[n.id] = n.position; try { localStorage.setItem(posKey(), JSON.stringify(p)) } catch {} }
  const saveRemotes = () => { try { localStorage.setItem(remKey(), JSON.stringify(remotes)) } catch {} }
  const dName = (g) => devices.find((d) => d.guid === g)?.name ?? g?.slice(0, 6)

  function nodeDef(id) {
    if (id.startsWith('remote:')) {
      const r = remotes.find((x) => 'remote:' + x.srcGuid + ':' + x.srcVar === id)
      return { color: META.remote[0], kind: 'remote', label: r?.label ?? 'remote', sub: r?.devName ?? '', inputs: [], outs: ['out'], inPorts: [], outPorts: [{ id: 'out', label: 'Signal' }], remote: r?.devName, deletable: true }
    }
    const ci = id.indexOf(':'); const kind = ci < 0 ? id : id.slice(0, ci)
    const rest = ci < 0 ? '' : id.slice(ci + 1)
    const k1 = parseInt(rest, 10)
    const [color, klabel] = META[kind] ?? ['#888', kind]
    let label = id, sub = '', inputs = NODE_INPUTS[kind] ?? [], outs = ['out']
    const nm = (arr, idx) => (funcs?.[arr]?.[idx]?.name) || `${kind}${idx + 1}`
    if (kind === 'sys') label = SYS_VARS[k1] ?? 'sys'
    else if (kind === 'analogin') { label = nm('analogIn', k1 - 1); outs = ['value', 'mv', 'pos', 'switch', 'scaled'] }
    else if (kind === 'digin') label = diginArr()[k1 - 1]?.name || `digitalInput${k1}`
    else if (kind === 'caninput') { label = nm('canInputs', k1 - 1); const c = funcs?.canInputs?.[k1 - 1]; sub = c ? ('0x' + (c.id ?? 0).toString(16)) : ''; outs = ['state', 'value'] }
    else if (kind === 'virtualinput') label = nm('virtualInputs', k1 - 1)
    else if (kind === 'condition') label = nm('conditions', k1 - 1)
    else if (kind === 'counter') label = nm('counters', k1 - 1)
    else if (kind === 'flasher') label = nm('flashers', k1 - 1)
    else if (kind === 'canoutput') { label = nm('canOutputs', k1 - 1); const c = funcs?.canOutputs?.[k1 - 1]; sub = c ? ('→0x' + (c.id ?? 0).toString(16)) : ''; outs = [] }
    else if (kind === 'output') { const o = (device?.outputs ?? []).find((x) => x.number === k1); label = 'O' + k1 + (o?.name?.trim() ? ' ' + o.name : ''); outs = ['on', 'current', 'oc', 'fault'] }   // live state/current shown on the ports + STATUS badge
    else if (kind === 'lua') label = 'Lua Out ' + (k1 + 1)
    else if (kind === 'kpbtn') { const p = rest.split(':'); label = 'KP' + p[0] + ' btn' + p[1] }
    else if (kind === 'kpdial') { const p = rest.split(':'); label = 'KP' + p[0] + ' dial' + p[1] }
    else if (kind === 'kpain') { const p = rest.split(':'); label = 'KP' + p[0] + ' AIN' + p[1] }
    const mk = (ids) => ids.map((pid) => ({ id: pid, label: PORT_LABEL[kind]?.[pid] ?? pid, type: portType(kind, pid, id) }))
    return { color, kind: klabel, label, sub, inputs, outs, inPorts: mk(inputs), outPorts: mk(outs),
      deletable: DELETABLE.has(kind), renamable: !!fnKindOf(kind) }
  }

  // Live values + status badge for a node, from the telemetry poll (liveSig) and output telemetry.
  function valuesFor(id) {
    const ci = id.indexOf(':'); const kind = ci < 0 ? id : id.slice(0, ci); const k1 = parseInt(id.slice(ci + 1), 10) || 0
    if (kind === 'output') {
      const o = (device?.outputs ?? []).find((x) => x.number === k1)
      if (!o) return { values: {}, status: null }
      return { status: { text: String(o.state ?? '').toUpperCase(), tone: o.state },
        values: { on: String(o.state ?? ''), current: (o.current ?? 0).toFixed(1) } }   // unit lives in the label "Current (A)"
    }
    if (kind === 'digin') {
      const nm = diginArr()[k1 - 1]?.name; const s = nm ? liveSig[nm] : null
      return { values: { out: s ? (s.on ? 'on' : 'off') : '' }, status: s ? { text: s.on ? 'ON' : 'OFF', tone: s.on ? 'on' : '' } : null }
    }
    if (kind === 'analogin') {
      const nm = funcs?.analogIn?.[k1 - 1]?.name; if (!nm) return { values: {} }
      return { values: { mv: liveSig[nm]?.value ?? '', pos: liveSig[nm + ' Pos']?.value ?? '', switch: liveSig[nm + ' Switch']?.on ? 'on' : 'off' } }
    }
    const arr = SIGARR[kind]
    if (arr) {
      const nm = funcs?.[arr]?.[k1 - 1]?.name; const s = nm ? liveSig[nm] : null
      if (kind === 'caninput') return { values: { state: s ? (s.on ? 'on' : 'off') : '', value: s ? s.value : '' } }
      if (!s) return { values: {} }
      return { values: { out: kind === 'counter' ? s.value : (s.on ? 'on' : 'off') } }
    }
    return { values: {} }
  }
  // Push live readouts into the store (no node reassignment → handles/DOM stay put).
  function pushLive() { const m = {}; for (const n of nodes) m[n.id] = valuesFor(n.id); fnLive.set(m) }

  function build() {
    const outputs = device?.outputs ?? []
    const { idxToSrc } = maps()
    const E = []
    const addEdge = (targetId, field, srcIdx) => {
      if (!srcIdx || srcIdx <= 0) return
      const s = idxToSrc[srcIdx]; if (!s) return
      E.push({ id: targetId + ':' + field, source: s.id, sourceHandle: s.port, target: targetId, targetHandle: field, animated: false, style: 'stroke:#594ae2;stroke-width:1.5' })
    }
    for (const o of outputs) addEdge('output:' + o.number, 'input', o.inputVal)
    ;(funcs?.conditions ?? []).forEach((c, k) => { if (c.enabled) addEdge('condition:' + (k + 1), 'input', c.input) })
    ;(funcs?.flashers ?? []).forEach((c, k) => { if (c.enabled) addEdge('flasher:' + (k + 1), 'input', c.input) })
    ;(funcs?.canOutputs ?? []).forEach((c, k) => { if (c.enabled) addEdge('canoutput:' + (k + 1), 'input', c.input) })
    ;(funcs?.virtualInputs ?? []).forEach((c, k) => { if (c.enabled) { addEdge('virtualinput:' + (k + 1), 'var0', c.var0); addEdge('virtualinput:' + (k + 1), 'var1', c.var1); addEdge('virtualinput:' + (k + 1), 'var2', c.var2) } })
    ;(funcs?.counters ?? []).forEach((c, k) => { if (c.enabled) { addEdge('counter:' + (k + 1), 'incInput', c.incInput); addEdge('counter:' + (k + 1), 'decInput', c.decInput); addEdge('counter:' + (k + 1), 'resetInput', c.resetInput) } })

    const ids = new Set()
    for (let s = 1; s <= 4; s++) ids.add('sys:' + s)
    ;diginArr().forEach((_, k) => ids.add('digin:' + (k + 1)))
    ;(funcs?.analogIn ?? []).forEach((_, k) => ids.add('analogin:' + (k + 1)))
    for (const o of outputs) ids.add('output:' + o.number)
    const en = (arr, pfx) => (funcs?.[arr] ?? []).forEach((c, k) => { if (c.enabled) ids.add(pfx + (k + 1)) })
    en('canInputs', 'caninput:'); en('virtualInputs', 'virtualinput:'); en('conditions', 'condition:')
    en('counters', 'counter:'); en('flashers', 'flasher:'); en('canOutputs', 'canoutput:')
    for (const r of remotes) ids.add('remote:' + r.srcGuid + ':' + r.srcVar)
    for (const e of E) { ids.add(e.source); ids.add(e.target) }

    const saved = loadPos(); const colY = {}   // per-column running Y — height-aware so tall nodes don't overlap
    nodes = [...ids].map((id) => {
      const kind = id.split(':')[0]; const col = COL[kind] ?? 1
      const def = nodeDef(id); const vf = valuesFor(id)
      const rows = Math.max(def.inPorts.length, def.outPorts.length)
      const h = 22 + (def.sub ? 13 : 0) + rows * 18 + (vf.status ? 20 : 0) + 12   // matches FnNode geometry
      let pos
      if (saved[id]) pos = saved[id]
      else { const y = colY[col] ?? 20; pos = { x: col * 360 + 20, y }; colY[col] = y + h + 22 }
      return { id, type: 'fn', position: pos, deletable: def.deletable, data: { ...def, ...vf, fnLive, onDelete: () => deleteNode(id), onRename: def.renamable ? (name) => renameNode(id, name) : null } }
    })
    edges = E
    pushLive()
  }

  // Live telemetry poll → patch node values/status (the "instrument" readouts).
  $effect(() => {
    const g = device?.guid
    if (!g) { liveSig = {}; return }
    let alive = true
    const tick = async () => {
      try {
        const s = await api.signals(g)
        if (!alive) return
        const m = {}; for (const x of s) m[x.name] = { value: x.value, on: x.on }
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
      boolSrc = await api.inputs(device.guid, 'bool').catch(() => [])
      numSrc = [...await api.inputs(device.guid, 'float').catch(() => []), ...await api.inputs(device.guid, 'int').catch(() => [])]
      build()
    } catch (e) { msg = 'load failed: ' + e.message }
  }
  $effect(() => { if (device?.guid) load() })

  // Enable the source function when it's wired (a disabled source produces nothing). sys/lua/keypad
  // have no enable → skipped. Toasts so the user sees it happened.
  async function enableSource(sourceId) {
    const ci = sourceId.indexOf(':'); const kind = ci < 0 ? sourceId : sourceId.slice(0, ci)
    const k = fnKindOf(kind); if (!k) return
    const num = parseInt(sourceId.slice(ci + 1), 10) || 0
    const arr = { input: 'inputs', analoginput: 'analogIn', caninput: 'canInputs', virtualinput: 'virtualInputs', condition: 'conditions', counter: 'counters', flasher: 'flashers', canoutput: 'canOutputs', digitaloutput: 'digitalOut' }[k]
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
    catch (e) { msg = 'rename failed: ' + e.message }
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
      if (srcIdx == null) return
      edges = [...edges.filter((e) => !(e.target === conn.target && e.targetHandle === field)),
        { id: conn.target + ':' + field, source: conn.source, sourceHandle: conn.sourceHandle, target: conn.target, targetHandle: field, animated: false, style: 'stroke:#594ae2;stroke-width:1.5' }]
      await applyGraphConnection(device.guid, conn.target, field, srcIdx, devices)
      if (!conn.source.startsWith('remote:')) await enableSource(conn.source)   // a disabled source produces nothing
      msg = live ? `wired → ${conn.target}.${field} (Burn to keep)`
                 : `wired → ${conn.target}.${field} — saved to the project; connect + Deploy to apply`
      if (conn.source.startsWith('remote:')) await load()   // refresh to show the new CAN-in node
    } catch (e) { msg = 'write failed: ' + e.message }
  }
  // Clear any consumer inputs wired FROM this node's output ports — otherwise a disabled source
  // still has consumers pointing at its VarMap index, the edge is re-drawn, and the node reappears
  // (looks like delete "did nothing"). Drop those wires first so the block actually goes.
  async function unwireConsumers(id) {
    const { srcToIdx } = maps()
    const def = nodeDef(id)
    const idxs = new Set(def.outPorts.map((p) => srcToIdx[id + '|' + p.id]).filter((x) => x != null && x > 0))
    if (!idxs.size) return
    const clears = []
    for (const o of (device?.outputs ?? [])) if (idxs.has(o.inputVal)) clears.push(['output:' + o.number, 'input'])
    ;(funcs?.conditions ?? []).forEach((c, k) => { if (c.enabled && idxs.has(c.input)) clears.push(['condition:' + (k + 1), 'input']) })
    ;(funcs?.flashers ?? []).forEach((c, k) => { if (c.enabled && idxs.has(c.input)) clears.push(['flasher:' + (k + 1), 'input']) })
    ;(funcs?.canOutputs ?? []).forEach((c, k) => { if (c.enabled && idxs.has(c.input)) clears.push(['canoutput:' + (k + 1), 'input']) })
    ;(funcs?.virtualInputs ?? []).forEach((c, k) => { if (c.enabled) for (const f of ['var0', 'var1', 'var2']) if (idxs.has(c[f])) clears.push(['virtualinput:' + (k + 1), f]) })
    ;(funcs?.counters ?? []).forEach((c, k) => { if (c.enabled) for (const f of ['incInput', 'decInput', 'resetInput']) if (idxs.has(c[f])) clears.push(['counter:' + (k + 1), f]) })
    for (const [t, f] of clears) await applyGraphConnection(device.guid, t, f, 0, devices)
  }
  // Delete a single block: drop wires from it, disable its function (or drop a remote signal), refresh.
  async function deleteNode(id) {
    try {
      if (id.startsWith('remote:')) { remotes = remotes.filter((r) => 'remote:' + r.srcGuid + ':' + r.srcVar !== id); saveRemotes() }
      else { const ci = id.indexOf(':'); const kind = id.slice(0, ci); const num = parseInt(id.slice(ci + 1), 10); if (DELETABLE.has(kind)) { await unwireConsumers(id); await api.setFunction(device.guid, kind, num, { enabled: false }) } else { msg = 'this block is physical — can’t delete'; return } }
      msg = 'deleted ' + id; await load()
    } catch (e) { msg = 'delete failed: ' + e.message }
  }
  // Delete-key path (svelte-flow removed the selection; apply to the device + refresh).
  async function ondelete({ nodes: dn, edges: de }) {
    try {
      for (const e of (de ?? [])) await applyGraphConnection(device.guid, e.target, e.targetHandle, 0, devices)
      for (const n of (dn ?? [])) {
        if (n.id.startsWith('remote:')) { remotes = remotes.filter((r) => 'remote:' + r.srcGuid + ':' + r.srcVar !== n.id); saveRemotes() }
        else { const ci = n.id.indexOf(':'); const kind = n.id.slice(0, ci); const num = parseInt(n.id.slice(ci + 1), 10); if (DELETABLE.has(kind)) { await unwireConsumers(n.id); await api.setFunction(device.guid, kind, num, { enabled: false }) } }
      }
      msg = `deleted ${(dn ?? []).length} block(s) · ${(de ?? []).length} wire(s)`
    } catch (e) { msg = 'delete failed: ' + e.message }
    await load()
  }

  async function addNode(kind) {
    try { const id = await enableFunction(device.guid, kind); if (!id) { msg = `no free ${kind} slot`; return } await load(); msg = `added ${id}` }
    catch (e) { msg = 'add failed: ' + e.message }
  }

  async function openRemote() { remoteOpen = true; remoteDev = devices.find((d) => d.guid !== device.guid)?.guid ?? ''; if (remoteDev) loadRemoteSignals(remoteDev) }
  async function loadRemoteSignals(g) { try { remoteSignals = await api.inputs(g) } catch { remoteSignals = [] } }
  function grabRemote(sig) {
    if (remotes.some((r) => r.srcGuid === remoteDev && r.srcVar === sig.index)) { remoteOpen = false; return }
    remotes = [...remotes, { srcGuid: remoteDev, srcVar: sig.index, label: sig.name, devName: dName(remoteDev) }]
    saveRemotes(); build(); remoteOpen = false
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
    { key: 'blinker', name: 'Blinker / hazard', desc: 'Left/right (+ optional hazard) blink two outputs. Builds a flasher + the side logic.',
      fields: [{ k: 'left', t: 'bool', label: 'Left trigger' }, { k: 'right', t: 'bool', label: 'Right trigger' },
        { k: 'hazard', t: 'bool', label: 'Hazard trigger', opt: true }, { k: 'leftOut', t: 'out', label: 'Left output' },
        { k: 'rightOut', t: 'out', label: 'Right output' }, { k: 'rate', t: 'number', label: 'Blink rate (ms)', def: 400 }],
      build: async (ctx, s) => {
        const fl = await ctx.flasher(ctx.alwaysOn(), +s.rate, +s.rate, 'CB Blink')
        const haz = s.hazard ? +s.hazard : 0
        const side = async (trig, name) => haz
          ? ctx.virtual({ v0: +trig, op0: Or, v1: haz, op1: And, v2: fl }, name)   // (trig OR hazard) AND blink
          : ctx.virtual({ v0: +trig, op0: And, v1: fl }, name)                     // trig AND blink
        await ctx.wireOutput(s.leftOut, await side(s.left, 'CB Left'))
        await ctx.wireOutput(s.rightOut, await side(s.right, 'CB Right'))
      } },
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
  const builderCtx = {
    alwaysOn: () => vmap.find((v) => v.name === 'Always On')?.index ?? 1,
    wireOutput: (outNum, srcIdx) => isCanboard
      ? api.setFunction(device.guid, 'digitaloutput', outNum, { enabled: true, input: srcIdx })
      : applyGraphConnection(device.guid, 'output:' + outNum, 'input', srcIdx, devices),
    condition: async (input, op, arg, name) => { const n = bFree('conditions'); await api.setFunction(device.guid, 'condition', n, { enabled: true, input, operator: op, arg, name }); await bRefresh(); return bIdx('condition:' + n) },
    flasher: async (input, onTime, offTime, name) => { const n = bFree('flashers'); await api.setFunction(device.guid, 'flasher', n, { enabled: true, input, onTime, offTime, single: false, name }); await bRefresh(); return bIdx('flasher:' + n) },
    virtual: async (c, name) => { const n = bFree('virtualInputs'); await api.setFunction(device.guid, 'virtualinput', n, { enabled: true, not0: !!c.not0, var0: c.v0 ?? 0, cond0: c.op0 ?? And, not1: !!c.not1, var1: c.v1 ?? 0, cond1: c.op1 ?? And, not2: !!c.not2, var2: c.v2 ?? 0, mode: 0, name }); await bRefresh(); return bIdx('virtualinput:' + n) },
  }
  async function applyBuilder() {
    if (!curBuilder) return
    const missing = curBuilder.fields.filter((f) => !f.opt && (bSel[f.k] === '' || bSel[f.k] == null))
    if (missing.length) { bMsg = 'Fill in: ' + missing.map((f) => f.label).join(', '); return }
    bBusy = true; bMsg = ''
    try {
      await curBuilder.build(builderCtx, bSel)
      await load()
      localStorage.removeItem(posKey()); build()   // re-layout so the new blocks are visible
      bOpen = false
      msg = `built “${curBuilder.name}” — Burn to keep`
    } catch (e) { bMsg = 'Failed: ' + e.message }
    finally { bBusy = false }
  }
</script>

<div class="h-row">
  <div><h1>{device?.name ?? '—'} · Wiring</h1>
    <p class="sub">Drag from a <b style="color:#594ae2">purple output ●</b> (right) to a <b style="color:#2a9d8f">green input ●</b> (left) to wire it · hover a block and click <b>✕</b> or select + press <b>Delete</b> to remove · then <b>Burn</b> to keep. {#if msg}— <b>{msg}</b>{/if}{#if !live}<br><span class="muted">Module offline — wiring saves to the project; connect + Deploy to apply it.</span>{/if}</p></div>
  <div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <select onchange={(e) => { if (e.target.value) { openBuilder(e.target.value); e.target.value = '' } }} style="font-size:13px" title="Scaffold a ready-made circuit">
      <option value="">⚡ Circuit builder…</option>
      {#each BUILDERS as b}<option value={b.key}>{b.name}</option>{/each}
    </select>
    <select onchange={(e) => { if (e.target.value) { addNode(e.target.value); e.target.value = '' } }} style="font-size:13px">
      <option value="">+ Add node…</option>
      {#each ADDABLE as [k, l]}<option value={k}>{l}</option>{/each}
    </select>
    {#if devices.length > 1}<button class="btn ghost" onclick={openRemote}>+ Remote signal</button>{/if}
    <button class="btn ghost" onclick={() => { localStorage.removeItem(posKey()); build() }}>Re-layout</button>
    <button class="btn ghost" onclick={load}>Refresh</button>
  </div>
</div>

<div style="height:calc(100vh - 200px);min-height:480px;border:1px solid var(--line);border-radius:var(--r);overflow:hidden;background:var(--surface)">
  <SvelteFlow bind:nodes bind:edges {nodeTypes} {onconnect} {ondelete} colorMode="dark" fitView
    onnodedragstop={savePos} deleteKey={['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}>
    <Background gap={18} />
    <Controls />
    <MiniMap pannable zoomable nodeColor="#594ae2" maskColor="rgba(0,0,0,.55)" bgColor="#14141c" />
  </SvelteFlow>
</div>

{#if remoteOpen}
  <div class="scrim show" onclick={() => (remoteOpen = false)}></div>
  <aside class="drawer show" use:dialog={{ onclose: () => (remoteOpen = false) }}>
    <div class="dh"><div><div class="nm">Grab a signal from another module</div>
      <div class="meta">It's bridged over CAN (auto CAN-out on the source + CAN-in here)</div></div>
      <button class="x" aria-label="Close" onclick={() => (remoteOpen = false)}>✕</button></div>
    <div class="dbody" use:labelFields>
      <div class="field"><label>Module</label>
        <select bind:value={remoteDev} onchange={() => loadRemoteSignals(remoteDev)}>
          {#each devices.filter((d) => d.guid !== device.guid) as d}<option value={d.guid}>{d.name}</option>{/each}
        </select></div>
      <div class="field"><label>Signal</label><input placeholder="filter…" bind:value={remoteSearch} /></div>
      <div style="max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:8px">
        {#each remoteSignals.filter((s) => s.index > 0 && (!remoteSearch || s.name.toLowerCase().includes(remoteSearch.toLowerCase()))).slice(0, 200) as s (s.index)}
          <div use:clickable onclick={() => grabRemote(s)} style="padding:5px 9px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--line)">{s.name} <span class="muted" style="font-size:11px">#{s.index}</span></div>
        {/each}
      </div>
      <p class="hint">Pick a signal (e.g. a switch or output state). It appears as a remote node — wire it to a local input
        and the tool auto-creates the CAN broadcast on “{dName(remoteDev)}” and the CAN receive here. Deploy/Burn both modules.</p>
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
        <div class="field"><label>{f.label}{#if f.opt}<span class="muted">&nbsp;(optional)</span>{/if}</label>
          {#if f.t === 'bool'}
            <select bind:value={bSel[f.k]}><option value="">{f.opt ? '— none —' : 'Choose…'}</option>{#each boolSrc as v}<option value={v.index}>{v.name}</option>{/each}</select>
          {:else if f.t === 'num'}
            <select bind:value={bSel[f.k]}><option value="">Choose…</option>{#each numSrc as v}<option value={v.index}>{v.name}</option>{/each}</select>
          {:else if f.t === 'out'}
            <select bind:value={bSel[f.k]}><option value="">Choose…</option>{#each builderOutputs as o}<option value={o.number}>{'O' + o.number}{o.name?.trim() ? ' · ' + o.name : ''}</option>{/each}</select>
          {:else if f.t === 'op'}
            <select bind:value={bSel[f.k]}>{#each bOps as o}<option value={o.v}>{o.t}</option>{/each}</select>
          {:else if f.t === 'number'}
            <input type="number" step="any" bind:value={bSel[f.k]} />
          {/if}
        </div>
      {/each}
      <p class="hint">Creates the needed Conditions / Flashers / Virtual inputs and wires the outputs. You can tweak or delete
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
