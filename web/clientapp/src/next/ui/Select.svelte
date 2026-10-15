<script>
  /**
   * Single select (Bits UI Select). items: [{ value, label, disabled? }] — values are strings.
   * value is bindable; onchange(value). label renders a visible label above (or set `hideLabel`).
   */
  import { Select } from 'bits-ui'
  let { items = [], value = $bindable(''), label = '', hideLabel = false, placeholder = 'Choose…', disabled = false, onchange, ...rest } = $props()
  const id = 'sel-' + Math.random().toString(36).slice(2, 8)
  const current = $derived(items.find((i) => String(i.value) === String(value)))
</script>

<div class="f">
  {#if label}<span class="nx-label" class:sr-only={hideLabel} id={id + '-l'}>{label}</span>{/if}
  <Select.Root type="single" bind:value {items} {disabled} onValueChange={(v) => onchange?.(v)}>
    <Select.Trigger class="nx-sel" aria-labelledby={label ? id + '-l' : undefined} {...rest}>
      <span class="v" class:ph={!current}>{current?.label ?? placeholder}</span><span aria-hidden="true">▾</span>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content class="nx-sel-content" sideOffset={4}>
        <Select.Viewport>
          {#each items as it (it.value)}
            <Select.Item value={String(it.value)} label={it.label} disabled={it.disabled} class="nx-sel-item">
              {#snippet children({ selected })}<span aria-hidden="true" class="ck">{selected ? '✓' : ''}</span>{it.label}{/snippet}
            </Select.Item>
          {/each}
        </Select.Viewport>
      </Select.Content>
    </Select.Portal>
  </Select.Root>
</div>

<style>
  .f { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  :global(.nx-sel) { min-height: var(--target-min); width: 100%; display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: 0 var(--space-3); border-radius: var(--radius-md); border: 1px solid var(--color-line-strong); background: var(--color-raised); color: var(--color-text); text-align: left; }
  .v { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ph { color: var(--color-text-muted); }
  :global(.nx-sel-content) { z-index: 1000; min-width: var(--bits-select-anchor-width); max-height: 320px; overflow: auto; background: var(--color-surface); border: 1px solid var(--color-line-strong); border-radius: var(--radius-md); box-shadow: var(--shadow-2); padding: 4px; }
  :global(.nx-sel-item) { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 var(--space-3); border-radius: 6px; cursor: pointer; color: var(--color-text); }
  :global(.nx-sel-item[data-highlighted]) { background: var(--color-raised); }
  :global(.nx-sel-item[data-disabled]) { opacity: 0.5; }
  .ck { width: 14px; color: var(--color-accent); }
</style>
