<script>
  /**
   * Single select (Bits UI Select). items: [{ value, label, disabled? }] — values are strings.
   * value is bindable; onchange(value). label renders a visible label above (or set `hideLabel`).
   * Long lists (more than 8 items) get a search box at the top of the list.
   */
  import { Select } from 'bits-ui'
  let { items = [], value = $bindable(''), label = '', hideLabel = false, placeholder = 'Choose…', disabled = false, onchange, ...rest } = $props()
  const id = 'sel-' + Math.random().toString(36).slice(2, 8)
  const current = $derived(items.find((i) => String(i.value) === String(value)))
  let open = $state(false), q = $state(''), qEl = $state(null)
  const searchable = $derived(items.length > 8)
  const MAX = 200   // ponytail: a long list (a car DBC has thousands of signals) renders the first 200 matches; typing narrows it
  const hits = $derived(q.trim() ? items.filter((i) => String(i.label).toLowerCase().includes(q.trim().toLowerCase())) : items)
  // keep the picked item in the list even when it is past the cap, so the trigger shows it as selected
  const shown = $derived(hits.length <= MAX ? hits : [...hits.slice(0, MAX), ...hits.slice(MAX).filter((i) => String(i.value) === String(value))])
  function openChanged(o) { if (o && searchable) setTimeout(() => qEl?.focus(), 30); else q = '' }
  // typing goes to the box, not the list's type-ahead; arrows, Enter, Escape and Tab still drive the list
  function qKey(e) {
    if (e.key === 'Enter' && shown.length && !qEl?.closest('.nx-sel-content')?.querySelector('[data-highlighted]')) {
      e.preventDefault(); value = String(shown[0].value); onchange?.(value); open = false; return
    }
    if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(e.key)) e.stopPropagation()
  }
</script>

<div class="f">
  {#if label}<span class="nx-label" class:sr-only={hideLabel} id={id + '-l'}>{label}</span>{/if}
  <Select.Root type="single" bind:value bind:open {items} {disabled} onValueChange={(v) => onchange?.(v)} onOpenChange={openChanged}>
    <Select.Trigger class="nx-sel" aria-labelledby={label ? id + '-l' : undefined} {...rest}>
      <span class="v" class:ph={!current}>{current?.label ?? placeholder}</span><span aria-hidden="true">▾</span>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content class="nx-sel-content" sideOffset={4}>
        {#if searchable}<input class="nx-sel-q" type="search" placeholder="Search…" aria-label={'Search ' + (label || 'options')} bind:value={q} bind:this={qEl} onkeydown={qKey} />{/if}
        <Select.Viewport>
          {#each shown as it (it.value)}
            <Select.Item value={String(it.value)} label={it.label} disabled={it.disabled} class="nx-sel-item">
              {#snippet children({ selected })}<span aria-hidden="true" class="ck">{selected ? '✓' : ''}</span>{it.label}{/snippet}
            </Select.Item>
          {/each}
          {#if !shown.length}<p class="none">Nothing matches “{q}”.</p>{/if}
          {#if hits.length > MAX}<p class="none">{hits.length - MAX} more. Type to narrow the list.</p>{/if}
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
  :global(.nx-sel-q) { position: sticky; top: -4px; z-index: 1; width: 100%; min-height: 36px; margin-bottom: 4px; padding: 0 var(--space-3); border-radius: 6px; border: 1px solid var(--color-line-strong); background: var(--color-raised); color: var(--color-text); }
  .none { margin: 0; padding: 8px var(--space-3); color: var(--color-text-muted); }
  .ck { width: 14px; color: var(--color-accent); }
</style>
