<script>
  /**
   * Confirmation dialog for anything that switches loads, sleeps modules, flashes or stores.
   * Cancel comes first. `consequence` says what happens if it goes wrong. onconfirm() runs on the main button.
   */
  import { Dialog, Button } from '../../../ui/index.js'
  let { open = $bindable(false), title, description = '', consequence = '', confirmLabel = 'Continue', variant = 'primary', busy = false, onconfirm, children } = $props()
</script>

<Dialog bind:open {title} {description} width={520}>
  {@render children?.()}
  {#if consequence}<p class="muted"><strong>If it goes wrong:</strong> {consequence}</p>{/if}
  {#snippet footer()}
    <Button onclick={() => (open = false)} data-testid="confirm-cancel">Cancel</Button>
    <Button {variant} {busy} onclick={() => onconfirm?.()} data-testid="confirm-go">{confirmLabel}</Button>
  {/snippet}
</Dialog>
