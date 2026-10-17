<script>
  /** The selected function: its sentence, what it uses, where it came from, and what you can do with it. */
  import { Button, StateDot } from '../../../ui/index.js'
  import { href } from '../../../router.svelte.js'
  import { fnHref } from './model.svelte.js'
  import { templateByKey, ago } from './catalog.js'

  let { row, st, busy = false, onremove, onturn, onduplicate } = $props()
  const tpl = $derived(row.inst ? templateByKey(row.inst.key) : null)
  const turnWhy = $derived(!st.known ? 'The module is not live.' : '')
  // Simulate opens the function's own page with the simulator running
  const simHref = $derived(fnHref(row) + '&sim=1')
</script>

<aside class="pn" aria-label="Selected function" data-testid="fn-panel">
  <span class="eyebrow">SELECTED</span>
  <h2>{row.name}</h2>
  <div class="live"><StateDot tone={st.tone} shape={st.tone === 'fault' ? 'square' : st.on ? 'dot' : 'ring'} label={st.text} /></div>
  <p class="sentence">{row.sentence}</p>
  <h3>Uses</h3>
  <ul class="uses">
    {#each row.uses as u}<li><span>{u.what}</span><span class="mono muted">{u.where}</span></li>{/each}
  </ul>
  <p class="muted src">
    {#if row.inst}From template “{tpl?.name ?? row.inst.key}”{row.editedAt ? ' · applied ' + ago(row.editedAt) : ''}
    {:else}Built by hand in the flow builder.{/if}
  </p>
  <div class="acts">
    <Button variant="primary" href={fnHref(row)}>Open in builder</Button>
    <Button href={simHref} data-testid="fn-simulate">Simulate</Button>
    {#if row.inst}
      <Button href={href('functions', 'setup', row.inst.key, { edit: row.inst.id })} disabled={busy}>Change settings</Button>
      <Button href={href('functions', 'setup', row.inst.key, { from: row.inst.id })} disabled={busy}>Duplicate</Button>
    {:else}
      <Button disabled={busy} onclick={onduplicate} data-testid="fn-duplicate">Duplicate</Button>
    {/if}
    <Button disabled={busy || !!turnWhy} onclick={() => onturn(st.enabled)}>{st.enabled ? 'Disable function' : 'Enable function'}</Button>
    <Button variant="danger" disabled={busy} onclick={onremove}>Remove</Button>
  </div>
  {#if turnWhy}<p class="muted note">{turnWhy}</p>{/if}
</aside>

<style>
  .pn { flex: none; width: 400px; align-self: flex-start; position: sticky; top: var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); }
  .eyebrow { font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); }
  h2 { font-size: var(--text-xl); }
  h3 { font-size: var(--text-sm); color: var(--color-text-muted); }
  .sentence { padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-raised); font-size: var(--text-md); line-height: 1.5; }
  .uses { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow: auto; }
  .uses li { display: flex; gap: var(--space-3); font-size: var(--text-sm); }
  .uses li span:first-child { flex: 1 1 auto; }
  .src, .note { font-size: var(--text-sm); }
  .acts { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  @media (max-width: 1100px) { .pn { width: 100%; position: static; } }
</style>
