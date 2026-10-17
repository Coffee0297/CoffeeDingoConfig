<script>
  // Cross-module functions: a switch or signal on one module drives outputs on other modules, optionally
  // blinking in step from one clock module (with a backup that takes over). The list is the shared crossFns
  // store (also the old System view's list); functions an AI agent deployed (MCP) are imported on open.
  // "Check and send" previews what each module gets, asks to confirm, then runs the same deploy as the old UI.
  import { onMount, untrack } from 'svelte'
  import { Page, PageHeader, Card, Button, Chip, Banner, Empty, Dialog } from '../../ui/index.js'
  import { live, toast, outputsOf } from '../../lib/live.svelte.js'
  import { href } from '../../router.svelte.js'
  import { crossFns, deployCrossModule, cmfIsLua } from '../../../lib/store.js'
  import { importBackendCrossFns, previewCrossModule, normalizeCrossFn } from '../../../lib/crossModule.js'
  import CrossEditor from './cross/CrossEditor.svelte'
  import CrossPreview from './cross/CrossPreview.svelte'

  let editing = $state(false), editIdx = $state(-1)
  let delIdx = $state(-1), delOpen = $state(false)
  let sendOpen = $state(false), step = $state('preview'), plan = $state(null), sending = $state(false), results = $state(null), sendErr = $state('')

  onMount(async () => {
    try {
      const n = await importBackendCrossFns()
      if (n) toast(`Added ${n} cross-module function${n > 1 ? 's' : ''} that the AI agent sent to the modules`, 'info')
    } catch { /* backend without the endpoint: nothing to import */ }
  })

  // live.devices is replaced on every poll: names only change when the key does
  const nameKey = $derived(live.devices.map((d) => d.guid + '=' + d.name + '=' + outputsOf(d).map((o) => o.name ?? '').join(',')).join('|'))
  const devs = $derived.by(() => { nameKey; return untrack(() => live.devices.map((d) => ({ guid: d.guid, name: d.name, outputs: outputsOf(d).map((o) => ({ number: o.number, name: o.name })) }))) })
  const dName = (g) => devs.find((d) => d.guid === g)?.name ?? 'missing module'
  const outLabel = (t) => { const o = devs.find((d) => d.guid === t.guid)?.outputs.find((x) => x.number === t.output); return `${dName(t.guid)} O${t.output}${o?.name?.trim() ? ' ' + o.name.trim() : ''}` }

  // V1 rule: hardware programming needs a real CAN/USB interface (the Sim replays a log)
  const sendBlock = $derived(!live.adapter ? 'Connect a CAN/USB interface first — nothing is on the bus.'
    : !live.programmingAllowed ? "The Sim interface can't program modules. Switch to a real CAN/USB interface to send." : '')

  function edit(i) { editIdx = i; editing = true }
  function askDelete(i) { delIdx = i; delOpen = true }
  function doDelete() {
    const i = delIdx
    delOpen = false
    crossFns.update((list) => list.filter((_, k) => k !== i))
  }

  function openSend() {
    // functions saved before the Lua clock fix (or by the old UI) get their clock module made explicit
    const fixed = $crossFns.map(normalizeCrossFn)
    if (fixed.some((f, i) => f !== $crossFns[i])) crossFns.set(fixed)
    plan = previewCrossModule(fixed, live.devices)
    step = 'preview'; results = null; sendErr = ''
    sendOpen = true
  }
  const luaMods = $derived(plan?.modules.filter((m) => m.lua && !m.errors.some((e) => /Lua/.test(e))).map((m) => m.name) ?? [])
  const wiredMods = $derived(plan?.modules.filter((m) => !m.lua).map((m) => m.name) ?? [])
  async function send() {
    if (sendBlock) return
    sending = true; sendErr = ''
    try { results = await deployCrossModule(live.devices); step = 'done' }
    catch (e) { sendErr = e.message }
    finally { sending = false }
  }
  const failed = $derived((results ?? []).filter((r) => !r.ok))
</script>

<Page wide>
  <PageHeader crumbs={[{ label: 'Functions', href: href('functions') }, { label: 'Cross-module' }]} title="Cross-module functions"
    subtitle="A switch or signal on one module turns on outputs on other modules — for example one indicator switch flashing lamps on the front and rear modules in step.">
    {#snippet actions()}
      <Button onclick={() => edit(-1)} data-testid="cm-new">+ New cross-module function</Button>
      <!-- also with an empty list: sending clears what deleted functions left on the modules -->
      <Button variant="primary" onclick={openSend} data-testid="cm-send">Check and send to modules…</Button>
    {/snippet}
  </PageHeader>

  {#if !$crossFns.length}
    <Empty title="No cross-module functions yet" text="Make one when a switch is wired to one module but the lamps or loads it controls sit on other modules.">
      {#snippet actions()}<Button variant="primary" onclick={() => edit(-1)}>+ New cross-module function</Button>{/snippet}
    </Empty>
  {:else}
    <p class="muted">Edits here change the list only. Use <b>Check and send to modules</b> to put them on the modules.</p>
    <div class="grid" data-testid="cm-list">
      {#each $crossFns as fn, i (typeof fn.slot === 'number' ? 's' + fn.slot : 'i' + i)}
        <Card title={fn.name || 'Function ' + (i + 1)} data-testid="cm-card">
          {#snippet tag()}{#if cmfIsLua(fn)}<Chip tone="accent">Lua script</Chip>{:else}<Chip tone="ok">Native wiring</Chip>{/if}{/snippet}
          <p class="when"><span class="muted">When</span> <b>{fn.trigger?.varName || (fn.trigger?.varIndex != null ? 'signal #' + fn.trigger.varIndex : 'no signal picked')}</b>
            {#if fn.trigger?.guid}<span class="muted">on {dName(fn.trigger.guid)}</span>{/if} <span class="muted">is on, switch</span></p>
          <div class="outs">
            {#each fn.targets ?? [] as t, k (k)}<span class="out mono">{outLabel(t)}</span>{:else}<span class="muted">no outputs yet</span>{/each}
          </div>
          {#if fn.blink}
            <p class="muted small">Blinks {fn.blinkRateMs || 350} ms on / off · time kept by {fn.clockMaster ? dName(fn.clockMaster) : 'the trigger module'}{fn.clockBackup ? ` · backup ${dName(fn.clockBackup)}` : ''}</p>
          {/if}
          <div class="btns">
            <Button size="sm" onclick={() => edit(i)} aria-label={'Edit ' + (fn.name || 'function')}>Edit</Button>
            <Button size="sm" variant="ghost" onclick={() => askDelete(i)} aria-label={'Delete ' + (fn.name || 'function')}>Delete</Button>
          </div>
        </Card>
      {/each}
    </div>
  {/if}
</Page>

{#if editing}
  <CrossEditor idx={editIdx} onclose={() => (editing = false)} />
{/if}

<Dialog bind:open={delOpen} title={`Delete “${$crossFns[delIdx]?.name ?? ''}”?`} description="This removes it from the list only.">
  <p>The modules keep running it until you send again: <b>Check and send to modules</b> clears it from them.</p>
  {#snippet footer()}
    <Button onclick={() => (delOpen = false)}>Cancel</Button>
    <Button variant="danger" onclick={doDelete} data-testid="cm-confirm-delete">Delete function</Button>
  {/snippet}
</Dialog>

<Dialog bind:open={sendOpen} width={760} data-testid="cm-send-dialog"
  title={step === 'preview' ? 'What each module gets' : step === 'confirm' ? 'Send to the modules now?' : 'Sent'}
  description={step === 'preview' ? 'Nothing has been sent yet. Check this, then continue.' : ''}>
  {#if step === 'preview'}
    {#if sendBlock}<Banner tone="warn" title="Can't send right now">{sendBlock}</Banner>{/if}
    {#if !$crossFns.length}<p data-testid="cm-send-empty">No functions in the list. Sending clears the cross-module wiring sent to the modules before.</p>
    {:else}<CrossPreview {plan} />{/if}
  {:else if step === 'confirm'}
    <p>This writes to the modules straight away:</p>
    <ul class="list">
      {#if luaMods.length}<li><b>Lua script</b> on {luaMods.join(', ')}. The cross-module part of each module's Lua is replaced; the module's own Lua is kept.</li>{/if}
      {#if wiredMods.length}<li><b>CAN messages, flashers and output settings</b> on {wiredMods.join(', ')}. Earlier cross-module ones (named “cmf…”) are cleared first.</li>{/if}
      <li>The outputs listed in the preview switch from these signals — loads can turn on as soon as a trigger is on. Make sure nothing is connected that should not run.</li>
      <li>Modules that are off the bus get the change in the project only.</li>
    </ul>
    <p class="muted">Afterwards, burn (save to flash) each module that changed so it keeps this after power-off.</p>
    {#if sendErr}<Banner tone="fault" title="Sending failed">{sendErr}</Banner>{/if}
  {:else}
    {#if !results?.length}
      <Banner tone="warn" title="Nothing was sent">{$crossFns.length ? 'No function has a trigger signal and an output yet.' : 'No module had cross-module wiring to clear.'}</Banner>
    {:else}
      {#if failed.length}<Banner tone="fault" title={`${failed.length} did not work`}>Read the lines below, fix it and send again.</Banner>
      {:else}<Banner tone="ok" title="Sent">Burn each module that changed to keep it after power-off.</Banner>{/if}
      <ul class="list" data-testid="cm-results">
        {#each results as r, i (i)}
          <li>{r.ok ? (r.written === false ? '○' : '✓') : '■'} <b>{r.name}</b>:
            {r.ok ? (r.written === false ? `saved to the project only${r.note ? ` (${r.note})` : ''}` : (r.kind === 'lua' ? 'Lua sent' : r.kind === 'cleared' ? 'earlier cross-module wiring cleared' : 'wired')) : r.error}</li>
        {/each}
      </ul>
    {/if}
  {/if}
  {#snippet footer()}
    {#if step === 'preview'}
      <Button onclick={() => (sendOpen = false)} data-testid="cm-send-cancel">Cancel</Button>
      <Button variant="primary" disabled={!!sendBlock || (!plan?.modules.length && $crossFns.length > 0)} title={sendBlock} onclick={() => (step = 'confirm')} data-testid="cm-send-next">Continue</Button>
    {:else if step === 'confirm'}
      <Button onclick={() => (step = 'preview')} disabled={sending}>Back</Button>
      <Button variant="primary" busy={sending} disabled={!!sendBlock} onclick={send} data-testid="cm-confirm-send">Send to modules</Button>
    {:else}
      <Button variant="primary" onclick={() => (sendOpen = false)}>Close</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--space-4); }
  .when { margin: 0; }
  .outs { display: flex; flex-wrap: wrap; gap: 6px; }
  .out { font-size: var(--text-xs); padding: 2px 8px; border-radius: 6px; border: 1px solid var(--color-line-strong); background: var(--color-raised); }
  .small { font-size: var(--text-xs); margin: 0; }
  .btns { display: flex; gap: var(--space-2); margin-top: auto; }
  .list { margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: var(--space-2); }
</style>
