<script>
  /**
   * One block on the canvas (Svelte Flow custom node). data: { n, lv, link? }
   *  n  = model node (or a group / link node): title, sub, fam, ins[], outs[], incomplete[], tag, remote …
   *  lv = shared reactive live state { v: {idx: value}, st: {nodeId: {text, tone}}, sim } — read here so a
   *       10 Hz value tick never recreates the node or its handles.
   * Ports: outputs on the right, inputs on the left. Round handle = on/off, square = number.
   */
  import { Handle, Position } from '@xyflow/svelte'
  import { FAM_COLOR } from './model.js'
  import { fmt } from './livevals.js'

  let { id, data, selected } = $props()
  const n = $derived(data.n)
  const lv = $derived(data.lv)
  const vOf = (idx) => (idx ? lv.v[idx] : undefined)
  const anyOn = $derived(n.outs.some((p) => p.type === 'bool' && vOf(p.idx) === true))
  const st = $derived(lv.st[id])
  const stateWord = $derived(st?.text ?? (n.outs.find((p) => p.type === 'bool') ? (anyOn ? 'on' : vOf(n.outs.find((p) => p.type === 'bool').idx) === false ? 'off' : 'no live value') : ''))
  const pill = (v) => (v === true ? 'on' : v === false ? 'off' : 'num')
</script>

<div class="blk" class:sel={selected} class:on={anyOn} class:inc={n.incomplete?.length} class:fn={!!n.tag} class:link={n.fam === 'link'} class:off={n.disabledSource} style="--fam: {FAM_COLOR[n.fam] ?? FAM_COLOR.dev}">
  <div class="hd">
    <span class="bar" aria-hidden="true"></span>
    <span class="tt">
      <span class="t" id={'blk-t-' + id}>{n.title}</span>
      <span class="s">{n.sub}</span>
    </span>
    {#if n.tag}<span class="tag fnt">{n.tag}</span>{/if}
    {#if n.remote}<span class="tag can" title={'Travels over CAN: ' + n.remote}>CAN</span>{/if}
    {#if n.kind === 'lua'}<span class="tag lua">LUA</span>{/if}
    {#if n.incomplete?.length}<span class="tag bad" title={n.incomplete.join('; ')}>▲</span>{/if}
  </div>
  <span class="sr-only" id={'blk-s-' + id}>{n.kindLabel}{stateWord ? ', ' + stateWord : ''}{n.incomplete?.length ? ', unfinished: ' + n.incomplete.join(', ') : ''}</span>

  {#each n.outs as p (p.id)}
    <div class="row out">
      <span class="pill {pill(vOf(p.idx))}">{fmt(vOf(p.idx))}</span>
      <span class="lbl">{p.label}</span>
      <Handle type="source" position={Position.Right} id={p.id} class="pt {p.type} {vOf(p.idx) === true ? 'hot' : ''}" />
    </div>
  {/each}
  {#each n.ins as p (p.id)}
    <div class="row in" class:missing={!p.src && !p.optional}>
      <Handle type="target" position={Position.Left} id={p.id} class="pt {p.accepts === 'bool' ? 'bool' : 'num'} {p.src ? 'wired' : ''} {vOf(p.src) === true ? 'hot' : ''}" />
      <span class="lbl">{p.label}</span>
      {#if p.not}<span class="not">NOT</span>{/if}
      <span class="sp"></span>
      <span class="iv">{p.src ? fmt(vOf(p.src)) : p.optional ? '—' : 'pick'}</span>
    </div>
  {/each}
  {#if st && (st.tone === 'fault' || st.tone === 'warn' || n.kind === 'canoutput')}
    <div class="stl" data-tone={st.tone}>{st.tone === 'fault' ? '■ ' : st.tone === 'warn' ? '▲ ' : ''}{st.text}</div>
  {:else if n.incomplete?.length}
    <div class="stl" data-tone="fault">▲ {n.incomplete[0]}</div>
  {:else if n.remote}
    <div class="stl" data-tone="can">← {n.remote}</div>
  {:else if n.linkOut}
    <div class="stl" data-tone="can">→ {n.linkOut}</div>
  {/if}
</div>

<style>
  .blk { width: 232px; box-sizing: border-box; border-radius: 12px; border: 2px solid var(--color-line-strong); background: var(--color-surface); box-shadow: var(--shadow-1); color: var(--color-text); font-size: 13px; padding-bottom: 6px; }
  .blk.on { border-color: var(--color-on); box-shadow: 0 0 0 3px var(--color-on-soft); }
  .blk.fn { border-color: var(--color-accent); }
  .blk.link { border-style: dashed; }
  .blk.inc { border-color: var(--color-fault); border-style: dashed; }
  .blk.off { opacity: 0.8; border-style: dashed; }
  .blk.sel { border-color: var(--color-focus); box-shadow: 0 0 0 4px var(--color-raised), var(--shadow-2); }
  :global(.svelte-flow__node:focus-visible) { outline: none; }
  :global(.svelte-flow__node:focus-visible) .blk { outline: 3px solid var(--color-focus); outline-offset: 3px; }
  .hd { height: 52px; box-sizing: border-box; overflow: hidden; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 10px; border-bottom: 1px solid var(--color-line); border-radius: 10px 10px 0 0; background: var(--color-raised); margin-bottom: 2px; }
  .bar { flex: none; width: 4px; align-self: stretch; margin: 8px 0; border-radius: 2px; background: var(--fam); }
  .tt { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
  .t { font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s { font-size: 12px; color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag { flex: none; font-size: 11px; font-weight: 700; padding: 1px 5px; border-radius: 4px; border: 1px solid; line-height: 1.3; }
  .can { color: var(--color-on); border-color: var(--color-on); }
  .lua { color: var(--color-block-code); border-color: var(--color-block-code); }
  .fnt { color: var(--color-on-accent); background: var(--color-accent); border-color: var(--color-accent); }
  .bad { color: var(--color-fault); border-color: var(--color-fault); border-style: dashed; }
  .row { position: relative; height: 30px; box-sizing: border-box; white-space: nowrap; display: flex; align-items: center; gap: 8px; }
  .row.out { justify-content: flex-end; padding: 0 16px 0 12px; }
  .row.in { padding: 0 12px 0 16px; }
  .lbl { overflow: hidden; text-overflow: ellipsis; }
  .row.missing .lbl { color: var(--color-fault); }
  .pill { font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--color-raised); color: var(--color-text-muted); }
  .pill.on { background: var(--color-on-soft); color: var(--color-on); font-weight: 600; }
  .pill.num { color: var(--color-text); }
  .not { font-size: 11px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: var(--color-block-logic); color: var(--color-bg); }
  .sp { flex: 1 1 auto; }
  .iv { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); }
  .row.missing .iv { color: var(--color-fault); }
  .stl { margin: 4px 10px 0; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stl[data-tone='fault'] { color: var(--color-fault); }
  .stl[data-tone='warn'] { color: var(--color-warn); }
  .stl[data-tone='on'], .stl[data-tone='can'] { color: var(--color-on); }
  .stl[data-tone='off'] { color: var(--color-text-muted); }
  :global(.svelte-flow .pt.svelte-flow__handle) { width: 12px; height: 12px; border: 2px solid var(--color-line-strong); background: var(--color-bg); }
  :global(.svelte-flow .pt.bool.svelte-flow__handle) { border-radius: 50%; }
  :global(.svelte-flow .pt.num.svelte-flow__handle) { border-radius: 2px; }
  :global(.svelte-flow .pt.wired.svelte-flow__handle), :global(.svelte-flow .pt.svelte-flow__handle-right) { background: var(--color-surface); }
  :global(.svelte-flow .pt.hot.svelte-flow__handle) { border-color: var(--color-on); }
  :global(.svelte-flow .pt.svelte-flow__handle.connectingto.valid) { box-shadow: 0 0 0 4px var(--color-on-soft); border-color: var(--color-on); }
  :global(.svelte-flow .pt.svelte-flow__handle.connectingto:not(.valid)) { box-shadow: 0 0 0 4px var(--color-fault-soft); border-color: var(--color-fault); }
</style>
