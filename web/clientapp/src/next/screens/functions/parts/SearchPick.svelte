<script>
  /**
   * Searchable pick list (Bits UI Combobox) for long lists: every output or input on the bus.
   * options: [{ value, label, search? }] (value may be a number or text, '' = none). value is bindable.
   * Typing filters on the label plus `search` (so "J3-7" or "DI3" find the pin). onpick(value, option).
   */
  import { Combobox } from 'bits-ui'
  let { options = [], value = $bindable(''), label, placeholder = 'Search…', disabled = false, onpick, ...rest } = $props()

  const id = 'sp-' + Math.random().toString(36).slice(2, 8)
  let q = $state(''), open = $state(false)
  const items = $derived(options.map((o, i) => ({ ...o, id: 'o' + i })))
  const current = $derived(items.find((o) => o.value === value && !(o.value === '' && value !== '')))
  const words = $derived(q.trim().toLowerCase().split(/\s+/).filter(Boolean))
  const shown = $derived(words.length ? items.filter((o) => words.every((w) => (o.label + ' ' + (o.search ?? '')).toLowerCase().includes(w))) : items)

  function pick(oid) {
    const o = items.find((x) => x.id === oid)
    if (!o) return
    value = o.value; q = ''
    onpick?.(o.value, o)
  }
</script>

<div class="sp">
  <span class="nx-label" {id}>{label}</span>
  <Combobox.Root type="single" {disabled} bind:open value={current?.id ?? ''} onValueChange={pick} items={items.map((o) => ({ value: o.id, label: o.label }))}
    onOpenChange={(o) => { if (!o) q = '' }}>
    <div class="box">
      <Combobox.Input class="nx-input" aria-labelledby={id} {placeholder} defaultValue={current?.label ?? ''}
        oninput={(e) => { q = e.currentTarget.value; open = true }} {...rest} />
      <Combobox.Trigger class="tg" aria-label={'Show all: ' + label}>▾</Combobox.Trigger>
    </div>
    <Combobox.Portal>
      <Combobox.Content class="nx-sel-content sp-content" sideOffset={4}>
        <Combobox.Viewport>
          {#each shown.slice(0, 200) as o (o.id)}
            <Combobox.Item value={o.id} label={o.label} class="nx-sel-item">
              {#snippet children({ selected })}<span class="ck" aria-hidden="true">{selected ? '✓' : ''}</span><span class="lb">{o.label}</span>{/snippet}
            </Combobox.Item>
          {:else}
            <div class="none muted" role="status">Nothing matches “{q}”.</div>
          {/each}
          {#if shown.length > 200}<div class="none muted">Type more to narrow {shown.length} matches.</div>{/if}
        </Combobox.Viewport>
      </Combobox.Content>
    </Combobox.Portal>
  </Combobox.Root>
</div>

<style>
  .sp { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .box { position: relative; display: flex; }
  .box :global(.nx-input) { padding-right: 44px; }
  :global(.tg) { position: absolute; right: 0; top: 0; bottom: 0; width: 44px; background: transparent; border: 0; color: var(--color-text-muted); }
  :global(.sp-content) { width: var(--bits-combobox-anchor-width); min-width: 280px; }
  .lb { white-space: normal; }
  .ck { width: 14px; color: var(--color-accent); flex: none; }
  .none { padding: var(--space-3); font-size: var(--text-sm); }
</style>
