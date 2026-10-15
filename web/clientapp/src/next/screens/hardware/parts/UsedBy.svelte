<script>
  import { Card } from '../../../ui/index.js'
  import { href } from '../../../router.svelte.js'
  let { guid, items = [], hint = '' } = $props()
</script>

<Card title="Used by" aria-label="Used by">
  {#if items.length}
    <ul data-testid="used-by">
      {#each items as u (u.name + u.where)}
        <li><a href={href('functions', 'flow', guid)}><span>{u.name}</span><span class="muted">{u.where}</span></a></li>
      {/each}
    </ul>
  {:else}
    <p class="muted" data-testid="used-by">Nothing uses this input yet.</p>
  {/if}
  {#if hint}<p class="muted small">{hint}</p>{/if}
</Card>

<style>
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  a { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-raised); text-decoration: none; color: var(--color-text); min-height: 36px; align-items: center; }
  a:hover { outline: 1px solid var(--color-line-strong); }
  .small { font-size: var(--text-xs); }
</style>
