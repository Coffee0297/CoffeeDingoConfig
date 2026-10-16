<script>
  /**
   * Flow builder (H05 / FC3 / H26): a module's real blocks on a Svelte Flow canvas, or as sentences.
   * Route: functions/flow[/<guid>[/<fnKey>]]   fnKey = a block id ("virtualinput:2", "output:7") or "grp:<id>".
   * Data: GET /functions + /inputs (var map) + /signals (live, polled) + device telemetry (10 Hz).
   * Writes: function POST / outputconfig / device-inputs (see flow/ops.js); every write can be undone.
   */
  import { SvelteFlow, Background, MiniMap, Panel } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import { untrack } from 'svelte'
  import { Button, Chip, Banner, Select, Segmented, Field, Meter, Dialog, Empty, StateDot } from '../../ui/index.js'
  import { live, hub, project, defs, api, toast, device, moduleState, mutate, isPdm, isCanboard } from '../../lib/live.svelte.js'
  import { href, go } from '../../router.svelte.js'
  import { ui } from '../../shell/ui.svelte.js'
  import FlowNode from './flow/FlowNode.svelte'
  import FlowEdge from './flow/FlowEdge.svelte'
  import FlowApi from './flow/FlowApi.svelte'
  import Inspector from './flow/Inspector.svelte'
  import SentenceView from './flow/SentenceView.svelte'
  import SimPanel from './flow/SimPanel.svelte'
  import AddDialog from './flow/AddDialog.svelte'
  import RemoteDialog from './flow/RemoteDialog.svelte'
  import BlockSheet from './flow/BlockSheet.svelte'
  import ApplyCheck from './flow/ApplyCheck.svelte'
  import { buildModel, slotUsage, canWire, parseId, KINDS, FAM_COLOR, autoLayout, isCb } from './flow/model.js'
  import { writeLive } from './flow/livevals.js'
  import { createSim } from './flow/sim.js'
  import { suggest, loadGroups, saveGroups, makeGroup, pruneGroups, kindWord, recipe } from './flow/helpers.js'
  import { loadCar, remoteSource, carLinks } from './flow/car.js'
  import { buildFlow } from './flow/flowgraph.js'
  import { writeBlock, prevBody, clearsFor, landed } from './flow/ops.js'
  import { linkRemote } from './flow/net.js'

  let { guid: guidProp, fn: fnKey, query } = $props()

  // ---- module ----
  // module list / base ids change rarely; telemetry objects change 10x a second, so key on this string
  const busSig = $derived(JSON.stringify(live.devices.map((d) => [d.guid, d.name, d.baseId, d.type])))
  const modules = $derived.by(() => { busSig; return untrack(() => live.devices.filter((d) => isPdm(d) || isCanboard(d))) })
  const guid = $derived(guidProp ?? modules[0]?.guid)
  const dev = $derived(guid ? device(guid) : null)
  const devName = $derived(dev?.name ?? '')
  const mstate = $derived(dev ? moduleState(dev) : null)

  // ---- loaded config ----
  let funcs = $state.raw(null)
  let vmap = $state.raw([])
  let car = $state.raw(null)
  let loadErr = $state('')
  let loading = $state(false)
  async function reload() {
    const g = guid
    if (!g) return
    loading = true
    try {
      const [f, v] = await Promise.all([api.functions(g), api.inputs(g)])
      if (g !== guid) return
      funcs = f; vmap = v; loadErr = ''
    } catch (e) { loadErr = e?.message ?? String(e) }
    finally { loading = false }
  }
  async function reloadCar() { try { car = await loadCar(live.devices) } catch { car = null } }
  $effect(() => { guid; untrack(() => { funcs = null; reload(); undo = []; lastGroup = null; selId = fnKey ?? null }) })
  $effect(() => { if (live.devices.length && !car) untrack(reloadCar) })

  // PDM output config lives in telemetry; rebuild the model only when that config changes, not on every value tick
  const outSig = $derived(JSON.stringify((dev?.outputs ?? []).map((o) => [o.number, o.name, o.enabled, o.inputVal, o.variableDutyCycle, o.dutyCycleInput, o.variableFreq, o.freqInput, o.currentLimit, o.pwmEnabled, o.resetMode, o.resetTime, o.resetCountLimit])))
  const hasDev = $derived(!!dev)
  const model = $derived.by(() => { outSig; const f = funcs, v = vmap; return f && hasDev ? untrack(() => buildModel(dev, f, v)) : null })

  // ---- live values (shared with every node / edge / panel) ----
  const lv = $state({ v: {}, st: {}, sim: false, left: {}, tick: 0 })
  let signals = []
  $effect(() => {
    const g = guid
    if (!g) return
    let alive = true
    const tick = async () => {
      if (lv.sim) return
      try { const s = await api.signals(g); if (!alive) return; signals = s; if (model && !lv.sim) writeLive(lv.v, model, s, device(g)) } catch { /* poll again */ }
    }
    tick()
    const t = setInterval(tick, 250)
    return () => { alive = false; clearInterval(t) }
  })
  // outputs / battery / temp at the telemetry rate (10 Hz)
  $effect(() => { const d = dev; const m = model; if (d && m && !lv.sim) untrack(() => writeLive(lv.v, m, signals, d)) })

  // ---- simulate ----
  let sim = $state.raw(null)
  let simTimer = null
  function startSim() {
    if (!model) return
    sim = createSim(model, { ...lv.v })
    lv.sim = true
    sim.step(0)
    clearInterval(simTimer)
    simTimer = setInterval(() => {
      sim.step(50)
      for (const [k, v] of Object.entries(sim.vals)) if (lv.v[k] !== v) lv.v[k] = v
      for (const k of Object.keys(lv.st)) if (!(k in sim.status)) delete lv.st[k]
      for (const [k, v] of Object.entries(sim.status)) if (JSON.stringify(lv.st[k]) !== JSON.stringify(v)) lv.st[k] = v
      for (const k of Object.keys(sim.mem)) { const l = sim.timeLeft(k); if (lv.left[k] !== l) lv.left[k] = l }
    }, 50)
  }
  function stopSim() {
    clearInterval(simTimer); simTimer = null; sim = null
    lv.sim = false
    for (const k of Object.keys(lv.st)) delete lv.st[k]
    if (model) writeLive(lv.v, model, signals, dev)
  }
  $effect(() => () => clearInterval(simTimer))
  $effect(() => { model; untrack(() => { if (lv.sim) startSim() }) })   // edits while simulating restart the simulation

  // ---- groups (function / helper blocks) ----
  const projName = $derived(project.current ?? '')
  let gdata = $state({ groups: [], dismissed: [] })
  // reload when the module or the open project changes (opening a project restores its groups, G4)
  $effect(() => { const g = guid; projName; untrack(() => { gdata = loadGroups(g) }) })
  const groups = $derived(model ? pruneGroups(gdata.groups, model) : [])
  const suggestions = $derived(model ? suggest(model, groups, gdata.dismissed) : [])
  let lastGroup = $state(null)
  function setGroups(next, label) {
    const prev = JSON.parse(JSON.stringify(gdata))
    gdata = next
    saveGroups(guid, next)
    pushUndo({ label, groupsPrev: prev })
  }
  function replace(s) {
    const g = makeGroup(s)
    setGroups({ groups: [...gdata.groups, g], dismissed: gdata.dismissed }, `Group ${g.name}`)
    lastGroup = g.id
    selId = 'grp:' + g.id
    toast(`${s.members.length} blocks shown as the ${g.name} ${kindWord(g.kind)}. Nothing on ${devName} changed.`, 'info', 4000)
  }
  function replaceAll() {
    const add = suggestions.map(makeGroup)
    if (!add.length) return
    setGroups({ groups: [...gdata.groups, ...add], dismissed: gdata.dismissed }, `Group ${add.length} suggestions`)
    toast(`${add.length} groups made. The blocks on ${devName} are unchanged.`, 'info', 4000)
  }
  function dismiss(s) { setGroups({ groups: gdata.groups, dismissed: [...gdata.dismissed, s.key] }, 'Not now') }
  function groupAction(g, what) {
    if (what === 'open') setGroups({ groups: gdata.groups.map((x) => (x.id === g.id ? { ...x, expanded: !x.expanded } : x)), dismissed: gdata.dismissed }, g.expanded ? 'Close group' : 'Open group')
    else { setGroups({ groups: gdata.groups.filter((x) => x.id !== g.id), dismissed: gdata.dismissed }, `Ungroup ${g.name}`); if (selId === 'grp:' + g.id) selId = null; if (lastGroup === g.id) lastGroup = null }
  }
  const activeSug = $derived(suggestions[0] ?? null)
  const matchSet = $derived(new Set(activeSug?.members ?? []))
  const lastG = $derived(groups.find((g) => g.id === lastGroup) ?? null)

  // ---- cross-module links ----
  const remoteIn = $derived.by(() => {
    busSig
    const m = new Map()
    if (!model || !car) return m
    return untrack(() => remoteMap(m))
  })
  function remoteMap(m) {
    for (const n of model.nodes.values()) if (n.kind === 'caninput' && n.enabled) {
      const r = remoteSource(n.row, dev, live.devices, car.bcBy, car.idMap)
      if (r) m.set(n.id, { label: r.label, link: r.kind === 'module' ? { guid: r.dev.guid, node: r.node, name: r.dev.name } : null })
    }
    return m
  }
  const linksOut = $derived.by(() => {
    busSig
    if (!car || !guid) return []
    return untrack(() => carLinks(car, live.devices).filter((l) => l.from.guid === guid && l.from.node).map((l) => {
      const toMod = car.mods.find((p) => p.d.guid === l.to.guid)
      const ci = (toMod?.funcs?.canInputs ?? []).find((x) => 'caninput:' + x.number === l.to.node)
      return { from: l.from.node, toGuid: l.to.guid, toName: live.devices.find((d) => d.guid === l.to.guid)?.name ?? '?', toNode: l.to.node, toTitle: ci?.name ?? l.to.node, sig: l.sig, to: l.to }
    }))
  })
  const inspLinks = $derived(linksOut.map((l) => ({ from: { node: l.from }, to: l.to, toName: l.toName, toTitle: l.toTitle })))

  // ---- canvas ----
  const posKey = () => 'dingoNextFlowPos:' + guid
  const loadPos = () => { try { return JSON.parse(localStorage.getItem(posKey()) || '{}') } catch { return {} } }
  let pos = $state.raw({})
  $effect(() => { guid; untrack(() => { pos = loadPos() }) })
  let showLinks = $state(false)
  let nodes = $state.raw([])
  let edges = $state.raw([])
  let disp = $state.raw(new Map())
  $effect(() => {
    if (!model) { nodes = []; edges = []; return }
    const f = buildFlow(model, groups, { remoteIn, linksOut, pos, match: matchSet, lv, linkNodes: showLinks })
    untrack(() => {
      const sel = selId
      nodes = f.nodes.map((n) => (n.id === sel ? { ...n, selected: true } : n))
      edges = f.edges
      disp = f.disp
    })
  })
  const nodeTypes = { block: FlowNode }
  const edgeTypes = { wire: FlowEdge }
  let flow = null
  let fitted = false
  function onready(f) { flow = f }
  $effect(() => {
    if (nodes.length && flow && !fitted) {
      fitted = true
      setTimeout(() => { if (selId && disp.has(selId)) focusNode(selId); else fitOrTop() }, 60)
    }
  })
  // fit everything when it stays readable; otherwise start at the top-left at a readable zoom
  function fitOrTop() {
    if (!flow) return
    const el = document.querySelector('[data-testid=canvas]')
    const w = el?.clientWidth ?? 800, h = el?.clientHeight ?? 600
    const xs = nodes.map((n) => n.position.x), ys = nodes.map((n) => n.position.y)
    const bw = Math.max(...xs) - Math.min(...xs) + 260, bh = Math.max(...ys) - Math.min(...ys) + 300
    if (Math.min(w / bw, h / bh) >= 0.6) flow.fitView({ padding: 0.06, maxZoom: 1 })
    else flow.setViewport({ x: 16 - Math.min(...xs) * 0.7, y: 16 - Math.min(...ys) * 0.7, zoom: 0.7 })
  }
  function savePos() {
    const p = { ...pos }
    for (const n of nodes) p[n.id] = n.position
    pos = p
    try { localStorage.setItem(posKey(), JSON.stringify(p)) } catch {}
  }
  function tidy() {
    const prev = { ...pos }
    const auto = autoLayout(nodes.map((n) => n.data.n), edges)
    pos = auto
    try { localStorage.setItem(posKey(), JSON.stringify(auto)) } catch {}
    pushUndo({ label: 'Tidy', posPrev: prev })
    setTimeout(() => flow?.fitView({ padding: 0.1, maxZoom: 1 }), 60)
  }
  function focusNode(id) {
    const n = nodes.find((x) => x.id === id)
    if (!n || !flow) return
    flow.setCenter(n.position.x + 116, n.position.y + 80, { zoom: Math.max(0.8, flow.getViewport().zoom), duration: 200 })
  }

  // ---- selection ----
  let selId = $state(null)
  const selNode = $derived(selId ? disp.get(selId) ?? (model?.nodes.get(selId) ? { ...model.nodes.get(selId), remote: remoteIn.get(selId)?.label, remoteLink: remoteIn.get(selId)?.link } : null) : null)
  function select(id, center = false) {
    selId = id
    if (center) { view = 'canvas'; setTimeout(() => focusNode(id), 30) }
  }
  // keep the canvas selection in step with the inspector (selection can change from the list, Add, links…)
  $effect(() => {
    const s = selId
    untrack(() => { if (nodes.some((n) => !!n.selected !== (n.id === s))) nodes = nodes.map((n) => (!!n.selected === (n.id === s) ? n : { ...n, selected: n.id === s })) })
  })
  function onnodeclick({ node }) {
    selId = node.id
    if (node.data?.n?.kind === 'link') { /* the inspector lists the module it links to */ }
  }

  // ---- undo ----
  let undo = $state([])
  function pushUndo(e) { undo = [...undo.slice(-49), e] }
  let busy = $state(false)
  function undoLast() { const run = chain.then(undoNow); chain = run.catch(() => {}); return run }
  async function undoNow() {
    const e = undo.at(-1)
    if (!e) return
    undo = undo.slice(0, -1)
    if (e.groupsPrev) { gdata = e.groupsPrev; saveGroups(guid, e.groupsPrev); toast(`Undid: ${e.label}`, 'info', 2500); return }
    if (e.posPrev) { pos = e.posPrev; try { localStorage.setItem(posKey(), JSON.stringify(e.posPrev)) } catch {} toast('Undid: Tidy', 'info', 2500); return }
    busy = true
    try {
      let failed = 0
      for (const op of [...e.ops].reverse()) if ((await mutate(() => writeBlock(e.guid, op.id, op.prev))) === undefined) failed++
      toast(failed ? `Undid ${e.label} in the project; ${failed} write${failed === 1 ? '' : 's'} not confirmed by the module. Apply sends it again.` : `Undid: ${e.label}`, failed ? 'error' : 'info', failed ? 8000 : 3000)
    } finally { busy = false; await reload() }
  }

  /**
   * Run a list of writes [{id, body}] as one undoable step. Steps queue behind each other (a click while
   * a write is in flight waits for it). A refused write still changed the project record, so it is
   * included in the Undo step.
   */
  let chain = Promise.resolve()
  function apply(label, ops, okMsg) {
    const run = chain.then(() => applyNow(label, ops, okMsg))
    chain = run.catch(() => {})
    return run
  }
  async function applyNow(label, ops, okMsg) {
    busy = true
    const done = []
    let ok = true
    try {
      let last
      for (const op of ops) {
        const prev = prevBody(dev, funcs, op.id, op.body)
        done.push({ id: op.id, prev })
        last = await mutate(() => writeBlock(guid, op.id, op.body))
        if (last === undefined) { ok = false; break }
      }
      if (done.length) pushUndo({ label, guid, ops: done })
      if (ok) toast((okMsg ?? label) + ': ' + landed(last, dev), 'info', 3500)
      return ok
    } finally { busy = false; await reload() }
  }

  // ---- wiring on the canvas ----
  function realTarget(target, handle) {
    if (target.startsWith('grp:')) { const [m, f] = handle.split('/'); return { id: m, field: f } }
    return { id: target, field: handle }
  }
  function accepts(id, field) {
    const n = model?.nodes.get(id)
    return n?.ins.find((p) => p.id === field)?.accepts
  }
  function isValidConnection(c) {
    if (!model || c.target.startsWith('link:') || c.source === c.target) return false
    const { id, field } = realTarget(c.target, c.targetHandle)
    const idx = Number(String(c.sourceHandle).slice(1))
    const t = model.byIdx.get(idx)?.type === 'bool' ? 'bool' : 'num'
    return canWire(t, accepts(id, field))
  }
  let pwmConfirm = $state(null)
  async function onconnect(c) {
    const { id, field } = realTarget(c.target, c.targetHandle)
    const idx = Number(String(c.sourceHandle).slice(1))
    const tgt = model.nodes.get(id)
    if (!tgt) return
    if (id === 'sys' && idx === 1) { toast('"Always on" would keep the module asleep or muted for good. Use a real signal.', 'error', 6000); return }
    const ops = [{ id, body: { [field]: idx } }]
    const v = model.byIdx.get(idx)
    const srcId = v ? (v.kind === 'sys' ? 'sys' : v.kind === 'lua' ? 'lua' : `${v.kind}:${v.number}`) : null
    const src = srcId ? model.nodes.get(srcId) : null
    if (src && !src.enabled && (KINDS[src.kind]?.addable || src.kind === 'input')) ops.push({ id: src.id, body: { enabled: true } })
    await apply(`Wire ${src?.title ?? '#' + idx} → ${tgt.title}`, ops, `Wired ${src?.title ?? ''} to ${tgt.title} ${field === 'input' ? '' : '(' + field + ')'}`)
  }
  async function unwire(edge) {
    const { id, field } = realTarget(edge.target, edge.targetHandle)
    await apply(`Unwire ${model.nodes.get(id)?.title}`, [{ id, body: { [field]: 0 } }], `Disconnected ${model.nodes.get(id)?.title}`)
  }
  let selEdge = $state(null)
  function onedgeclick({ edge }) { selEdge = edge.data?.link ? null : edge }

  // ---- add / remove ----
  let addOpen = $state(false)
  let remoteOpen = $state(false)
  let sheetOpen = $state(false)
  async function addBlock(it) {
    const arr = KINDS[it.kind].arr
    // highest free slot: templates and the old UI claim from the bottom, so new blocks rarely collide with them
    const free = (funcs?.[arr] ?? []).findLast((x) => !x.enabled)
    if (!free) { toast(`No free ${KINDS[it.kind].label.toLowerCase()} slot on ${devName}.`, 'error'); return }
    addOpen = false
    const id = `${it.kind}:${free.number}`
    await apply(`Add ${it.label}`, [{ id, body: { enabled: true, ...(it.body ?? {}) } }], `Added ${it.label} (slot ${free.number})`)
    // select it once the project record has it (even when the module did not confirm the write)
    if ((funcs?.[arr] ?? []).find((x) => x.number === free.number)?.enabled) { selId = id; if (view === 'canvas') setTimeout(() => focusNode(id), 120) }
  }
  async function addRemote(r) {
    busy = true
    const prev = prevBody(dev, funcs, 'caninput:' + r.canInput, { enabled: 0, id: 0, ide: 0, startBit: 0, bitLength: 0, factor: 0, offset: 0, byteOrder: 0, signed: 0, name: '' })
    try {
      const res = await mutate(() => linkRemote(guid, r.canInput, r.sourceGuid, r.signal))
      if (res !== undefined) {
        pushUndo({ label: `Add ${r.label ?? r.signal}`, guid, ops: [{ id: 'caninput:' + r.canInput, prev }] })
        toast(`CAN input ${r.canInput} now reads ${res?.source ?? ''} ${r.label ?? r.signal}: ${landed(res, dev)}`, 'info', 4000)
        remoteOpen = false
        selId = 'caninput:' + r.canInput
      }
    } finally { busy = false; await reload(); await reloadCar() }
  }
  let removeAsk = $state(null)
  function askRemove(id) {
    const n = model?.nodes.get(id)
    if (!n) return
    if (!n.deletable) { toast(n.physical ? `${n.title} is a physical channel. Switch it off on its Hardware screen.` : `${n.title} can't be removed here.`, 'info', 5000); return }
    removeAsk = { id, title: n.title, clears: clearsFor(model, id) }
  }
  async function confirmRemove() {
    const r = removeAsk
    removeAsk = null
    if (!r) return
    const ok = await apply(`Remove ${r.title}`, [...r.clears, { id: r.id, body: { enabled: false } }], `Removed ${r.title}. Undo puts it back`)
    if (ok && selId === r.id) selId = null
  }

  // ---- keyboard ----
  function onkey(e) {
    const t = e.target
    const typing = t instanceof HTMLElement && (t.closest('input, textarea, select, [contenteditable], [role=listbox], [role=dialog]'))
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undoLast(); return }
    if (typing) return
    // Enter / Space on a focused block opens it in the inspector (Svelte Flow only selects it)
    if ((e.key === 'Enter' || e.key === ' ') && t instanceof HTMLElement && t.classList.contains('svelte-flow__node')) { selId = t.getAttribute('data-id'); return }
    if (e.key === '/' && view === 'canvas') { e.preventDefault(); addOpen = true; return }
    if ((e.key === 'Delete' || e.key === 'Backspace') && t instanceof HTMLElement && t.closest('.svelte-flow')) {
      if (t.closest('.svelte-flow__edge') && selEdge) { e.preventDefault(); unwire(selEdge); selEdge = null; return }
      if (selId && !selId.startsWith('grp:') && !selId.startsWith('link:')) { e.preventDefault(); askRemove(selId) }
    }
  }

  // ---- inspector save ----
  async function save(id, body, label) { await apply(label, [{ id, body }], `Saved ${model.nodes.get(id)?.title}`) }
  function openLink(l) { if (l?.guid) go('functions', 'flow', l.guid, l.node ?? '') }

  // ---- views / slots / apply ----
  let view = $state(untrack(() => query?.view) === 'sentence' ? 'sentence' : 'canvas')
  const slots = $derived(dev && funcs ? slotUsage(dev, funcs, defs) : [])
  const incomplete = $derived(model ? [...model.nodes.values()].filter((n) => n.incomplete?.length && !n.disabledSource).map((n) => ({ id: n.id, title: n.title, why: n.incomplete.join('; ') })) : [])
  let applyAsk = $state(false)
  function applyToCar() { if (incomplete.length) applyAsk = true; else ui.panel = 'apply' }

  // ---- search ----
  let q = $state('')
  const hits = $derived(q.trim() && model ? [...disp.values()].filter((n) => (n.title + ' ' + n.sub + ' ' + n.kindLabel).toLowerCase().includes(q.trim().toLowerCase())).slice(0, 12) : [])
  const modItems = $derived(modules.map((d) => ({ value: d.guid, label: d.name + ' · ' + (isCb(d) ? 'CANBoard' : d.type) })))
  const minimapColor = (n) => FAM_COLOR[n.data?.n?.fam] ?? 'var(--color-line-strong)'
  const famLegend = [['in', 'Inputs'], ['logic', 'Logic'], ['time', 'Time & state'], ['out', 'Outputs'], ['fn', 'Function / helper']]
</script>

<svelte:window onkeydown={onkey} />

{#if !live.devices.length}
  <Empty title="No modules in the project" text="Connect to the car or open a project to see its blocks.">{#snippet actions()}<Button variant="primary" onclick={() => (ui.panel = 'connect')}>Connect</Button>{/snippet}</Empty>
{:else if !dev}
  <Empty title="Module not found" text="This module is not in the project. Pick another one.">{#snippet actions()}{#each modules as d (d.guid)}<Button href={href('functions', 'flow', d.guid)}>{d.name}</Button>{/each}{/snippet}</Empty>
{:else}
<div class="fb" data-busy={busy}>
  <div class="bar">
    <nav aria-label="Breadcrumb" class="cr"><a href={href('functions')}>Functions</a><span aria-hidden="true">›</span><span aria-current="page">Flow builder</span></nav>
    <h1>{devName} · blocks</h1>
    <div class="msel"><Select label="Module" hideLabel items={modItems} value={guid} onchange={(v) => v !== guid && go('functions', 'flow', v)} data-testid="module-select" /></div>
    <StateDot tone={mstate.key} shape={mstate.shape} label={mstate.word} />
    <span class="grow"></span>
    <Segmented label="Builder view" items={[{ value: 'canvas', label: 'Canvas' }, { value: 'sentence', label: 'Sentence view' }]} bind:value={view} size="sm" />
    <Button size="sm" onclick={() => (addOpen = true)} data-testid="tool-add">+ Add</Button>
    <Button size="sm" onclick={tidy} disabled={view !== 'canvas'}>Tidy</Button>
    <Button size="sm" onclick={undoLast} disabled={!undo.length} title={undo.at(-1) ? 'Undo: ' + undo.at(-1).label : 'Nothing to undo'} data-testid="tool-undo">Undo{undo.length ? ' · ' + undo.at(-1).label.slice(0, 22) : ''}</Button>
    <Button size="sm" variant={lv.sim ? 'test' : 'secondary'} onclick={() => (lv.sim ? stopSim() : startSim())} aria-pressed={lv.sim} data-testid="tool-sim">{lv.sim ? '■ Stop simulating' : 'Simulate'}</Button>
    <Button size="sm" variant="primary" onclick={applyToCar} data-testid="tool-apply">Apply to car{#if incomplete.length}<span class="warnc"> ▲ {incomplete.length}</span>{/if}</Button>
  </div>

  {#if hub.state !== 'live' || live.stale}<Banner tone="warn" title="Live feed lost">Values on the blocks are stale until the feed returns.</Banner>{/if}
  {#if !dev.connected}<Banner tone="warn" title="{devName} is not on the bus">Edits are saved to the project only; Apply sends them once it is back. Live values are not available.</Banner>{/if}
  {#if dev.reading}<Banner tone="info" title="Reading {devName}">Reading the module's settings ({dev.readDone ?? 0} of {dev.readTotal ?? '?'}).</Banner>{/if}
  {#if loadErr}<Banner tone="fault" title="Could not load the blocks">{loadErr}{#snippet actions()}<Button size="sm" onclick={reload}>Try again</Button>{/snippet}</Banner>{/if}

  <div class="cols">
    <aside class="fb-pal" aria-label="Blocks">
      <Field label="Find a block or signal" bind:value={q} placeholder="coolant, timer, CAN 0x0C9…" data-testid="find" />
      {#if q.trim()}
        <ul class="hits" aria-label="Matching blocks">
          {#each hits as n (n.id)}<li><button type="button" class="hit" style="--fam: {FAM_COLOR[n.fam]}" onclick={() => select(n.id, true)}>{n.title}<span class="muted">{n.kindLabel}</span></button></li>{/each}
          {#if !hits.length}<li class="muted">No block matches.</li>{/if}
        </ul>
      {/if}

      <div class="sec">
        <span class="sh">FUNCTION AND HELPER BLOCKS</span>
        {#each groups as g (g.id)}
          <button type="button" class="grp" class:on={selId === 'grp:' + g.id} onclick={() => select(g.expanded ? g.members[0] : 'grp:' + g.id, true)}><span>{g.name}</span><span class="muted">{kindWord(g.kind)} · {g.members.length} blocks{g.expanded ? ' · open' : ''}</span></button>
        {/each}
        <p class="muted small">{suggestions.length ? `${suggestions.length} pattern${suggestions.length === 1 ? '' : 's'} here match a function or helper block.` : groups.length ? 'No more suggestions on this module.' : 'No pattern on this module matches a function or helper block.'}</p>
        {#if suggestions.length > 1}<Button size="sm" onclick={replaceAll} data-testid="replace-all">Replace all ({suggestions.length})</Button>{/if}
        <p class="muted small">Groups are kept in this browser for this project. They are not saved in the project file yet.</p>
        <Button size="sm" variant="ghost" onclick={() => (sheetOpen = true)}>Block sheet</Button>
      </div>

      <div class="sec" aria-label="Slots used">
        <span class="sh">SLOTS USED · {devName}</span>
        {#each slots as s (s.arr)}<Meter label={s.label} value={s.used} max={s.max} />{/each}
        <p class="muted small">Lua space is not reported by the module yet.</p>
      </div>
      <div class="sec">
        <span class="sh">FROM OTHER MODULES</span>
        <button type="button" class="remote" onclick={() => (remoteOpen = true)} data-testid="add-remote">+ Signal from another module (over CAN)</button>
        <a class="small" href={href('functions', 'whole-car')}>Whole car on one canvas ›</a>
      </div>
    </aside>

    <section class="stage" aria-label={view === 'canvas' ? 'Canvas' : 'Sentence view'}>
      {#if lv.sim}<div class="simbar" role="status">Simulating: nothing is sent to the car. Change inputs on the right; values and wires update.</div>{/if}
      {#if activeSug && !lv.sim}
        <div class="sug" role="region" aria-label="Suggestion">
          <span class="stag">SUGGESTION</span>
          <span class="st"><strong>{activeSug.members.length > 1 ? activeSug.members.length + ' blocks here match the ' : 'This block matches the '}{recipe(activeSug.recipe)?.name} {kindWord(recipe(activeSug.recipe)?.kind)}.</strong> <span class="muted">{activeSug.why} Replacing only groups them; the module runs the same blocks.</span></span>
          <span class="sb"><Button size="sm" variant="primary" onclick={() => replace(activeSug)} data-testid="sug-replace">Replace with {kindWord(recipe(activeSug.recipe)?.kind)}</Button>
          <Button size="sm" variant="ghost" onclick={() => dismiss(activeSug)} data-testid="sug-dismiss">Not now</Button></span>
        </div>
      {/if}
      {#if lastG && !lv.sim}
        <div class="sug used" role="region" aria-label="Group">
          <span class="stag alt">{kindWord(lastG.kind).toUpperCase()}</span>
          <span class="st"><strong>Using {lastG.name}.</strong> <span class="muted">It opens into the {lastG.members.length} blocks it groups; they still run as they are.</span></span>
          <span class="sb"><Button size="sm" onclick={() => groupAction(lastG, 'open')}>{lastG.expanded ? 'Close up' : 'Open inside'}</Button>
          <Button size="sm" variant="ghost" onclick={() => groupAction(lastG, 'undo')}>Undo</Button></span>
        </div>
      {/if}

      {#if !model}
        <p class="muted pad" role="status">{loading ? 'Reading the blocks…' : 'No blocks loaded.'}</p>
      {:else if view === 'sentence'}
        <SentenceView {model} {lv} selected={selId} onpick={(id) => (selId = id)} onopencanvas={(id) => select(id, true)} />
      {:else}
        <div class="canvas" data-testid="canvas">
          <SvelteFlow bind:nodes bind:edges {nodeTypes} {edgeTypes} colorMode={ui.theme === 'light' ? 'light' : 'dark'} minZoom={0.2} maxZoom={2}
            deleteKey={null} {onconnect} {isValidConnection} {onnodeclick} {onedgeclick} onpaneclick={() => (selEdge = null)} onnodedragstop={savePos}
            proOptions={{ hideAttribution: true }} defaultEdgeOptions={{ type: 'wire' }}>
            <FlowApi {onready} />
            <Background bgColor="var(--color-bg)" patternColor="var(--color-line)" gap={22} />
            <MiniMap pannable zoomable nodeColor={minimapColor} bgColor="var(--color-surface)" maskColor="var(--color-scrim)" ariaLabel="Mini map" />
            <Panel position="bottom-left">
              <div class="zoom">
                <button type="button" aria-label="Zoom in" onclick={() => flow?.zoomIn()}>+</button>
                <button type="button" aria-label="Zoom out" onclick={() => flow?.zoomOut()}>−</button>
                <button type="button" onclick={() => flow?.fitView({ padding: 0.06, maxZoom: 1 })}>Fit</button>
                <button type="button" aria-pressed={showLinks} onclick={() => (showLinks = !showLinks)} data-testid="toggle-links">{showLinks ? 'Hide' : 'Show'} links to other modules</button>
              </div>
            </Panel>
          </SvelteFlow>
          {#if selEdge}
            <div class="edgebar" role="status">Wire selected. <Button size="sm" variant="danger" onclick={() => { unwire(selEdge); selEdge = null }}>Disconnect</Button> <Button size="sm" variant="ghost" onclick={() => (selEdge = null)}>Keep</Button></div>
          {/if}
        </div>
        <div class="legend" aria-hidden="true">{#each famLegend as [f, l] (f)}<span><span class="lg" style="background: {FAM_COLOR[f]}"></span>{l}</span>{/each}<span>■ number wire (dashed)</span><span>CAN = travels over CAN</span><span>Drag from an output ● to an input ● · Tab walks blocks, Enter opens one, Delete removes (Undo), / adds a block</span></div>
      {/if}
    </section>

    <aside class="insp" aria-label="Inspector">
      {#if lv.sim && sim && model}<SimPanel {model} {sim} {lv} />{/if}
      {#if model}
        {#if selNode?.kind === 'link'}
          <span class="fam">LINK · READ OVER CAN</span>
          <h2 class="lh">{selNode.title}</h2>
          <p class="muted">These signals from {devName} are read by {selNode.linkTargets[0].toName}. The CAN link is set up on that module.</p>
          {#each selNode.linkTargets as l, i (i)}<button type="button" class="lnk" onclick={() => openLink({ guid: l.toGuid, node: l.toNode })}>→ {l.toTitle} (CAN input) ›</button>{/each}
        {:else}
          <Inspector {model} node={selNode} {dev} {lv} links={inspLinks} idMap={car?.idMap} {busy} onsave={save} onremove={askRemove} onselect={(id, c) => select(id, c)} onungroup={groupAction} onopenlink={openLink} />
        {/if}
      {/if}
    </aside>
  </div>
</div>

<AddDialog bind:open={addOpen} {funcs} {slots} onadd={addBlock} onremote={() => { addOpen = false; remoteOpen = true }} hardwareHref={href('hardware', 'module', guid)} />
<RemoteDialog bind:open={remoteOpen} {dev} {funcs} {busy} onlink={addRemote} />
<BlockSheet bind:open={sheetOpen} />
<ApplyCheck bind:open={applyAsk} items={incomplete} onapply={() => (ui.panel = 'apply')} onfinish={(id) => id && select(id, true)} />
<Dialog open={!!removeAsk} title={'Remove ' + (removeAsk?.title ?? '') + '?'} description="The slot is freed (switched off) on the module. Undo puts it back as it was." onclose={() => (removeAsk = null)}>
  {#if removeAsk?.clears.length}<p>{removeAsk.clears.length} input{removeAsk.clears.length === 1 ? '' : 's'} wired from it will be disconnected: {removeAsk.clears.map((c) => model?.nodes.get(c.id)?.title).join(', ')}.</p>{:else}<p class="muted">Nothing else reads it.</p>{/if}
  {#snippet footer()}<Button onclick={() => (removeAsk = null)}>Cancel</Button><Button variant="danger" onclick={confirmRemove} data-testid="confirm-remove">Remove</Button>{/snippet}
</Dialog>
{/if}

<style>
  .fb { height: 100%; min-height: 620px; display: flex; flex-direction: column; gap: var(--space-2); }
  .bar { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .cr { display: flex; gap: 6px; font-size: var(--text-sm); color: var(--color-text-muted); width: 100%; }
  .cr a { color: var(--color-text-muted); text-decoration: none; }
  .cr a:hover { color: var(--color-text); text-decoration: underline; }
  h1 { font-size: var(--text-xl); font-weight: 700; margin-right: var(--space-2); }
  .msel { width: 220px; }
  .grow { flex: 1 1 auto; }
  .warnc { color: var(--color-on-accent); font-weight: 700; }
  .cols { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 240px minmax(0, 1fr) 380px; border: 1px solid var(--color-line); border-radius: var(--radius-lg); overflow: hidden; background: var(--color-surface); }
  .fb-pal { border-right: 1px solid var(--color-line); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-3); overflow: auto; }
  .sec { display: flex; flex-direction: column; gap: 6px; padding-top: var(--space-2); border-top: 1px solid var(--color-line); }
  .sh { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); }
  .small { font-size: var(--text-xs); }
  .hits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .hit, .grp { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; min-height: 40px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--color-line); border-left: 3px solid var(--fam, var(--color-accent)); background: var(--color-raised); color: var(--color-text); text-align: left; font-size: 13px; }
  .hit .muted, .grp .muted { font-size: 11px; }
  .grp.on { border-color: var(--color-focus); }
  .remote { min-height: 40px; padding: 0 10px; border-radius: 8px; border: 1px dashed var(--color-line-strong); background: transparent; color: var(--color-text); text-align: left; font-size: 13px; }
  .stage { position: relative; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--color-bg); }
  .canvas { position: relative; flex: 1 1 auto; min-height: 0; }
  .canvas :global(.svelte-flow) { --xy-background-color: var(--color-bg); --xy-minimap-background-color: var(--color-surface); --xy-edge-stroke: var(--color-line-strong); --xy-node-border-radius: 12px; background: var(--color-bg); }
  .canvas :global(.svelte-flow__node-block) { padding: 0; border: 0; background: transparent; box-shadow: none; border-radius: 12px; }
  .canvas :global(.svelte-flow__minimap) { border: 1px solid var(--color-line); border-radius: var(--radius-md); }
  .simbar { margin: 10px 14px 0; padding: 8px 14px; border-radius: var(--radius-md); background: var(--color-warn-soft); color: var(--color-warn); font-weight: 600; }
  .sug { display: flex; align-items: center; gap: 10px; margin: 10px 14px 0; padding: 10px 14px; border-radius: var(--radius-md); border: 2px solid var(--color-accent); background: var(--color-surface); }
  .sug.used { border: 1px solid var(--color-line-strong); }
  .stag { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 6px; background: var(--color-accent); color: var(--color-on-accent); }
  .stag.alt { background: var(--color-raised); color: var(--color-accent); }
  .st { flex: 1 1 260px; min-width: 0; font-size: 13px; }
  .sb { display: flex; gap: 6px; flex: none; }
  .pad { padding: var(--space-4); }
  .zoom { display: flex; gap: 6px; }
  .zoom button { min-width: 36px; height: 36px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--color-line); background: var(--color-surface); color: var(--color-text); }
  .edgebar { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); z-index: 5; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: var(--radius-md); border: 1px solid var(--color-line-strong); background: var(--color-surface); box-shadow: var(--shadow-2); }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; padding: 6px 14px; font-size: 12px; color: var(--color-text-muted); border-top: 1px solid var(--color-line); background: var(--color-surface); }
  .lg { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .insp { border-left: 1px solid var(--color-line); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); overflow: auto; }
  .fam { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); }
  .lh { font-size: 22px; }
  .lnk { text-align: left; background: transparent; border: 0; padding: 6px 0; min-height: 32px; color: var(--color-accent); font-weight: 600; }
</style>
