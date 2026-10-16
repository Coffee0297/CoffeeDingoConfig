<script>
  /**
   * Whole car (FC6): every module's blocks on one read-mostly canvas, one column per module, with the
   * signals that travel between modules over CAN drawn as thick dashed links. Click (or Enter) a block to
   * open it in its module's flow builder. Function / helper groups made in the flow builder show as one
   * block here too (they are kept in this browser, see the flow builder).
   */
  import { SvelteFlow, Background, MiniMap, Panel } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import { untrack } from 'svelte'
  import { Page, PageHeader, Button, Banner, Empty, Chip, Checkbox } from '../../ui/index.js'
  import { live, hub, project, api } from '../../lib/live.svelte.js'
  import { href, go } from '../../router.svelte.js'
  import { ui } from '../../shell/ui.svelte.js'
  import CarNode from './flow/CarNode.svelte'
  import FlowEdge from './flow/FlowEdge.svelte'
  import FlowApi from './flow/FlowApi.svelte'
  import { loadCar, carLinks, carModels } from './flow/car.js'
  import { loadAllGroups, pruneGroups, kindWord } from './flow/helpers.js'
  import { writeLive } from './flow/livevals.js'
  import { FAM_COLOR, isCb } from './flow/model.js'
  import { portForSignal } from './flow/flowgraph.js'

  let car = $state.raw(null)
  let err = $state('')
  let loading = $state(false)
  async function load() {
    loading = true
    try { car = await loadCar(live.devices); err = '' } catch (e) { err = e?.message ?? String(e) } finally { loading = false }
  }
  $effect(() => { if (live.devices.length && !car && !loading) untrack(load) })

  const busSig = $derived(JSON.stringify(live.devices.map((d) => [d.guid, d.name, d.baseId, d.type])))
  // CANBoards (switch panels) on the left, PDMs to the right
  const mods = $derived.by(() => { busSig; if (!car) return []; return untrack(() => carModels(car, live.devices).sort((a, b) => Number(isCb(b.dev)) - Number(isCb(a.dev)) || a.dev.name.localeCompare(b.dev.name))) })
  const links = $derived.by(() => { busSig; return car ? untrack(() => carLinks(car, live.devices)) : [] })

  // live values per module: { [guid]: { [idx]: value } }
  const vals = $state({})
  const sigs = {}
  $effect(() => {
    const ms = mods
    if (!ms.length) return
    let alive = true, i = 0
    const t = setInterval(async () => {
      const m = ms[i++ % ms.length]
      try { const s = await api.signals(m.dev.guid); if (!alive) return; sigs[m.dev.guid] = s; vals[m.dev.guid] ??= {}; writeLive(vals[m.dev.guid], m.model, s, live.devices.find((d) => d.guid === m.dev.guid)) } catch { /* next round */ }
    }, 160)
    return () => { alive = false; clearInterval(t) }
  })
  $effect(() => { const ds = live.devices; untrack(() => { for (const m of mods) { vals[m.dev.guid] ??= {}; writeLive(vals[m.dev.guid], m.model, sigs[m.dev.guid] ?? [], ds.find((d) => d.guid === m.dev.guid)) } }) })
  // which blocks to show per module: logic, outputs, inputs that something reads, groups collapsed.
  // A module starts collapsed to the blocks that send or receive signals over CAN; "N more blocks" opens it.
  const COL_W = 300, HEAD_H = 44
  let groupsBy = $state({})   // G16: every module's group record, from the server
  $effect(() => { project.current; untrack(() => { loadAllGroups().then((r) => (groupsBy = r)) }) })
  let expandAll = $state(false), onlyLinks = $state(false)
  let opened = $state({})   // guid -> true: that column shows every block
  const toggleCol = (g) => (opened = { ...opened, [g]: !opened[g] })
  // hover / focus a block: its wires across modules light up (shared object, so no graph rebuild)
  const hl = $state({ on: false, e: {}, n: {} })
  const graph = $derived.by(() => {
    const nodes = [], edges = [], cols = []
    const linkedFrom = new Set(links.map((l) => l.from.guid + '|' + l.from.node))
    const linkedTo = new Set(links.map((l) => l.to.guid + '|' + l.to.node))
    const shownId = {}
    for (const m of mods) {
      const g = m.dev.guid
      const groups = pruneGroups(groupsBy[g]?.groups ?? [], m.model).filter((x) => !x.expanded)
      const memberOf = new Map()
      for (const gr of groups) for (const id of gr.members) memberOf.set(id, gr)
      const keep = [...m.model.nodes.values()].filter((n) => {
        if (n.kind === 'sys' || memberOf.has(n.id)) return false
        if (n.kind === 'input' || n.kind === 'analoginput' || n.kind === 'lua' || n.kind === 'keypad') return linkedFrom.has(g + '|' + n.id) || n.outs.some((p) => m.model.consumers.has(p.idx))
        if (n.kind === 'caninput') return n.enabled && (linkedTo.has(g + '|' + n.id) || n.outs.some((p) => m.model.consumers.has(p.idx)))
        return n.enabled
      })
      const order = { in: 0, logic: 1, time: 2, code: 0, fn: 2, out: 3, dev: 4 }
      const all = [...keep.map((n) => ({ ...n, remote: n.kind === 'caninput' && linkedTo.has(g + '|' + n.id) })),
        ...groups.map((gr) => ({ id: 'grp:' + gr.id, kind: 'group', fam: 'fn', tag: gr.kind === 'fn' ? 'FUNCTION' : 'HELPER', kindLabel: kindWord(gr.kind), title: gr.name, outs: gr.members.flatMap((id) => m.model.nodes.get(id)?.outs ?? []).slice(-1), ins: [], members: gr.members }))]
        .sort((a, b) => (order[a.fam] ?? 5) - (order[b.fam] ?? 5) || a.title.localeCompare(b.title))
      const linked = (id) => linkedFrom.has(g + '|' + id) || linkedTo.has(g + '|' + id)
      const isLinked = (n) => linked(n.id) || (n.members ?? []).some(linked)
      const open = !onlyLinks && (expandAll || !!opened[g])
      const list = open ? all : all.filter(isLinked)
      const hidden = all.length - list.length
      if (onlyLinks && !list.length) continue
      const x = cols.length * COL_W
      cols.push({ guid: g, name: m.dev.name, x, connected: m.dev.connected })
      nodes.push({ id: g + '#head', type: 'car', position: { x, y: 0 }, data: { head: true, n: { title: m.dev.name, sub: `${isCb(m.dev) ? 'CANBoard' : m.dev.type} · ${all.length} blocks${hidden ? ` · ${list.length} on CAN` : ''}`, connected: m.dev.connected } }, draggable: false, selectable: false, focusable: false, connectable: false })
      list.forEach((n, i) => {
        const id = g + '#' + n.id
        shownId[g + '|' + n.id] = id
        for (const mem of n.members ?? []) shownId[g + '|' + mem] = id
        nodes.push({ id, type: 'car', position: { x, y: 70 + i * 60 }, data: { n, vals: vals[g] ?? {}, guid: g, nodeId: n.id, hl }, draggable: false, connectable: false, domAttributes: { 'aria-labelledby': `car-t-${id} car-s-${id}` } })
      })
      // the expander closes a column that was opened on its own (Expand all opens every column)
      if (!onlyLinks && !expandAll && (hidden || opened[g]) && all.some((n) => !isLinked(n)))
        nodes.push({ id: g + '#more', type: 'car', position: { x, y: 70 + list.length * 60 }, data: { more: true, open: !!opened[g], col: g, n: { title: opened[g] ? 'Show only blocks on CAN ▴' : `${hidden} more block${hidden === 1 ? '' : 's'} ▾` } }, draggable: false, selectable: false, connectable: false, domAttributes: { 'aria-label': (opened[g] ? 'Show fewer blocks on ' : `Show ${hidden} more blocks on `) + m.dev.name } })
      // wires inside a module are left to its flow builder: this canvas shows what travels between modules
    }
    links.forEach((l, i) => {
      const s = shownId[l.from.guid + '|' + l.from.node], t = shownId[l.to.guid + '|' + l.to.node]
      const fm = mods.find((m) => m.dev.guid === l.from.guid)
      const p = portForSignal(fm?.model.nodes.get(l.from.node), l.sig?.name)
      if (s && t) edges.push({ id: 'link' + i, source: s, target: t, type: 'wire', data: { lv: { v: vals[l.from.guid] ?? {} }, idx: p?.idx, type: p?.type ?? 'bool', link: true, hl }, selectable: false, zIndex: 1 })
    })
    return { nodes, edges, cols }
  })
  let nodes = $state.raw([])
  let edges = $state.raw([])
  $effect(() => { const gr = graph; untrack(() => { nodes = gr.nodes; edges = gr.edges }) })
  function light(id) {
    const es = id ? edges.filter((e) => e.source === id || e.target === id) : []
    if (!es.length) { if (hl.on) { hl.on = false; hl.e = {}; hl.n = {} } return }
    hl.e = Object.fromEntries(es.map((e) => [e.id, true]))
    hl.n = Object.fromEntries(es.flatMap((e) => [[e.source, true], [e.target, true]]))
    hl.on = true
  }
  const blocks = (n) => !n.data.head && !n.data.more
  const counts = $derived({ blocks: graph.nodes.filter(blocks).length, groups: graph.nodes.filter((n) => n.data.n?.kind === 'group').length, links: links.length })
  const breakdown = $derived(`${counts.blocks} blocks shown, ${counts.groups} of them grouped as functions or helpers. The dotted wires are the signals that travel over CAN.`)
  let flow = null
  let wcEl = $state(null)
  let vp = $state({ x: 0, y: 0, zoom: 1 })
  let fitted = false
  $effect(() => { if (nodes.length && flow && !fitted) { fitted = true; setTimeout(() => fitWidth(false), 80) } })
  // fit the columns to the width (never below 0.4, where the titles stop being readable); scroll down for the rest
  function fitWidth(animate = true) {
    if (!flow || !graph.cols.length) return
    const w = wcEl?.clientWidth ?? 1200
    const zoom = Math.max(0.4, Math.min(1, (w - 76) / ((graph.cols.length - 1) * COL_W + 260)))
    const v = { x: 60, y: HEAD_H + 8, zoom }   // 60: clear of the zoom buttons
    flow.setViewport(v, animate ? { duration: 200 } : undefined); vp = v
  }
  function jumpTo(c) {
    if (!flow) return
    const zoom = Math.max(vp.zoom, 0.75)
    const v = { x: 60 - c.x * zoom, y: HEAD_H + 8, zoom }
    flow.setViewport(v, { duration: 250 }); vp = v
  }
  const openNode = (node) => {
    if (node?.data?.more) return toggleCol(node.data.col)
    if (node?.data?.guid) go('functions', 'flow', node.data.guid, node.data.nodeId)
  }
  const nodeAt = (t) => (t instanceof HTMLElement ? t.closest('.svelte-flow__node') : null)
  function onkey(e) {
    if (e.key !== 'Enter') return
    const el = nodeAt(e.target)
    if (!el) return
    const n = nodes.find((x) => x.id === el.getAttribute('data-id'))
    if (n && !n.data.head) { e.preventDefault(); openNode(n) }
  }
  const nodeTypes = { car: CarNode }
  const edgeTypes = { wire: FlowEdge }
</script>

<Page wide>
  <PageHeader crumbs={[{ label: 'Functions', href: href('functions') }, { label: 'Whole car' }]} title="Whole car" subtitle={car ? `${mods.length} modules · ${counts.links} signals travel over CAN` : 'Every module on one canvas'}>
    {#snippet tag()}{#if car}<span class="info" title={breakdown} aria-label={breakdown} role="img" data-testid="wc-breakdown">i</span>{/if}{/snippet}
    {#snippet actions()}<Button onclick={() => { car = null; fitted = false; load() }} busy={loading}>Refresh</Button>{/snippet}
  </PageHeader>
  {#if hub.state !== 'live' || live.stale}<Banner tone="warn" title="Live feed lost">Values are stale until the feed returns.</Banner>{/if}
  {#if err}<Banner tone="fault" title="Could not read every module">{err}</Banner>{/if}
  {#if !live.devices.length}
    <Empty title="No modules in the project" text="Connect to the car or open a project.">{#snippet actions()}<Button variant="primary" onclick={() => (ui.panel = 'connect')}>Connect</Button>{/snippet}</Empty>
  {:else if !car}
    <p class="muted" role="status">Reading every module's blocks…</p>
  {:else}
    <div class="tools">
      <Button size="sm" aria-pressed={expandAll} disabled={onlyLinks} onclick={() => { expandAll = !expandAll; opened = {} }} data-testid="wc-expand">{expandAll ? 'Collapse all' : 'Expand all'}</Button>
      <Checkbox bind:checked={onlyLinks} label="Only signals between modules" data-testid="wc-only-links" />
      <span class="muted hint">Hover a block to light up its wires. Hold space or the middle mouse button and drag to pan.</span>
    </div>
    <div class="wc" bind:this={wcEl} onkeydown={onkey} onfocusin={(e) => light(nodeAt(e.target)?.getAttribute('data-id'))} onfocusout={() => light(null)} role="presentation" data-testid="whole-car">
      <SvelteFlow bind:nodes bind:edges {nodeTypes} {edgeTypes} colorMode={ui.theme === 'light' ? 'light' : 'dark'} minZoom={0.4} maxZoom={1.5} nodesConnectable={false} deleteKey={null}
        panOnDrag={[0, 1]} panActivationKey="Space" onmove={(_, v) => (vp = v)}
        onnodeclick={({ node }) => !node.data.head && openNode(node)} onnodepointerenter={({ node }) => light(node.id)} onnodepointerleave={() => light(null)} proOptions={{ hideAttribution: true }}>
        <FlowApi onready={(f) => (flow = f)} />
        <Background bgColor="var(--color-bg)" patternColor="var(--color-line)" gap={22} />
        <MiniMap width={160} height={100} pannable zoomable nodeColor={(n) => FAM_COLOR[n.data?.n?.fam] ?? 'var(--color-line-strong)'} bgColor="var(--color-surface)" maskColor="var(--color-scrim)" ariaLabel="Mini map" />
        <Panel position="bottom-left"><div class="zoom" role="group" aria-label="Zoom">
          <button type="button" aria-label="Zoom in" title="Zoom in" onclick={() => flow?.zoomIn()}>+</button>
          <button type="button" aria-label="Zoom out" title="Zoom out" onclick={() => flow?.zoomOut()}>−</button>
          <button type="button" title="Fit the modules to the width" onclick={() => fitWidth()}>Fit</button>
        </div></Panel>
      </SvelteFlow>
      <nav class="heads" aria-label="Jump to a module" style="height: {HEAD_H}px">
        {#each graph.cols as c (c.guid)}
          <button type="button" class="hd" class:off={!c.connected} style="left: {vp.x + c.x * vp.zoom}px; width: {260 * vp.zoom}px" onclick={() => jumpTo(c)} title={'Go to ' + c.name}>{c.name}</button>
        {/each}
      </nav>
    </div>
    <div class="legend"><span><span class="lg on"></span> on</span><span>thick dotted wire = a signal that travels over CAN between modules</span><Chip tone="accent" solid>FUNCTION / HELPER</Chip><span>Click or press Enter on a block to open its module's flow builder.</span></div>
  {/if}
</Page>

<style>
  .info { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--color-line-strong); font-size: 12px; font-weight: 700; font-style: italic; color: var(--color-text-muted); cursor: help; }
  .tools { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
  .hint { font-size: var(--text-xs); }
  .wc { position: relative; height: calc(100vh - 300px); min-height: 480px; border: 1px solid var(--color-line); border-radius: var(--radius-lg); overflow: hidden; }
  .wc :global(.svelte-flow) { --xy-background-color: var(--color-bg); background: var(--color-bg); }
  .wc :global(.svelte-flow__node-car) { padding: 0; border: 0; background: transparent; }
  .wc :global(.svelte-flow__minimap) { border: 1px solid var(--color-line-strong); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-2); overflow: hidden; }
  .heads { position: absolute; top: 0; left: 0; right: 0; z-index: 5; overflow: hidden; pointer-events: none; background: color-mix(in srgb, var(--color-surface) 92%, transparent); border-bottom: 1px solid var(--color-line); }
  .hd { position: absolute; top: 6px; height: 32px; padding: 0 8px; pointer-events: auto; border-radius: 8px; border: 1px solid var(--color-line-strong); background: var(--color-raised); color: var(--color-text); font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hd.off { border-style: dashed; }
  .hd:hover { border-color: var(--color-focus); }
  .zoom { display: flex; flex-direction: column; border: 1px solid var(--color-line-strong); border-radius: 8px; overflow: hidden; background: var(--color-surface); box-shadow: var(--shadow-2); }
  .zoom button { width: 36px; height: 32px; padding: 0; border: 0; border-top: 1px solid var(--color-line); background: var(--color-surface); color: var(--color-text); font-size: 13px; font-weight: 600; }
  .zoom button:first-child, .zoom button:nth-child(2) { font-size: 16px; }
  .zoom button:first-child { border-top: 0; }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--color-text-muted); }
  .lg { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 2px solid var(--color-on); vertical-align: -2px; }
  @media (max-width: 900px) { .wc { height: 70vh; min-height: 420px; } .hint { display: none; } .wc :global(.svelte-flow__minimap) { display: none; } }
</style>
