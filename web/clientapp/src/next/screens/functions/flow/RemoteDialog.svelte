<script>
  /**
   * "Signal from another module": pick a module and one of the signals it broadcasts; the builder claims
   * a free CAN input here and fills it to decode that frame (POST /devices/{id}/link-remote). Nothing is
   * written to the source module: it already broadcasts the signal.
   */
  import { Dialog, Button, Select, Field } from '../../../ui/index.js'
  import { live, isPdm, isCanboard } from '../../../lib/live.svelte.js'
  import { broadcastOf } from './car.js'

  let { open = $bindable(false), dev, funcs, busy = false, onlink } = $props()
  let src = $state('')
  let q = $state('')
  let sigs = $state([])
  let pick = $state('')
  const others = $derived(live.devices.filter((d) => d.guid !== dev?.guid && (isPdm(d) || isCanboard(d))))
  const freeSlot = $derived((funcs?.canInputs ?? []).findLast((x) => !x.enabled))
  $effect(() => { if (open && !src && others.length) src = others[0].guid })
  $effect(() => {
    const g = src
    if (!g) { sigs = []; return }
    let alive = true
    broadcastOf(g).then((s) => { if (alive) sigs = s.filter((x) => x.inUse) })
    return () => { alive = false }
  })
  const shown = $derived(sigs.filter((s) => !q || ((s.label ?? '') + ' ' + s.name).toLowerCase().includes(q.toLowerCase())).slice(0, 80))
</script>

<Dialog bind:open title="Signal from another module" description="Travels over CAN. The source already broadcasts it; this module gets a CAN input that reads it." width={620}>
  {#if !freeSlot}
    <p class="bad" role="alert">■ All CAN inputs on {dev?.name} are in use. Remove one first.</p>
  {/if}
  <Select label="From module" items={others.map((d) => ({ value: d.guid, label: d.name + (d.connected ? '' : ' (not found)') }))} bind:value={src} />
  <Field label="Find a signal" bind:value={q} placeholder="e.g. headlights, brake, output 3" />
  <div class="list" role="radiogroup" aria-label="Signal">
    {#each shown as s (s.name)}
      <button type="button" role="radio" aria-checked={pick === s.name} class="sig" class:on={pick === s.name} onclick={() => (pick = s.name)}>
        <span>{s.label ?? s.name}</span><span class="muted mono">{s.name}{s.unit ? ' · ' + s.unit : ''}</span>
      </button>
    {/each}
    {#if !shown.length}<p class="muted">No broadcast signal matches.</p>{/if}
  </div>
  <p class="muted hint">Uses CAN input {freeSlot?.number ?? '—'} on {dev?.name}. The ID and bits come from {others.find((d) => d.guid === src)?.name ?? 'the source'}'s base ID.</p>
  {#snippet footer()}
    <Button onclick={() => (open = false)}>Cancel</Button>
    <Button variant="primary" disabled={!pick || !freeSlot || busy} {busy} onclick={() => onlink?.({ sourceGuid: src, signal: pick, canInput: freeSlot.number, label: sigs.find((s) => s.name === pick)?.label })}>Add CAN input</Button>
  {/snippet}
</Dialog>

<style>
  .list { max-height: 300px; overflow: auto; display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--color-line); border-radius: var(--radius-md); padding: 4px; }
  .sig { display: flex; justify-content: space-between; gap: 8px; min-height: 40px; padding: 0 10px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--color-text); text-align: left; }
  .sig.on { border-color: var(--color-accent); background: var(--color-raised); }
  .bad { color: var(--color-fault); font-weight: 600; }
  .hint { font-size: var(--text-xs); }
</style>
