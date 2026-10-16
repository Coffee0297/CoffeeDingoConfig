<script>
  // Sticky save strip for the output and input screens. It keeps edits in the project only: the car gets
  // them from Apply to car, so after a save it offers that next step. Revert and Keep changes.
  import { Button } from '../../../ui/index.js'
  import { ui } from '../../../shell/ui.svelte.js'
  let { dirty = false, saving = false, problem = '', err = '', note = '', connected = false, onsave, onrevert, disabled = false } = $props()
</script>

<div class="savebar" class:dirty role="region" aria-label="Keep changes">
  <div class="msg" role="status" aria-live="polite" data-testid="save-status">
    {#if problem}<span class="bad">■ {problem}</span>
    {:else if err}<span class="bad">■ {err}</span>
    {:else if dirty}<strong>Changed here, not kept yet.</strong> <span class="muted">Keep them in the project, then apply to the car.</span>
    {:else if note}{note}
    {:else}No changes.{/if}
  </div>
  {#if note && !dirty && !problem && !err}
    <Button variant="ghost" onclick={() => (ui.panel = 'apply')} data-testid="save-apply">Then apply to car ▸</Button>
  {/if}
  <Button onclick={onrevert} disabled={!dirty || saving}>Revert</Button>
  <Button variant="primary" busy={saving} disabled={!dirty || !!problem || disabled} onclick={onsave} title="Keeps the changes in the project. The car gets them from Apply to car." data-testid="save">Keep changes</Button>
</div>

<style>
  .savebar { position: sticky; bottom: 0; z-index: 5; display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); min-height: 72px; padding: var(--space-3) var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-2); }
  .savebar.dirty { border-color: var(--color-accent); }
  .msg { flex: 1 1 240px; }
  .bad { color: var(--color-fault); font-weight: 600; }
</style>
