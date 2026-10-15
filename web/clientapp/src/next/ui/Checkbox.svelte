<script>
  /** Checkbox with label (Bits UI Checkbox). checked bindable; onchange(checked). */
  import { Checkbox } from 'bits-ui'
  let { checked = $bindable(false), label, hint = '', disabled = false, onchange, ...rest } = $props()
  const id = 'cb-' + Math.random().toString(36).slice(2, 8)
</script>

<div class="row">
  <Checkbox.Root {id} bind:checked {disabled} onCheckedChange={(v) => onchange?.(v)} class="nx-cb" {...rest}>
    {#snippet children({ checked })}<span aria-hidden="true">{checked ? '✓' : ''}</span>{/snippet}
  </Checkbox.Root>
  <label for={id}><span class="t">{label}</span>{#if hint}<span class="muted h">{hint}</span>{/if}</label>
</div>

<style>
  .row { display: flex; align-items: center; gap: var(--space-3); min-height: 36px; }
  label { display: flex; flex-direction: column; cursor: pointer; }
  .t { font-weight: 600; }
  .h { font-size: var(--text-xs); }
  :global(.nx-cb) { flex: none; width: 24px; height: 24px; border-radius: 6px; border: 2px solid var(--color-line-strong); background: var(--color-raised); color: var(--color-on-accent); display: inline-flex; align-items: center; justify-content: center; font-weight: 700; padding: 0; }
  :global(.nx-cb[data-state='checked']) { background: var(--color-accent); border-color: var(--color-accent); }
</style>
