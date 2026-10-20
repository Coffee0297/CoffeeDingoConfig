<script>
  // "Make <CANBoard> the ignition main": on 5.7 a PDM main sends its state frame past its own id range (base + 36); a
  // CANBoard's (base + 12) stays inside its own. Preview first (nothing changes), then do it; Undo puts every setting back.
  // Backed by POST /api/ignition/main/{guid}[?preview=true] and /api/ignition/main/undo (domain IgnitionMain).
  import { Card, Button, Select } from '../../../ui/index.js'
  import { toast, project } from '../../../lib/live.svelte.js'
  import { mainCandidates } from './ignition.js'

  let { devices, main, initial = '', onchange } = $props()
  const cbs = $derived(mainCandidates(devices, main))
  let pick = $state(''), view = $state(null), busy = $state(false), undoable = $state(false)
  $effect(() => { if (!cbs.some((d) => d.guid === pick)) pick = cbs.find((d) => d.guid === initial)?.guid ?? cbs[0]?.guid ?? '' })
  const cbName = $derived(cbs.find((d) => d.guid === pick)?.name ?? 'the CANBoard')

  async function post(url) {
    const r = await fetch(url, { method: 'POST' })
    const j = await r.json().catch(() => ({}))
    if (!r.ok && !('ok' in j)) throw new Error(j.error ?? `HTTP ${r.status}`)
    return j
  }
  async function run(preview) {
    busy = true
    try {
      view = await post(`/api/ignition/main/${pick}${preview ? '?preview=true' : ''}`)
      if (view.done) {
        undoable = true; project.dirty = true
        toast(`${cbName} is the ignition main. Apply to car, then Store.`, 'info', 6000)
        onchange?.(pick)
      }
    } catch (e) { view = { ok: false, error: e?.message ?? String(e) } }
    finally { busy = false }
  }
  async function undo() {
    busy = true
    try { await post('/api/ignition/main/undo'); undoable = false; view = null; project.dirty = true; toast('Ignition main put back.', 'info', 4000); onchange?.(main?.guid) }
    catch (e) { toast(e?.message ?? String(e), 'error', 8000) }
    finally { busy = false }
  }
</script>

{#if cbs.length && main && !/canboard/i.test(main.type ?? '')}
  <Card title="Ignition main on a CANBoard" subtitle={`${main.name} sends its state frame after its own id range on 5.7; a CANBoard keeps it inside its own`}>
    <div class="row">
      <Select label="New main module" items={cbs.map((d) => ({ value: d.guid, label: d.name }))} value={pick} onchange={(g) => { pick = g; view = null }} disabled={busy} data-testid="mkmain-cb" />
      <Button disabled={busy || !pick} onclick={() => run(true)} data-testid="mkmain-preview">Preview</Button>
      <Button variant="primary" disabled={busy || !view?.ok || view.done} busy={busy} onclick={() => run(false)} data-testid="mkmain-go">Make {cbName} the ignition main</Button>
      {#if undoable}<Button disabled={busy} onclick={undo} data-testid="mkmain-undo">Undo</Button>{/if}
    </div>
    <p class="muted">{main.name} becomes a follower (its outputs keep their ignition roles), {cbName} reads the same switch, button and interlocks, and every follower listens to {cbName}.</p>
    {#if view}
      {#if !view.ok}<p class="err" role="alert" data-testid="mkmain-error">■ {view.error}</p>{/if}
      {#if view.notes?.length}
        <ul class="notes" data-testid="mkmain-notes">{#each view.notes as n, i (i)}<li class:warn={n.level === 'warn'}>{n.level === 'warn' ? '▲ ' : ''}{n.text}</li>{/each}</ul>
      {/if}
      {#if view.changes?.length}
        <details><summary>{view.done ? 'Changed' : 'Would change'}: {view.changes.length} setting{view.changes.length === 1 ? '' : 's'}</summary>
          <ul class="changes mono">{#each view.changes as c, i (i)}<li>{c}</li>{/each}</ul>
        </details>
      {/if}
    {/if}
  </Card>
{/if}

<style>
  .row { display: flex; gap: var(--space-3); align-items: end; flex-wrap: wrap; }
  .notes, .changes { margin: var(--space-2) 0 0; padding-left: var(--space-4); display: grid; gap: 2px; }
  .notes .warn { color: var(--color-warn, var(--color-fault)); }
  .changes { font-size: var(--text-xs); }
  .err { color: var(--color-fault); font-weight: 600; margin: var(--space-2) 0 0; }
</style>
