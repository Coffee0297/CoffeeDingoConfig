// Turns the block model into Svelte Flow nodes + edges: collapses grouped blocks into one function /
// helper node, adds link nodes for signals other modules read over CAN, marks cross-module CAN inputs.
import { autoLayout, nodeHeight, NODE_W } from './model.js'
import { kindWord } from './helpers.js'

const PROP_OF_SUFFIX = { Pos: 'Rotary Position', Millivolts: 'Millivolts', State: null, Current: 'Current', Value: 'Value' }
/** The out port on `node` that a broadcast signal carries (or null). */
export function portForSignal(node, sigName) {
  if (!node) return null
  const suf = /\.(\w+)$/.exec(sigName ?? '')?.[1]
  if (suf === 'DutyCycle' || suf === 'ResetCount' || suf === 'DigitalMode') return null
  const prop = suf ? PROP_OF_SUFFIX[suf] : null
  if (prop) return node.outs.find((p) => p.prop === prop) ?? null
  return node.outs.find((p) => p.type === 'bool') ?? node.outs[0] ?? null
}

/**
 * model, groups (records), opts: { remoteIn: Map<nodeId, {label, link}>, linksOut: [{toGuid,toName,toNode,toTitle,from,sig}],
 *   pos: {id: {x,y}}, match: Set<nodeId>, lv }
 */
export function buildFlow(model, groups, opts) {
  const { remoteIn = new Map(), linksOut = [], pos = {}, match = new Set(), lv, linkNodes = false } = opts
  const readers = (id) => [...new Set(linksOut.filter((l) => l.from === id).map((l) => l.toName))]
  const collapsed = groups.filter((g) => !g.expanded)
  const memberOf = new Map()
  for (const g of collapsed) for (const m of g.members) memberOf.set(m, g)
  const expandedOf = new Map()
  for (const g of groups.filter((x) => x.expanded)) for (const m of g.members) expandedOf.set(m, g)

  const show = []   // display nodes (model node copies)
  for (const n of model.nodes.values()) {
    if (memberOf.has(n.id)) continue
    const r = remoteIn.get(n.id)
    const eg = expandedOf.get(n.id)
    const rd = readers(n.id)
    show.push({ ...n, linkOut: rd.length ? 'read by ' + rd.join(', ') : null, remote: r?.label ?? null, remoteLink: r?.link ?? null, match: match.has(n.id), sub: eg ? `in ${eg.name} · ${n.sub}` : n.sub, inGroup: eg ?? null })
  }
  for (const g of collapsed) {
    const mem = new Set(g.members)
    const ms = g.members.map((id) => model.nodes.get(id)).filter(Boolean)
    const ins = [], outs = []
    for (const m of ms) {
      for (const p of m.ins) {
        const src = p.src ? model.byIdx.get(p.src) : null
        const srcNode = src ? (src.kind === 'sys' ? 'sys' : src.kind === 'lua' ? 'lua' : `${src.kind}:${src.number}`) : null
        if (srcNode && mem.has(srcNode)) continue
        if (!p.src && p.optional) continue
        ins.push({ ...p, id: `${m.id}/${p.id}`, label: (ms.length > 1 ? short(m.title) + ' · ' : '') + p.label, member: m.id, field: p.id })
      }
      for (const p of m.outs) {
        const cons = model.consumers.get(p.idx) ?? []
        const outside = cons.some((c) => !mem.has(c.node)) || linksOut.some((l) => l.from === m.id)
        const inside = cons.some((c) => mem.has(c.node))
        if (outside || (!inside && p.type === 'bool')) outs.push({ ...p, label: (ms.length > 1 ? short(m.title) + ' · ' : '') + p.label })
      }
    }
    show.push({ id: 'grp:' + g.id, kind: 'group', fam: 'fn', tag: g.kind === 'fn' ? 'FUNCTION' : 'HELPER', kindLabel: kindWord(g.kind), title: g.name, sub: `${kindWord(g.kind)} · ${ms.length} block${ms.length === 1 ? '' : 's'} inside`,
      ins, outs, incomplete: ms.flatMap((m) => m.incomplete ?? []), group: g, row: null, enabled: true, deletable: false })
  }
  // link nodes: one per module that reads something from here
  const byDest = new Map()
  for (const l of linksOut) { if (!byDest.has(l.toGuid)) byDest.set(l.toGuid, []); byDest.get(l.toGuid).push(l) }
  for (const [guid, ls] of linkNodes ? byDest : []) {
    const ins = []
    for (const l of ls) {
      const srcShown = memberOf.has(l.from) ? null : l.from
      const p = portForSignal(model.nodes.get(l.from), l.sig?.name)
      if (!p) continue
      ins.push({ id: l.toNode, label: l.toTitle, accepts: p.type, src: p.idx, optional: true, fromNode: srcShown ?? 'grp:' + memberOf.get(l.from)?.id })
    }
    if (!ins.length) continue
    show.push({ id: 'link:' + guid, kind: 'link', fam: 'link', kindLabel: 'Link', title: '→ ' + ls[0].toName, sub: `read over CAN · ${ins.length} signal${ins.length === 1 ? '' : 's'}`, ins, outs: [], incomplete: [], linkOut: 'click to open ' + ls[0].toName, linkGuid: guid, linkTargets: ls, row: null, enabled: true, deletable: false })
  }

  const disp = new Map(show.map((n) => [n.id, n]))
  const mapId = (id) => (memberOf.has(id) ? 'grp:' + memberOf.get(id).id : id)
  const edges = []
  for (const e of model.edges) {
    const s = mapId(e.source), t = mapId(e.target)
    if (s === t && memberOf.has(e.source)) continue
    if (!disp.has(s) || !disp.has(t)) continue
    const th = memberOf.has(e.target) ? `${e.target}/${e.targetHandle}` : e.targetHandle
    edges.push({ id: e.id, source: s, sourceHandle: e.sourceHandle, target: t, targetHandle: th, type: 'wire', data: { lv, idx: e.idx, type: e.type }, ariaLabel: `${disp.get(s).title} to ${disp.get(t).title}` })
  }
  for (const n of show) if (n.kind === 'link') for (const p of n.ins) {
    const from = disp.get(p.fromNode)
    if (!from) continue
    edges.push({ id: `${n.id}|${p.id}`, source: from.id, sourceHandle: 'v' + p.src, target: n.id, targetHandle: p.id, type: 'wire', selectable: false, data: { lv, idx: p.src, type: p.accepts, link: true }, ariaLabel: `${from.title} to ${n.title}` })
  }

  for (const n of show) n.h = nodeHeight(n)
  const auto = autoLayout(show, edges)
  const nodes = show.map((n) => ({
    id: n.id, type: 'block', position: pos[n.id] ?? auto[n.id] ?? { x: 0, y: 0 },
    data: { n, lv }, deletable: false, width: NODE_W,
    domAttributes: { 'aria-labelledby': `blk-t-${n.id} blk-s-${n.id}` },
  }))
  return { nodes, edges, disp }
}
const short = (t) => (t.length > 14 ? t.slice(0, 13) + '…' : t)
