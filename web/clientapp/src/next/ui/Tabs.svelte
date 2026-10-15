<script>
  /**
   * Tabs (Bits UI Tabs). items: [{ value, label, count? }]. value is bindable.
   * `panel` snippet renders the content for the active value: {#snippet panel(v)}…{/snippet}
   */
  import { Tabs } from 'bits-ui'
  let { items = [], value = $bindable(items[0]?.value), label = 'Views', panel, ...rest } = $props()
</script>

<Tabs.Root bind:value {...rest}>
  <Tabs.List aria-label={label} class="nx-tabs">
    {#each items as it (it.value)}
      <Tabs.Trigger value={it.value} class="nx-tab">{it.label}{#if it.count != null}<span class="n">{it.count}</span>{/if}</Tabs.Trigger>
    {/each}
  </Tabs.List>
  {#if panel}
    {#each items as it (it.value)}
      <Tabs.Content value={it.value} class="nx-tabpanel">{#if value === it.value}{@render panel(it.value)}{/if}</Tabs.Content>
    {/each}
  {/if}
</Tabs.Root>

<style>
  :global(.nx-tabs) { display: inline-flex; gap: 2px; padding: 4px; border-radius: var(--radius-md); background: var(--color-raised); }
  :global(.nx-tab) { min-height: 36px; padding: 0 var(--space-4); border: 0; border-radius: 8px; background: transparent; color: var(--color-text-muted); font-weight: 600; display: inline-flex; align-items: center; gap: 6px; }
  :global(.nx-tab[data-state='active']) { background: var(--color-surface); color: var(--color-text); box-shadow: var(--shadow-1); }
  :global(.nx-tabpanel) { min-height: 0; }
  .n { font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); }
</style>
