<script>
  /** One function in the list: name, sentence, modules, live state (the main signal), the Enabled switch, link to the flow builder. */
  import { StateDot, Chip, Switch } from '../../../ui/index.js'
  import { href } from '../../../router.svelte.js'
  import { fnHref } from './model.svelte.js'

  let { row, st, selected = false, busy = false, onselect, ontoggle } = $props()
  const canToggle = $derived(st.known && !row.missing)
  const why = $derived(st.known ? '' : 'Needs the module live')
  const shape = $derived(st.tone === 'fault' ? 'square' : st.on ? 'dot' : 'ring')
</script>

<div class="row" class:sel={selected} data-testid="fn-row" data-fn={row.name}>
  <button type="button" class="pick" aria-pressed={selected} onclick={onselect}>
    <span class="nm">{row.name}</span>
    <span class="sent muted">{row.sentence}</span>
  </button>
  <span class="mods mono muted">{row.modules.join(', ')}</span>
  <span class="kind"><Chip tone={row.kind === 'fn' ? 'accent' : 'muted'} dashed={row.kind === 'lua'}>{row.kindLabel.toUpperCase()}</Chip></span>
  <span class="st mono" data-tone={st.tone}><StateDot tone={st.tone} {shape} label={st.text} /></span>
  <span class="sw" title={why || 'Enabled: the function may switch its outputs. Live state is on the left.'}>
    <span class="cap" aria-hidden="true">Enabled</span>
    <Switch checked={st.enabled && st.known} disabled={!canToggle || busy} label="" aria-label={'Enabled: ' + row.name + (why ? ' (' + why + ')' : '')}
      onchange={(v) => ontoggle?.(v)} />
  </span>
  <a class="open" href={fnHref(row)} aria-label={'Open ' + row.name + ' in the flow builder'}>Open ›</a>
</div>

<style>
  .row { display: grid; grid-template-columns: minmax(0, 1fr) 150px 150px 110px 84px 64px; gap: var(--space-3); align-items: center; min-height: 58px; padding: 4px var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface); }
  .row.sel { border-color: var(--color-focus); background: var(--color-raised); }
  .pick { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; text-align: left; background: transparent; border: 0; padding: 4px 0; min-height: 44px; justify-content: center; }
  .nm { font-weight: 700; font-size: var(--text-md); }
  .sent { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; font-size: var(--text-sm); }
  .mods { font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { font-size: var(--text-sm); white-space: nowrap; }
  .st[data-tone='on'] :global(.w) { font-weight: 800; }
  .sw { display: flex; flex-direction: column; align-items: center; gap: 0; }
  .cap { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-muted); }
  .sw :global(.word) { display: none; }
  .sw :global(.row) { min-height: 36px; }
  /* the switch says "may run", not "is on": keep it neutral so it never competes with the live state */
  .sw :global(.nx-sw[data-state='checked']) { background: var(--color-line-strong); border-color: var(--color-line-strong); }
  .sw :global(.nx-sw[data-state='checked'] .nx-sw-thumb) { background: var(--color-text); }
  .open { font-weight: 600; text-decoration: none; min-height: 44px; display: inline-flex; align-items: center; }
  @media (max-width: 1280px) { .row { grid-template-columns: minmax(0, 1fr) 110px 84px 64px; } .mods, .kind { display: none; } }
  @media (max-width: 900px) {
    .row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'pick pick' 'st sw' 'open open'; row-gap: 0; padding: var(--space-2) var(--space-3); }
    .pick { grid-area: pick; } .st { grid-area: st; } .sw { grid-area: sw; flex-direction: row; gap: var(--space-2); } .open { grid-area: open; min-height: 36px; }
  }
</style>
