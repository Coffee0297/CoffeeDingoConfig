<script>
  // Confirmation dialog with role="alertdialog" (the shared Dialog is role="dialog"). Same look as Dialog.
  // open is bindable; title; children = body; footer = snippet with the buttons (Cancel first).
  import { AlertDialog } from 'bits-ui'
  let { open = $bindable(false), title, width = 560, children, footer, ...rest } = $props()
</script>

<AlertDialog.Root bind:open>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="nx-scrim" />
    <AlertDialog.Content class="nx-dialog" style="width: min({width}px, calc(100vw - 32px))" {...rest}>
      <AlertDialog.Title class="nx-dialog-title">{title}</AlertDialog.Title>
      <div class="body">{@render children?.()}</div>
      {#if footer}<div class="ft">{@render footer()}</div>{/if}
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<style>
  .body { display: flex; flex-direction: column; gap: var(--space-3); }
  .ft { display: flex; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; padding-top: var(--space-2); }
</style>
