<script>
  /**
   * Modal dialog (Bits UI Dialog: focus trap, Esc closes, focus returns to the opener).
   * open is bindable. title (required), description, children = body, footer = snippet with buttons.
   * width in px. For destructive confirms put the Cancel button first in the footer.
   */
  import { Dialog } from 'bits-ui'
  let { open = $bindable(false), title, description = '', width = 560, children, footer, onclose, ...rest } = $props()
</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (!o) onclose?.() }}>
  <Dialog.Portal>
    <Dialog.Overlay class="nx-scrim" />
    <Dialog.Content class="nx-dialog" style="width: min({width}px, calc(100vw - 32px))" {...rest}>
      <div class="hd">
        <Dialog.Title class="nx-dialog-title">{title}</Dialog.Title>
        <Dialog.Close class="nx-x" aria-label="Close">✕</Dialog.Close>
      </div>
      {#if description}<Dialog.Description class="muted">{description}</Dialog.Description>{/if}
      <div class="body">{@render children?.()}</div>
      {#if footer}<div class="ft">{@render footer()}</div>{/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.nx-scrim) { position: fixed; inset: 0; z-index: 900; background: var(--color-scrim); }
  :global(.nx-dialog) { position: fixed; z-index: 901; left: 50%; top: 50%; transform: translate(-50%, -50%); max-height: calc(100vh - 48px); overflow: auto; background: var(--color-surface); color: var(--color-text); border: 1px solid var(--color-line-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow-2); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); }
  .hd { display: flex; align-items: center; gap: var(--space-3); }
  :global(.nx-dialog-title) { flex: 1 1 auto; font-size: var(--text-lg); font-weight: 700; margin: 0; }
  :global(.nx-x) { width: 40px; height: 40px; border-radius: var(--radius-md); border: 1px solid var(--color-line-strong); background: var(--color-surface); color: var(--color-text); }
  .body { display: flex; flex-direction: column; gap: var(--space-3); }
  .ft { display: flex; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; padding-top: var(--space-2); }
</style>
