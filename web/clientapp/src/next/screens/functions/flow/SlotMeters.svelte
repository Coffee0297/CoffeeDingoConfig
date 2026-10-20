<script>
  /** Blocks used of what the module has (conditions 32, timers 8, …), one bar per kind; yellow near the limit. */
  import { Meter } from '../../../ui/index.js'
  import { api, defs, device } from '../../../lib/live.svelte.js'
  import { slotUsage } from './model.js'

  let { guid } = $props()
  const dev = $derived(device(guid))
  let funcs = $state(null)
  $effect(() => { const g = guid; funcs = null; api.functions(g).then((f) => { if (g === guid) funcs = f }).catch(() => {}) })
  const slots = $derived(dev && funcs ? slotUsage(dev, funcs, defs) : [])
</script>

{#if slots.length}
  <div class="slots" aria-label={`Blocks used on ${dev.name}`} data-testid="slot-meters">
    {#each slots as s (s.arr)}<Meter label={s.label} value={s.used} max={s.max} />{/each}
  </div>
{:else if !funcs}
  <p class="muted" role="status">Reading the blocks…</p>
{/if}

<style>
  .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: var(--space-3) var(--space-4); }
</style>
