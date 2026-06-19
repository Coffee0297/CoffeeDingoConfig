<script>
  import { SvelteFlow, Background, Controls, MiniMap } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import FnNode from './FnNode.svelte'
  import { dialog, labelFields, clickable } from './a11y.js'
  import { api, varMapSources, applyGraphConnection, enableFunction, bridgeRemoteSignal, NODE_INPUTS, SYS_VARS } from './store.js'

  let { device, devices = [] } = $props()
  const nodeTypes = { fn: FnNode }

  const META = {
    sys: ['#6f6f88', 'source'], digin: ['#2a9d8f', 'input'], caninput: ['#4361ee', 'CAN in'],
    virtualinput: ['#7209b7', 'virtual'], condition: ['#f77f00', 'condition'], counter: ['#d62828', 'counter'],
    flasher: ['#caa600', 'flasher'], output: ['#594ae2', 'output'], canoutput: ['#06998b', 'CAN out'],
    lua: ['#2d6a4f', 'lua'], kpbtn: ['#b5179e', 'keypad'], kpdial: ['#b5179e', 'dial'], kpain: ['#b5179e', 'analog'],
    wiper: ['#457b9d', 'wiper'], remote: ['#e07a5f', 'remote'],
  }
  const COL = { sys: 0, digin: 0, caninput: 0, lua: 0, kpbtn: 0, kpdial: 0, kpain: 0, remote: 0, virtualinput: 1, condition: 1, counter: 1, flasher: 1, wiper: 1, output: 2, canoutput: 2 }
  const ADDABLE = [['condition', 'Condition'], ['virtualinput', 'Virtual input'], ['counter', 'Counter'], ['flasher', 'Flasher'], ['caninput', 'CAN input'], ['canoutput', 'CAN output']]
  const DELETABLE = new Set(['caninput', 'virtualinput', 'condition', 'counter', 'flasher', 'canoutput'])

  let nodes = $state.raw([])
  let edges = $state.raw([])
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
      return { color: META.remote[0], kind: 'remote', label: r?.label ?? 'remote', sub: r?.devName ?? '', inputs: [], outs: ['out'], remote: r?.devName, deletable: true }
    }
    const ci = id.indexOf(':'); const kind = ci < 0 ? id : id.slice(0, ci)
    const rest = ci < 0 ? '' : id.slice(ci + 1)
    const k1 = parseInt(rest, 10)
    const [color, klabel] = META[kind] ?? ['#888', kind]
    let label = id, sub = '', inputs = NODE_INPUTS[kind] ?? [], outs = ['out']
    const nm = (arr, idx) => (funcs?.[arr]?.[idx]?.name) || `${kind}${idx + 1}`
    if (kind === 'sys') label = SYS_VARS[k1] ?? 'sys'
    else if (kind === 'digin') label = nm('inputs', k1 - 1)
    else if (kind === 'caninput') { label = nm('canInputs', k1 - 1); const c = funcs?.canInputs?.[k1 - 1]; sub = c ? ('0x' + (c.id ?? 0).toString(16)) : ''; outs = ['state', 'value'] }
    else if (kind === 'virtualinput') label = nm('virtualInputs', k1 - 1)
    else if (kind === 'condition') label = nm('conditions', k1 - 1)
    else if (kind === 'counter') label = nm('counters', k1 - 1)
    else if (kind === 'flasher') label = nm('flashers', k1 - 1)
    else if (kind === 'canoutput') { label = nm('canOutputs', k1 - 1); const c = funcs?.canOutputs?.[k1 - 1]; sub = c ? ('→0x' + (c.id ?? 0).toString(16)) : ''; outs = [] }
    else if (kind === 'output') { const o = (device?.outputs ?? []).find((x) => x.number === k1); label = 'O' + k1 + (o?.name?.trim() ? ' ' + o.name : ''); sub = o ? (o.state + ' · ' + (o.current ?? 0).toFixed(1) + 'A') : ''; outs = ['on', 'current', 'oc', 'fault'] }
    else if (kind === 'lua') label = 'Lua Out ' + (k1 + 1)
    else if (kind === 'kpbtn') { const p = rest.split(':'); label = 'KP' + p[0] + ' btn' + p[1] }
    else if (kind === 'kpdial') { const p = rest.split(':'); label = 'KP' + p[0] + ' dial' + p[1] }
    else if (kind === 'kpain') { const p = rest.split(':'); label = 'KP' + p[0] + ' AIN' + p[1] }
    return { color, kind: klabel, label, sub, inputs, outs, deletable: DELETABLE.has(kind) }
  }

  function build() {
    const outputs = device?.outputs ?? []
    const { idxToSrc } = varMapSources(funcs, outputs)
    const E = []
    const addEdge = (targetId, field, srcIdx) => {
      if (!srcIdx || srcIdx <= 0) return
      const s = idxToSrc[srcIdx]; if (!s) return
      E.push({ id: targetId + ':' + field, source: s.id, sourceHandle: s.port, target: targetId, targetHandle: field, animated: true, style: 'stroke:#594ae2;stroke-width:1.5' })
    }
    for (const o of outputs) addEdge('output:' + o.number, 'input', o.inputVal)
    ;(funcs?.conditions ?? []).forEach((c, k) => { if (c.enabled) addEdge('condition:' + (k + 1), 'input', c.input) })
    ;(funcs?.flashers ?? []).forEach((c, k) => { if (c.enabled) addEdge('flasher:' + (k + 1), 'input', c.input) })
    ;(funcs?.canOutputs ?? []).forEach((c, k) => { if (c.enabled) addEdge('canoutput:' + (k + 1), 'input', c.input) })
    ;(funcs?.virtualInputs ?? []).forEach((c, k) => { if (c.enabled) { addEdge('virtualinput:' + (k + 1), 'var0', c.var0); addEdge('virtualinput:' + (k + 1), 'var1', c.var1); addEdge('virtualinput:' + (k + 1), 'var2', c.var2) } })
    ;(funcs?.counters ?? []).forEach((c, k) => { if (c.enabled) { addEdge('counter:' + (k + 1), 'incInput', c.incInput); addEdge('counter:' + (k + 1), 'decInput', c.decInput); addEdge('counter:' + (k + 1), 'resetInput', c.resetInput) } })

    const ids = new Set()
    for (let s = 1; s <= 4; s++) ids.add('sys:' + s)
    ;(funcs?.inputs ?? []).forEach((_, k) => ids.add('digin:' + (k + 1)))
    for (const o of outputs) ids.add('output:' + o.number)
    const en = (arr, pfx) => (funcs?.[arr] ?? []).forEach((c, k) => { if (c.enabled) ids.add(pfx + (k + 1)) })
    en('canInputs', 'caninput:'); en('virtualInputs', 'virtualinput:'); en('conditions', 'condition:')
    en('counters', 'counter:'); en('flashers', 'flasher:'); en('canOutputs', 'canoutput:')
    for (const r of remotes) ids.add('remote:' + r.srcGuid + ':' + r.srcVar)
    for (const e of E) { ids.add(e.source); ids.add(e.target) }

    const saved = loadPos(); const colCount = {}
    nodes = [...ids].map((id) => {
      const kind = id.split(':')[0]; const col = COL[kind] ?? 1
      colCount[col] = (colCount[col] ?? 0)
      const pos = saved[id] ?? { x: col * 340 + 20, y: colCount[col] * 70 + 20 }
      colCount[col]++
      const def = nodeDef(id)
      return { id, type: 'fn', position: pos, deletable: def.deletable, data: { ...def, onDelete: () => deleteNode(id) } }
    })
    edges = E
  }

  async function load() {
    if (!device?.guid) return
    try { remotes = JSON.parse(localStorage.getItem(remKey()) || '[]') } catch { remotes = [] }
    try { funcs = await api.functions(device.guid); build() } catch (e) { msg = 'load failed: ' + e.message }
  }
  $effect(() => { if (device?.guid) load() })

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
        const { srcToIdx } = varMapSources(funcs, device?.outputs ?? [])
        srcIdx = srcToIdx[conn.source + '|' + conn.sourceHandle]
      }
      if (srcIdx == null) return
      edges = [...edges.filter((e) => !(e.target === conn.target && e.targetHandle === field)),
        { id: conn.target + ':' + field, source: conn.source, sourceHandle: conn.sourceHandle, target: conn.target, targetHandle: field, animated: true, style: 'stroke:#594ae2;stroke-width:1.5' }]
      await applyGraphConnection(device.guid, conn.target, field, srcIdx, devices)
      msg = `wired → ${conn.target}.${field} (Burn to keep)`
      if (conn.source.startsWith('remote:')) await load()   // refresh to show the new CAN-in node
    } catch (e) { msg = 'write failed: ' + e.message }
  }
  // Delete a single block: disable its function (or drop a remote signal), then refresh.
  async function deleteNode(id) {
    try {
      if (id.startsWith('remote:')) { remotes = remotes.filter((r) => 'remote:' + r.srcGuid + ':' + r.srcVar !== id); saveRemotes() }
      else { const ci = id.indexOf(':'); const kind = id.slice(0, ci); const num = parseInt(id.slice(ci + 1), 10); if (DELETABLE.has(kind)) await api.setFunction(device.guid, kind, num, { enabled: false }); else { msg = 'this block is physical — can’t delete'; return } }
      msg = 'deleted ' + id; await load()
    } catch (e) { msg = 'delete failed: ' + e.message }
  }
  // Delete-key path (svelte-flow removed the selection; apply to the device + refresh).
  async function ondelete({ nodes: dn, edges: de }) {
    try {
      for (const e of (de ?? [])) await applyGraphConnection(device.guid, e.target, e.targetHandle, 0, devices)
      for (const n of (dn ?? [])) {
        if (n.id.startsWith('remote:')) { remotes = remotes.filter((r) => 'remote:' + r.srcGuid + ':' + r.srcVar !== n.id); saveRemotes() }
        else { const ci = n.id.indexOf(':'); const kind = n.id.slice(0, ci); const num = parseInt(n.id.slice(ci + 1), 10); if (DELETABLE.has(kind)) await api.setFunction(device.guid, kind, num, { enabled: false }) }
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
</script>

<div class="h-row">
  <div><h1>{device?.name ?? '—'} · Wiring</h1>
    <p class="sub">Drag from a <b style="color:#594ae2">purple output ●</b> (right) to a <b style="color:#2a9d8f">green input ●</b> (left) to wire it · hover a block and click <b>✕</b> or select + press <b>Delete</b> to remove · then <b>Burn</b> to keep. {#if msg}— <b>{msg}</b>{/if}</p></div>
  <div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
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
  <SvelteFlow bind:nodes bind:edges {nodeTypes} {onconnect} {ondelete} onnodedragstop={savePos} fitView
    deleteKey={['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}>
    <Background gap={18} />
    <Controls />
    <MiniMap pannable zoomable />
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
