<script>
  // Sticky save strip for the input screens: says what state the form is in, Revert and Save.
  import { Button } from '../../../ui/index.js'
  let { dirty = false, saving = false, problem = '', err = '', note = '', connected = false, onsave, onrevert, disabled = false } = $props()
</script>

<div class="savebar" class:dirty role="region" aria-label="Save">
  <div class="msg" role="status" aria-live="polite" data-testid="save-status">
    {#if problem}<span class="bad">■ {problem}</span>
    {:else if err}<span class="bad">■ {err}</span>
    {:else if dirty}<strong>You have changes that are not saved.</strong>
    {:else if note}{note}
    {:else}No changes.{/if}
  </div>
  <Button onclick={onrevert} disabled={!dirty || saving}>Revert</Button>
  <Button variant="primary" busy={saving} disabled={!dirty || !!problem || disabled} onclick={onsave} data-testid="save">Save</Button>
</div>

<style>
  .savebar { position: sticky; bottom: 0; z-index: 5; display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-2); }
  .savebar.dirty { border-color: var(--color-accent); }
  .msg { flex: 1 1 auto; }
  .bad { color: var(--color-fault); font-weight: 600; }
</style>
