<script>
  /** On/off switch with a visible label (Bits UI Switch). checked is bindable; onchange(checked). */
  import { Switch } from 'bits-ui'
  let { checked = $bindable(false), label = '', hint = '', disabled = false, onchange, ...rest } = $props()
  const id = 'sw-' + Math.random().toString(36).slice(2, 8)
</script>

<div class="row">
  <label for={id} class="l"><span class="t">{label}</span>{#if hint}<span class="muted h">{hint}</span>{/if}</label>
  <span class="word" aria-hidden="true">{checked ? 'On' : 'Off'}</span>
  <Switch.Root {id} bind:checked {disabled} onCheckedChange={(v) => onchange?.(v)} class="nx-sw" {...rest}>
    <Switch.Thumb class="nx-sw-thumb" />
  </Switch.Root>
</div>

<style>
  .row { display: flex; align-items: center; gap: var(--space-3); min-height: var(--target-min); }
  .l { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 0; }
  .t { font-weight: 600; }
  .h { font-size: var(--text-xs); }
  .word { font-size: var(--text-xs); font-weight: 700; color: var(--color-text-muted); }
  :global(.nx-sw) { flex: none; width: 52px; height: 30px; border-radius: 999px; border: 2px solid var(--color-line-strong); background: var(--color-raised); padding: 2px; display: inline-flex; align-items: center; }
  :global(.nx-sw[data-state='checked']) { background: var(--color-accent); border-color: var(--color-accent); }
  :global(.nx-sw-thumb) { display: block; width: 22px; height: 22px; border-radius: 50%; background: var(--color-text); transition: transform var(--dur-fast) var(--ease); }
  :global(.nx-sw[data-state='checked'] .nx-sw-thumb) { transform: translateX(22px); background: var(--color-on-accent); }
  :global(.nx-sw[data-disabled]) { opacity: 0.5; }
</style>
