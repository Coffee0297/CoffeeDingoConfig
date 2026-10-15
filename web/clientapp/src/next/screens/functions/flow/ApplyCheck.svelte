<script>
  /** "Apply with unfinished blocks?" — lists blocks that can't run yet before handing over to Apply to car. */
  import { Dialog, Button } from '../../../ui/index.js'
  let { open = $bindable(false), items = [], onapply, onfinish } = $props()
</script>

<Dialog bind:open title="Apply with unfinished blocks?" description="These blocks can't do anything yet. They go to the car as they are and stay inactive; everything else works as usual." width={560}>
  <ul class="l">
    {#each items as i (i.id)}
      <li><span aria-hidden="true" class="g">▲</span><span><strong>{i.title}</strong><span class="muted w">{i.why}</span></span></li>
    {/each}
  </ul>
  {#snippet footer()}
    <Button onclick={() => { open = false; onfinish?.(items[0]?.id) }}>Go back and finish them</Button>
    <Button variant="primary" onclick={() => { open = false; onapply?.() }}>Apply anyway</Button>
  {/snippet}
</Dialog>

<style>
  .l { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
  li { display: flex; gap: 10px; padding: 10px 12px; border-radius: var(--radius-md); border: 1px dashed var(--color-fault); }
  .g { color: var(--color-fault); }
  li > span:last-child { display: flex; flex-direction: column; }
  .w { font-size: var(--text-xs); }
</style>
