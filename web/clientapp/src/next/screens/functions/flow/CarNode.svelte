<script>
  /**
   * Compact block for the whole-car canvas: name, kind, one live state. data: { n, vals, guid, head? }.
   * A module header node (head: true) has no ports.
   */
  import { Handle, Position } from '@xyflow/svelte'
  import { FAM_COLOR } from './model.js'
  import { fmt } from './livevals.js'
  let { id, data, selected } = $props()
  const n = $derived(data.n)
  const main = $derived(n.outs?.find((p) => p.type === 'bool') ?? n.outs?.[0] ?? null)
  const inPort = $derived(n.kind === 'output' || n.kind === 'digitaloutput' ? n.ins?.[0] : null)
  const val = $derived(main ? data.vals?.[main.idx] : inPort ? data.vals?.[inPort.src] : undefined)
</script>

{#if data.head}
  <div class="head" class:off={!n.connected}>
    <span class="t" id={'car-t-' + id}>{n.title}</span>
    <span class="s">{n.sub}</span>
  </div>
{:else}
  <div class="cn" class:sel={selected} class:on={val === true} class:fn={!!n.tag} class:inc={n.incomplete?.length} style="--fam: {FAM_COLOR[n.fam] ?? FAM_COLOR.dev}">
    <Handle type="target" position={Position.Left} class="cp" isConnectable={false} />
    <span class="bar" aria-hidden="true"></span>
    <span class="tt">
      <span class="t" id={'car-t-' + id}>{n.title}</span>
      <span class="s">{n.tag ? n.tag + ' · ' : ''}{n.kindLabel}{n.remote ? ' · ◆ CAN' : ''}</span>
    </span>
    <span class="pill" class:pon={val === true} id={'car-s-' + id}>{val === undefined ? '' : fmt(val)}</span>
    <Handle type="source" position={Position.Right} class="cp" isConnectable={false} />
  </div>
{/if}

<style>
  .head { width: 260px; box-sizing: border-box; padding: 8px 12px; border-radius: 10px; background: var(--color-raised); border: 1px solid var(--color-line-strong); display: flex; flex-direction: column; }
  .head .t { font-weight: 700; font-size: 16px; }
  .head.off { border-style: dashed; }
  .cn { position: relative; width: 260px; box-sizing: border-box; min-height: 48px; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 10px; border: 2px solid var(--color-line-strong); background: var(--color-surface); color: var(--color-text); }
  .cn.on { border-color: var(--color-on); box-shadow: 0 0 0 3px var(--color-on-soft); }
  .cn.fn { border-color: var(--color-accent); }
  .cn.inc { border-style: dashed; border-color: var(--color-fault); }
  .cn.sel { border-color: var(--color-focus); }
  :global(.svelte-flow__node:focus-visible) .cn { outline: 3px solid var(--color-focus); outline-offset: 3px; }
  .bar { flex: none; width: 4px; align-self: stretch; border-radius: 2px; background: var(--fam); }
  .tt { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
  .t { font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .s { font-size: 11px; color: var(--color-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pill { flex: none; font-family: var(--font-mono); font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--color-raised); color: var(--color-text-muted); }
  .pill:empty { display: none; }
  .pill.pon { background: var(--color-on-soft); color: var(--color-on); }
  :global(.svelte-flow .cp.svelte-flow__handle) { width: 8px; height: 8px; background: var(--color-line-strong); border: 0; }
</style>
