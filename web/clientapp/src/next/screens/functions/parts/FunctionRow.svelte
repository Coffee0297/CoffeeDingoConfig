<script>
  /** One function in the list: state dot, name, sentence, modules, live state, on/off, link to the flow builder. */
  import { StateDot, Chip, Switch } from '../../../ui/index.js'
  import { href } from '../../../router.svelte.js'

  let { row, st, selected = false, busy = false, onselect, ontoggle } = $props()
  const canToggle = $derived(!!row.inst && st.known && !row.missing)
  const why = $derived(row.inst ? (st.known ? '' : 'Needs the module live') : 'Hand-built blocks: change them in the flow builder')
  const shape = $derived(st.tone === 'fault' ? 'square' : st.on ? 'dot' : 'ring')
</script>

<div class="row" class:sel={selected} data-testid="fn-row" data-fn={row.name}>
  <StateDot tone={st.tone} {shape} />
  <button type="button" class="pick" aria-pressed={selected} onclick={onselect}>
    <span class="nm">{row.name}</span>
    <span class="sent muted">{row.sentence}</span>
  </button>
  <span class="mods mono muted">{row.modules.join(', ')}</span>
  <span class="kind"><Chip tone={row.kind === 'fn' ? 'accent' : 'muted'} dashed={row.kind === 'lua'}>{row.kindLabel.toUpperCase()}</Chip></span>
  <span class="st mono" data-tone={st.tone}>{st.text}</span>
  <span class="sw" title={why}>
    <Switch checked={st.enabled && st.known} disabled={!canToggle || busy} label="" aria-label={(st.enabled ? 'Turn off ' : 'Turn on ') + row.name + (why ? ' (' + why + ')' : '')}
      onchange={(v) => ontoggle?.(v)} />
  </span>
  <a class="open" href={href('functions', 'flow', row.logicGuid)} aria-label={'Open ' + row.name + ' in the flow builder'}>Open ›</a>
</div>

<style>
  .row { display: grid; grid-template-columns: 18px minmax(0, 1fr) 150px 150px 92px 100px 64px; gap: var(--space-3); align-items: center; min-height: 58px; padding: 4px var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface); }
  .row.sel { border-color: var(--color-focus); background: var(--color-raised); }
  .pick { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; text-align: left; background: transparent; border: 0; padding: 4px 0; min-height: 44px; justify-content: center; }
  .nm { font-weight: 700; font-size: var(--text-md); }
  .sent { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; font-size: var(--text-sm); }
  .mods { font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st { font-size: var(--text-sm); }
  .st[data-tone='on'] { color: var(--color-on); }
  .st[data-tone='fault'] { color: var(--color-fault); }
  .st[data-tone='off'], .st[data-tone='stale'] { color: var(--color-text-muted); }
  .sw :global(.word) { display: none; }
  .sw :global(.row) { min-height: 44px; }
  .open { font-weight: 600; text-decoration: none; min-height: 44px; display: inline-flex; align-items: center; }
  @media (max-width: 1280px) { .row { grid-template-columns: 18px minmax(0, 1fr) 92px 100px 64px; } .mods, .kind { display: none; } }
</style>
