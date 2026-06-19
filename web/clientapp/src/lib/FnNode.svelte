<script>
  import { Handle, Position } from '@xyflow/svelte'
  let { data } = $props()
  // data: { label, sub, kind, inputs:[field], outs:[port], color, remote, deletable, onDelete }
  const inputs = $derived(data.inputs ?? [])
  const outs = $derived(data.outs ?? (data.hasOut === false ? [] : ['out']))
  const rowH = 16
</script>

<div class="fnnode" class:remote={data.remote} style="border-color:{data.color}">
  <div class="fn-hd" style="background:{data.color}">
    <span>{data.kind}{#if data.remote} · {data.remote}{/if}</span>
    {#if data.deletable}<button class="fn-del" title="Delete this block" aria-label={'Delete ' + data.label} onclick={(e) => { e.stopPropagation(); data.onDelete?.() }}>✕</button>{/if}
  </div>
  <div class="fn-bd">
    <div class="fn-nm">{data.label}</div>
    {#if data.sub}<div class="fn-sub">{data.sub}</div>{/if}
  </div>
  {#each inputs as field, i}
    <Handle type="target" position={Position.Left} id={field} class="h-in" style="top:{32 + i * rowH}px" title={'input: ' + field} />
    {#if inputs.length > 1}<span class="fn-port l" style="top:{26 + i * rowH}px">{field.replace('Input', '').replace('var', 'in')}</span>{/if}
  {/each}
  {#each outs as port, i}
    <Handle type="source" position={Position.Right} id={port} class="h-out" style="top:{32 + i * rowH}px" title={'output: ' + port} />
    {#if outs.length > 1}<span class="fn-port r" style="top:{26 + i * rowH}px">{port}</span>{/if}
  {/each}
</div>

<style>
  .fnnode { background: var(--surface, #fff); border: 2px solid #999; border-radius: 8px;
    min-width: 138px; font-size: 12px; box-shadow: 0 1px 5px rgba(0,0,0,.18); position: relative; }
  .fnnode.remote { border-style: dashed; }
  :global(.svelte-flow__node.selected) .fnnode { box-shadow: 0 0 0 3px rgba(89,74,226,.45); }
  .fn-hd { color: #fff; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
    padding: 2px 8px; border-radius: 6px 6px 0 0; display: flex; align-items: center; justify-content: space-between; }
  .fn-del { background: rgba(255,255,255,.25); color: #fff; border: 0; border-radius: 4px; cursor: pointer;
    font-size: 10px; line-height: 1; padding: 1px 4px; }
  .fn-del:hover { background: rgba(0,0,0,.35); }
  .fn-bd { padding: 6px 10px 9px; }
  .fn-nm { font-weight: 600; color: var(--ink, #1a1a2e); }
  .fn-sub { font-size: 10.5px; color: var(--muted, #888); margin-top: 1px; }
  .fn-port { position: absolute; font-size: 8.5px; color: var(--muted, #888); }
  .fn-port.l { left: 9px; }
  .fn-port.r { right: 9px; }
  /* Bigger, colour-coded handles — green = input (drop here), purple = output (drag from here) */
  :global(.svelte-flow .fnnode .svelte-flow__handle) { width: 12px; height: 12px; border: 2px solid #fff; }
  :global(.svelte-flow .fnnode .svelte-flow__handle.h-in) { background: #2a9d8f; }
  :global(.svelte-flow .fnnode .svelte-flow__handle.h-out) { background: #594ae2; }
  :global(.svelte-flow .fnnode .svelte-flow__handle:hover) { transform: scale(1.35); }
</style>
