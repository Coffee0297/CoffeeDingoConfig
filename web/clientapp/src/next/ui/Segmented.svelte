<script>
  /**
   * One-of-many choice (Bits UI RadioGroup → role=radiogroup / radio). items: [{ value, label, sub? }].
   * value is bindable; onchange(value) fires after a change. label = accessible group name.
   */
  import { RadioGroup } from 'bits-ui'
  let { items = [], value = $bindable(), label, disabled = false, onchange, size = 'md', ...rest } = $props()
</script>

<RadioGroup.Root bind:value aria-label={label} {disabled} orientation="horizontal" onValueChange={(v) => onchange?.(v)} class="nx-seg {size}" {...rest}>
  {#each items as it (it.value)}
    <RadioGroup.Item value={String(it.value)} disabled={it.disabled} class="nx-seg-item">
      {#snippet children({ checked })}
        <span class="nx-seg-l">{#if checked}<span aria-hidden="true">✓ </span>{/if}{it.label}</span>{#if it.sub}<small>{it.sub}</small>{/if}
      {/snippet}
    </RadioGroup.Item>
  {/each}
</RadioGroup.Root>

<style>
  :global(.nx-seg) { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 4px; border-radius: var(--radius-md); background: var(--color-raised); }
  :global(.nx-seg-item) { min-height: 36px; padding: 0 var(--space-3); border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--color-text-muted); font-weight: 600; display: inline-flex; flex-direction: column; align-items: center; justify-content: center; }
  :global(.nx-seg.md .nx-seg-item) { min-height: 40px; }
  :global(.nx-seg-item[data-state='checked']) { background: var(--color-surface); color: var(--color-text); border-color: var(--color-line-strong); }
  :global(.nx-seg-item small) { font-size: var(--text-xs); font-weight: 500; color: var(--color-text-muted); }
  :global(.nx-seg-item[data-disabled]) { opacity: 0.5; }
</style>
