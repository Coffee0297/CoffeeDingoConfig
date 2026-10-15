<script>
  // Ctrl+K: jump to any screen or module by name (Bits UI Command inside a Dialog).
  import { Command, Dialog } from 'bits-ui'
  import { ui } from './ui.svelte.js'
  import { COMMANDS } from '../screens.js'
  import { go } from '../router.svelte.js'
  import { live } from '../lib/live.svelte.js'

  function pick(parts) { ui.palette = false; go(...parts) }
  function onkey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ui.palette = !ui.palette }
  }
</script>

<svelte:window onkeydown={onkey} />

<Dialog.Root bind:open={ui.palette}>
  <Dialog.Portal>
    <Dialog.Overlay class="nx-scrim" />
    <Dialog.Content class="nx-dialog pal" aria-label="Search">
      <Dialog.Title class="sr-only">Search screens and modules</Dialog.Title>
      <Command.Root label="Search screens and modules" loop>
        <Command.Input class="nx-input" placeholder="Search: plot, sleep, PDM-01, firmware…" autofocus />
        <Command.List class="pl">
          <Command.Empty class="muted pe">Nothing matches.</Command.Empty>
          <Command.Group>
            <Command.GroupHeading class="nx-label gh">Screens</Command.GroupHeading>
            <Command.GroupItems>
              {#each COMMANDS as [label, parts] (label)}
                <Command.Item value={label} onSelect={() => pick(parts)} class="pi">{label}</Command.Item>
              {/each}
            </Command.GroupItems>
          </Command.Group>
          {#if live.devices.length}
            <Command.Group>
              <Command.GroupHeading class="nx-label gh">Modules</Command.GroupHeading>
              <Command.GroupItems>
                {#each live.devices as d (d.guid)}
                  <Command.Item value={'module ' + d.name} onSelect={() => pick(['hardware', 'module', d.guid])} class="pi">{d.name}</Command.Item>
                {/each}
              </Command.GroupItems>
            </Command.Group>
          {/if}
        </Command.List>
      </Command.Root>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.pal) { width: min(640px, calc(100vw - 32px)) !important; top: 20% !important; transform: translate(-50%, 0) !important; }
  :global(.pl) { max-height: 420px; overflow: auto; margin-top: 8px; }
  :global(.pi) { min-height: 40px; display: flex; align-items: center; padding: 0 12px; border-radius: 8px; cursor: pointer; }
  :global(.pi[data-selected]) { background: var(--color-raised); }
  :global(.gh) { padding: 8px 12px 4px; }
  :global(.pe) { padding: 12px; }
</style>
