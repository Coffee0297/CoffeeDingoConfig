<script>
  import { Handle, Position } from '@xyflow/svelte'
  let { id, data } = $props()   // svelte-flow passes the node id as a prop
  // data: { kind, label, sub, color, remote, deletable, onDelete, onRename, fnLive (store),
  //         inPorts:[{id,label,type}], outPorts:[{id,label,type}], values:{id:str}, status:{text,tone} }
  const inPorts = $derived(data.inPorts ?? (data.inputs ?? []).map((id) => ({ id, label: id })))
  const outPorts = $derived(data.outPorts ?? (data.outs ?? ['out']).map((id) => ({ id, label: id })))
  // Live readouts come from the shared store keyed by node id — updating them never re-renders the
  // node container or its handles, so the dots don't jump while you're wiring.
  const live = data.fnLive
  const lv = $derived(live ? $live?.[id] : null)
  const values = $derived(lv?.values ?? data.values ?? {})
  const status = $derived(lv?.status ?? data.status)
  // Suppress the STATUS line when it adds nothing beyond the port values — i.e. it just echoes the
  // single out-port's value (e.g. a digital input showing "STATE … off" in the row AND "STATUS [OFF]").
  const norm = (s) => String(s ?? '').trim().toLowerCase()
  const showStatus = $derived.by(() => {
    if (!status || !norm(status.text)) return false
    if (outPorts.length === 1) {
      const pv = norm(values[outPorts[0].id])
      if (pv && pv === norm(status.text)) return false
    }
    return true
  })
  const HEADER = 22, PADY = 7, ROW = 18, SUBH = 15
  const rows = $derived(Math.max(inPorts.length, outPorts.length))
  // rows are absolutely positioned starting at PADY; the body must include that top offset AND a
  // matching bottom pad, otherwise it's PADY too short and the following fn-status border-top cuts
  // through the last row's text (the user-reported "separator through the text" bug).
  const bodyH = $derived(PADY + rows * ROW + PADY)
  const rowTop = (i) => PADY + i * ROW
  // handles are absolute from the node top, so they must clear the header AND the sub-line (if any)
  const handleTop = (i) => HEADER + (data.sub ? SUBH : 0) + PADY + i * ROW + ROW / 2 - 1
  const tyShort = { bool: 'B', int: 'I', real: 'R' }
  const valClass = (v) => { const s = String(v).toLowerCase(); return s === 'on' ? 'on' : s === 'off' ? 'off' : '' }
  const toneClass = (t) => {
    const s = (t || '').toLowerCase()
    if (s.includes('on') && !s.includes('off')) return 'on'
    if (s.includes('fault') || s.includes('overc') || s.includes('oc') || s.includes('err')) return 'err'
    if (s.includes('invalid') || s.includes('warn') || s.includes('open')) return 'warn'
    return ''
  }
  // inline rename
  let editing = $state(false), draft = $state('')
  function startEdit() { if (!data.onRename) return; draft = data.label; editing = true }
  function commit() { if (!editing) return; editing = false; const v = draft.trim(); if (v && v !== data.label) data.onRename(v) }
  function focusMount(node) { node.focus(); node.select?.() }
</script>

<div class="fnnode" class:remote={data.remote} style="--c:{data.color}">
  <div class="fn-hd" style="background:{data.color}">
    <span class="fn-kind">[{data.kind}]</span>
    {#if editing}
      <input class="fn-edit" bind:value={draft} onblur={commit} onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') editing = false }} use:focusMount />
    {:else}
      <span class="fn-ttl" title={data.onRename ? 'Double-click to rename' : ''} ondblclick={(e) => { e.stopPropagation(); startEdit() }}>{data.label}</span>
    {/if}
    {#if data.onSettings}<button class="fn-gear" title="Open this item's settings" aria-label={'Settings for ' + data.label} onclick={(e) => { e.stopPropagation(); data.onSettings() }}>⚙</button>{/if}
    {#if data.deletable}<button class="fn-del" title="Delete this block" aria-label={'Delete ' + data.label} onclick={(e) => { e.stopPropagation(); data.onDelete?.() }}>✕</button>{/if}
  </div>

  {#if data.sub}<div class="fn-sub">{data.sub}</div>{/if}

  <div class="fn-body" style="height:{bodyH}px">
    {#each inPorts as p, i}
      <!-- value hugs the (left) handle, then type chip, then label toward the centre -->
      <div class="fn-row l" style="top:{rowTop(i)}px">
        {#if values[p.id] != null && values[p.id] !== ''}<span class="val {valClass(values[p.id])}">{values[p.id]}</span>{/if}
        {#if p.type}<span class="ty {p.type}" title={p.type}>{tyShort[p.type] ?? '?'}</span>{/if}
        <span class="lbl">{p.label}</span>
      </div>
    {/each}
    {#each outPorts as p, i}
      <!-- label toward the centre, then type chip, then value hugging the (right) handle -->
      <div class="fn-row r" style="top:{rowTop(i)}px">
        <span class="lbl">{p.label}</span>
        {#if p.type}<span class="ty {p.type}" title={p.type}>{tyShort[p.type] ?? '?'}</span>{/if}
        {#if values[p.id] != null && values[p.id] !== ''}<span class="val {valClass(values[p.id])}">{values[p.id]}</span>{/if}
      </div>
    {/each}
  </div>

  {#if showStatus}<div class="fn-status">STATUS <b class={toneClass(status.tone ?? status.text)}>[{status.text || '—'}]</b></div>{/if}

  {#each inPorts as p, i}
    <Handle type="target" position={Position.Left} id={p.id} class="h-in" style="top:{handleTop(i)}px" title={'input: ' + p.label} />
  {/each}
  {#each outPorts as p, i}
    <Handle type="source" position={Position.Right} id={p.id} class="h-out" style="top:{handleTop(i)}px" title={'output: ' + p.label} />
  {/each}
</div>

<style>
  .fnnode { background: var(--surface, #14141c); border: 1.5px solid var(--c, #999); border-radius: 7px;
    min-width: 212px; font-size: 12px; box-shadow: 0 2px 10px rgba(0,0,0,.35); position: relative; color: var(--ink, #e7e7ef); }
  .fnnode.remote { border-style: dashed; }
  :global(.svelte-flow__node.selected) .fnnode { box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 55%, transparent); }
  .fn-hd { height: 22px; box-sizing: border-box; color: #fff; font-size: 10px; font-weight: 700; letter-spacing: .02em;
    padding: 0 8px; border-radius: 5px 5px 0 0; display: flex; align-items: center; gap: 6px; overflow: hidden; }
  /* header text sits on an arbitrary node color — a dark shadow keeps white legible on light tones too */
  .fn-kind, .fn-ttl { text-shadow: 0 1px 2px rgba(0,0,0,.55); }
  .fn-kind { opacity: .9; text-transform: uppercase; flex: none; }
  .fn-ttl { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: text; flex: 1; }
  .fn-edit { flex: 1; min-width: 0; font: inherit; font-weight: 600; color: #111; background: #fff; border: 0; border-radius: 3px; padding: 0 4px; }
  /* solid dark chip so the ⚙/✕ glyphs are legible on every node color (translucent-white failed on light headers) */
  .fn-gear, .fn-del { margin-left: 3px; background: rgba(0,0,0,.4); color: #fff; border: 0; border-radius: 4px;
    cursor: pointer; font-size: 10px; line-height: 1; padding: 1px 4px; flex: none; }
  .fn-gear:hover, .fn-del:hover { background: rgba(0,0,0,.62); }
  .fn-sub { font-size: 10px; color: var(--muted, #9a9ab0); padding: 3px 9px 0; font-family: var(--mono, monospace); }
  .fn-body { position: relative; }
  .fn-row { position: absolute; height: 18px; display: flex; align-items: center; gap: 5px; font-size: 11px; line-height: 1; max-width: 62%; }
  .fn-row.l { left: 10px; }
  .fn-row.r { right: 10px; flex-direction: row; justify-content: flex-end; }
  /* force every part onto one centred line — the page's global line-height:1.5 otherwise makes the
     label's line-box taller than the chip/value and rides it a few px high */
  /* margin:0 overrides the app's GLOBAL .lbl class (form-label margin-bottom:10px) which collides
     with our node label and pushed it ~3px high in the flex row. line-height:1 beats the global 1.5. */
  .fn-row .lbl, .fn-row .val, .fn-row .ty { line-height: 1; vertical-align: middle; margin: 0; }
  .fn-row .lbl { color: var(--ink, #d9d9e6); white-space: nowrap; }
  .fn-row .val { color: #e9edf6; font-family: var(--mono, monospace); font-size: 11px; font-weight: 600; min-width: 14px; text-align: center; }
  .fn-row .val.on { color: #34d27b; } .fn-row .val.off { color: var(--muted, #9a9ab8); font-weight: 500; }
  .ty { display: inline-flex; align-items: center; justify-content: center; height: 14px; min-width: 14px; box-sizing: border-box;
    font-size: 8px; font-weight: 700; line-height: 1; padding: 0 2px; border-radius: 3px; flex: none; }
  .ty.bool { background: #1f6f50; color: #bdf0d4; } .ty.int { background: #26408b; color: #c2d0ff; } .ty.real { background: #7a5a12; color: #f3dca0; }
  .fn-status { border-top: 1px solid color-mix(in srgb, var(--c) 35%, transparent); padding: 4px 9px 6px;
    font-size: 9.5px; letter-spacing: .04em; color: var(--muted, #9a9ab0); }
  .fn-status b { color: var(--muted, #9a9ab0); font-family: var(--mono, monospace); }
  .fn-status b.on { color: #2fbf71; } .fn-status b.err { color: #e5484d; } .fn-status b.warn { color: #f5a524; }
  :global(.svelte-flow .fnnode .svelte-flow__handle) { width: 11px; height: 11px; border: 2px solid var(--surface, #14141c); }
  :global(.svelte-flow .fnnode .svelte-flow__handle.h-in) { background: #2a9d8f; }
  :global(.svelte-flow .fnnode .svelte-flow__handle.h-out) { background: #594ae2; }
  /* highlight on hover WITHOUT moving/resizing the dot (scale made it jump under the cursor) */
  :global(.svelte-flow .fnnode .svelte-flow__handle:hover) { box-shadow: 0 0 0 4px rgba(255, 255, 255, .3); }
</style>
