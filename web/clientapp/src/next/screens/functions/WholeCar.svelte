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
  import { Page, PageHeader, Button, Banner, Empty, Chip } from '../../ui/index.js'
  import { live, hub, project, api } from '../../lib/live.svelte.js'
  import { href, go } from '../../router.svelte.js'
  import { ui } from '../../shell/ui.svelte.js'
  import CarNode from './flow/CarNode.svelte'
  import FlowEdge from './flow/FlowEdge.svelte'
  import FlowApi from './flow/FlowApi.svelte'
  import { loadCar, carLinks, carModels } from './flow/car.js'
  import { loadGroups, pruneGroups, kindWord } from './flow/helpers.js'
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

  // which blocks to show per module: logic, outputs, inputs that something reads, groups collapsed
  const COL_W = 300
  const graph = $derived.by(() => {
    const nodes = [], edges = []
    const linkedFrom = new Set(links.map((l) => l.from.guid + '|' + l.from.node))
    const linkedTo = new Set(links.map((l) => l.to.guid + '|' + l.to.node))
    const shownId = {}
    mods.forEach((m, ci) => {
      const g = m.dev.guid
      const groups = pruneGroups(loadGroups(g).groups, m.model).filter((x) => !x.expanded)
      const memberOf = new Map()
      for (const gr of groups) for (const id of gr.members) memberOf.set(id, gr)
      const keep = [...m.model.nodes.values()].filter((n) => {
        if (n.kind === 'sys' || memberOf.has(n.id)) return false
        if (n.kind === 'input' || n.kind === 'analoginput' || n.kind === 'lua' || n.kind === 'keypad') return linkedFrom.has(g + '|' + n.id) || n.outs.some((p) => m.model.consumers.has(p.idx))
        if (n.kind === 'caninput') return n.enabled && (linkedTo.has(g + '|' + n.id) || n.outs.some((p) => m.model.consumers.has(p.idx)))
        return n.enabled
      })
      const order = { in: 0, logic: 1, time: 2, code: 0, fn: 2, out: 3, dev: 4 }
      const list = [...keep.map((n) => ({ ...n, remote: n.kind === 'caninput' && linkedTo.has(g + '|' + n.id) })),
        ...groups.map((gr) => ({ id: 'grp:' + gr.id, kind: 'group', fam: 'fn', tag: gr.kind === 'fn' ? 'FUNCTION' : 'HELPER', kindLabel: kindWord(gr.kind), title: gr.name, outs: gr.members.flatMap((id) => m.model.nodes.get(id)?.outs ?? []).slice(-1), ins: [], members: gr.members }))]
        .sort((a, b) => (order[a.fam] ?? 5) - (order[b.fam] ?? 5) || a.title.localeCompare(b.title))
      const x = ci * COL_W
      nodes.push({ id: g + '#head', type: 'car', position: { x, y: 0 }, data: { head: true, n: { title: m.dev.name, sub: `${isCb(m.dev) ? 'CANBoard' : m.dev.type} · ${list.length} blocks`, connected: m.dev.connected } }, draggable: false, selectable: false, focusable: false, connectable: false })
      list.forEach((n, i) => {
        const id = g + '#' + n.id
        shownId[g + '|' + n.id] = id
        for (const mem of n.members ?? []) shownId[g + '|' + mem] = id
        nodes.push({ id, type: 'car', position: { x, y: 70 + i * 60 }, data: { n, vals: vals[g] ?? {}, guid: g, nodeId: n.id }, draggable: false, connectable: false, domAttributes: { 'aria-labelledby': `car-t-${id} car-s-${id}` } })
      })
      // wires inside a module are left to its flow builder: this canvas shows what travels between modules
    })
    links.forEach((l, i) => {
      const s = shownId[l.from.guid + '|' + l.from.node], t = shownId[l.to.guid + '|' + l.to.node]
      const fm = mods.find((m) => m.dev.guid === l.from.guid)
      const p = portForSignal(fm?.model.nodes.get(l.from.node), l.sig?.name)
      if (s && t) edges.push({ id: 'link' + i, source: s, target: t, type: 'wire', data: { lv: { v: vals[l.from.guid] ?? {} }, idx: p?.idx, type: p?.type ?? 'bool', link: true }, selectable: false, zIndex: 1 })
    })
    return { nodes, edges }
  })
  let nodes = $state.raw([])
  let edges = $state.raw([])
  $effect(() => { const gr = graph; untrack(() => { nodes = gr.nodes; edges = gr.edges }) })
  const counts = $derived({ blocks: graph.nodes.filter((n) => !n.data.head).length, groups: graph.nodes.filter((n) => n.data.n?.kind === 'group').length, links: links.length })
  let flow = null
  let fitted = false
  $effect(() => { if (nodes.length && flow && !fitted) { fitted = true; setTimeout(() => flow?.fitView({ padding: 0.05 }), 80) } })
  const openNode = (node) => { if (node?.data?.guid) go('functions', 'flow', node.data.guid, node.data.nodeId) }
  function onkey(e) {
    if (e.key !== 'Enter') return
    const el = e.target instanceof HTMLElement ? e.target.closest('.svelte-flow__node') : null
    if (!el) return
    const n = nodes.find((x) => x.id === el.getAttribute('data-id'))
    if (n && !n.data.head) { e.preventDefault(); openNode(n) }
  }
  const nodeTypes = { car: CarNode }
  const edgeTypes = { wire: FlowEdge }
</script>

<Page wide>
  <PageHeader crumbs={[{ label: 'Functions', href: href('functions') }, { label: 'Whole car' }]} title="Whole car" subtitle={car ? `${mods.length} modules · ${counts.blocks} blocks · ${counts.groups} function / helper blocks · ${counts.links} signals travel over CAN` : 'Every module on one canvas'}>
    {#snippet actions()}<Button onclick={() => { car = null; fitted = false; load() }} busy={loading}>Refresh</Button>{/snippet}
  </PageHeader>
  {#if hub.state !== 'live' || live.stale}<Banner tone="warn" title="Live feed lost">Values are stale until the feed returns.</Banner>{/if}
  {#if err}<Banner tone="fault" title="Could not read every module">{err}</Banner>{/if}
  {#if !live.devices.length}
    <Empty title="No modules in the project" text="Connect to the car or open a project.">{#snippet actions()}<Button variant="primary" onclick={() => (ui.panel = 'connect')}>Connect</Button>{/snippet}</Empty>
  {:else if !car}
    <p class="muted" role="status">Reading every module's blocks…</p>
  {:else}
    <div class="wc" onkeydown={onkey} role="presentation" data-testid="whole-car">
      <SvelteFlow bind:nodes bind:edges {nodeTypes} {edgeTypes} colorMode={ui.theme === 'light' ? 'light' : 'dark'} minZoom={0.1} maxZoom={1.5} nodesConnectable={false} deleteKey={null}
        onnodeclick={({ node }) => !node.data.head && openNode(node)} proOptions={{ hideAttribution: true }}>
        <FlowApi onready={(f) => (flow = f)} />
        <Background bgColor="var(--color-bg)" patternColor="var(--color-line)" gap={22} />
        <MiniMap pannable zoomable nodeColor={(n) => FAM_COLOR[n.data?.n?.fam] ?? 'var(--color-line-strong)'} bgColor="var(--color-surface)" maskColor="var(--color-scrim)" ariaLabel="Mini map" />
        <Panel position="bottom-left"><div class="zoom">
          <button type="button" aria-label="Zoom in" onclick={() => flow?.zoomIn()}>+</button>
          <button type="button" aria-label="Zoom out" onclick={() => flow?.zoomOut()}>−</button>
          <button type="button" onclick={() => flow?.fitView({ padding: 0.05 })}>Fit</button>
        </div></Panel>
      </SvelteFlow>
    </div>
    <div class="legend"><span><span class="lg on"></span> on</span><span>thick dotted wire = a signal that travels over CAN between modules</span><Chip tone="accent" solid>FUNCTION / HELPER</Chip><span>Click or press Enter on a block to open its module's flow builder.</span></div>
  {/if}
</Page>

<style>
  .wc { height: calc(100vh - 230px); min-height: 520px; border: 1px solid var(--color-line); border-radius: var(--radius-lg); overflow: hidden; }
  .wc :global(.svelte-flow) { --xy-background-color: var(--color-bg); background: var(--color-bg); }
  .wc :global(.svelte-flow__node-car) { padding: 0; border: 0; background: transparent; }
  .zoom { display: flex; gap: 6px; }
  .zoom button { min-width: 36px; height: 36px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--color-line); background: var(--color-surface); color: var(--color-text); }
  .legend { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--color-text-muted); }
  .lg { display: inline-block; width: 12px; height: 12px; border-radius: 3px; border: 2px solid var(--color-on); vertical-align: -2px; }
</style>
