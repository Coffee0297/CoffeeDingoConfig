<script>
  // "Custom" card: per-module sleep input and mute-transmit input, what counts as in use, force awake.
  import { untrack } from 'svelte'
  import { Card, Chip, Select, Button, Banner } from '../../../ui/index.js'
  import { live, api } from '../../../lib/live.svelte.js'
  import { canSleep, writeDeviceInput } from './sleepLogic.js'
  import Confirm from './Confirm.svelte'
  import LearnSwitch from '../../hardware/parts/LearnSwitch.svelte'
  import { findReader } from '../../hardware/parts/learn.js'
  import { href } from '../../../router.svelte.js'
  import { remoteItems, resolveRemote, isRemoteKey } from '../../../lib/remote.js'
  import { broadcastOf } from '../../functions/flow/car.js'
  import { isUpstream, hasBlock } from '../../hardware/parts/util.js'

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  let selGuid = $state('')
  $effect(() => { if (!selGuid || !mods.some((d) => d.guid === selGuid)) selGuid = mods[0]?.guid ?? '' })
  const d = $derived(mods.find((x) => x.guid === selGuid) ?? null)

  let signals = $state([]), sigState = $state('loading'), remote = $state([])
  const loadSignals = (g) => api.inputs(g, 'bool').then((v) => { if (g === selGuid) { signals = (v ?? []).filter((x) => x.kind !== 'sys'); sigState = 'ok' } })
    .catch(() => { if (g === selGuid) sigState = 'error' })
  $effect(() => {
    const g = selGuid
    if (!g) return
    sigState = 'loading'
    loadSignals(g)
  })
  // on/off signals on other modules and ECUs; picking one links it to a CAN input on this module
  $effect(() => {
    const g = selGuid
    if (!g) return
    let alive = true
    remote = []
    untrack(() => remoteItems(g, 'bool')).then((r) => { if (alive) remote = r })   // untracked: it reads the polled device list
    return () => { alive = false }
  })
  const sigItems = (cur) => {
    const items = [{ value: '0', label: 'No driver' }, ...signals.map((s) => ({ value: String(s.index), label: s.name })), ...remote]
    if (cur && !items.some((i) => i.value === String(cur))) items.push({ value: String(cur), label: `Signal #${cur}` })
    return items
  }
  const modItems = $derived(mods.map((x) => ({ value: x.guid, label: x.name })))
  const forceItems = $derived(sigItems(d?.forceSleepInput))
  const muteItems = $derived(sigItems(d?.muteTxInput))

  let pending = $state(null), confirmOpen = $state(false), busy = $state(false), status = $state('')
  const labelOf = (items, v) => items.find((i) => i.value === String(v))?.label ?? `#${v}`
  function pick(kind, value) {
    const n = isRemoteKey(value) ? String(value) : Number(value)
    const cur = kind === 'force' ? d.forceSleepInput : d.muteTxInput
    if (n === cur) return
    if (n === 0) { commit({ kind, n }); return }
    pending = { kind, n }; confirmOpen = true
  }
  async function commit(p) {
    busy = true; status = ''
    const label = labelOf(p.kind === 'force' ? forceItems : muteItems, p.n)
    let n = p.n
    try {
      n = await resolveRemote(d.guid, p.n, 'bool')
      if (!n && p.n) throw new Error('the CAN input got no signal number')
    } catch (e) { busy = false; confirmOpen = false; status = `${d.name}: ${e?.message ?? e}`; return }
    const ok = await writeDeviceInput(d, p.kind === 'force' ? { forceSleepInput: n } : { muteTxInput: n })
    if (isRemoteKey(p.n)) loadSignals(d.guid)
    busy = false; confirmOpen = false
    status = ok ? `${d.name}: ${p.kind === 'force' ? 'sleep input' : 'mute-transmit input'} ${n ? 'set to “' + label + '”' : 'cleared'}.` : ''
  }
  const usb = $derived(/usb/i.test(live.adapter ?? ''))

  // Learn a switch (G17): find the bit that followed the switch, then use the CAN input on this module that
  // reads it, or the bit another module broadcasts (linked to a CAN input here on confirm). With neither,
  // the operator adds an input on the CAN input page.
  let learnFor = $state(null), learnOpen = $state(false), learnMiss = $state(null)
  function learn(kind) { learnFor = kind; learnMiss = null; learnOpen = true }
  async function useLearned(c) {
    const f = await api.functions(d.guid).catch(() => null)
    const r = findReader([{ guid: d.guid, mod: d.name, canInputs: f?.canInputs }], c)
    const sig = r && signals.find((x) => x.kind === 'caninput' && x.number === r.number)
    if (sig) { pick(learnFor, sig.index); return }
    const key = await broadcastKey(c)
    if (key) { pick(learnFor, key); return }
    const free = (f?.canInputs ?? []).find((x) => !x.enabled)
    learnMiss = { hex: c.hex, bit: c.startBit, link: free ? href('hardware', 'module', d.guid, 'input', 'caninput', String(free.number)) : null }
  }
  /** A learned bit that another module broadcasts -> its remote key ('r:guid:name'), or null. */
  async function broadcastKey(c) {
    if (c.ide) return null
    for (const m of mods.filter((x) => x.guid !== d.guid)) {
      const x = (await broadcastOf(m.guid)).find((s) => !s.isFloat && s.bitLength === 1 && (m.baseId ?? 0) + s.offset === c.id && s.startBit === c.startBit)
      if (!x) continue
      const key = `r:${m.guid}:${x.name}`
      if (!remote.some((i) => i.value === key)) remote = [...remote, { value: key, label: `${x.label ?? x.name} · ${m.name} (over CAN)` }]
      return key
    }
    return null
  }
</script>

<Card title="Custom" aria-label="Custom sleep settings">
  {#snippet tag()}<Chip tone="muted">CUSTOM</Chip>{/snippet}
  {#if !mods.length}
    <p class="muted">No modules in the project.</p>
  {:else}
    <div class="sel"><Select label="Module" items={modItems} bind:value={selGuid} data-testid="sleep-custom-module" /></div>
    {#if d && !d.connected}<Banner tone="warn" title="This module is not on the bus">Changes are saved in the project and sent when it comes back.</Banner>{/if}
    <div class="grid">
      <div class="f">
        <Select label="Sleep input: sleep as soon as this is true" items={forceItems} value={String(d?.forceSleepInput ?? 0)} disabled={!d || !canSleep(d) || busy || sigState !== 'ok'} onchange={(v) => pick('force', v)} data-testid="sleep-input" />
        {#if d && !canSleep(d)}<span class="muted note">This board's firmware has no sleep, so it has no sleep input.</span>{/if}
        <Button size="sm" disabled={!d || !canSleep(d) || busy || !live.connected} onclick={() => learn('force')} data-testid="learn-force">Learn a switch</Button>
      </div>
      <div class="f">
        <Select label="Mute-transmit input: stop talking on the bus while this is true" items={muteItems} value={String(d?.muteTxInput ?? 0)} disabled={!d || busy || sigState !== 'ok'} onchange={(v) => pick('mute', v)} data-testid="mute-input" />
        <span class="muted note">Config replies and your own CAN outputs are not muted.{#if d && isUpstream(d) && d.paramRuns && hasBlock(d, 0x1D00)} Repeating CAN messages are held back too; a "once" CAN message still goes out.{/if}</span>
        <Button size="sm" disabled={!d || busy || !live.connected} onclick={() => learn('mute')} data-testid="learn-mute">Learn a switch</Button>
      </div>
    </div>
    {#if learnMiss}<Banner tone="info" title={`No CAN input on ${d?.name} reads ${learnMiss.hex} bit ${learnMiss.bit} yet`}>Add one first: on the CAN input page, Learn a switch fills in the ID and bit. Then pick it here.{#if learnMiss.link} <a href={learnMiss.link}>Open a free CAN input</a>{/if}</Banner>{/if}
    <LearnSwitch bind:open={learnOpen} onuse={useLearned} />
    {#if sigState === 'error'}<p class="err" role="alert">■ Could not read this module's signal list.</p>{/if}
    {#if status}<p class="muted" role="status" data-testid="sleep-custom-status">{status}</p>{/if}

    <div class="blk">
      <strong>What counts as in use</strong>
      <p class="muted">A module counts as in use while an output is on, USB is connected, or CAN traffic is seen.</p>
      <p class="muted note">The firmware decides this itself; it has no input for your own "in use" signals. To keep a module awake on a signal, drive one of its outputs from it.</p>
    </div>
    <div class="blk">
      <strong>Force awake</strong>
      <p class="muted" data-testid="force-awake">{usb ? 'dingoConfig is connected over USB, so the module does not sleep while you work on it.' : 'dingoConfig is not connected over USB. Modules can sleep while you work, then stop answering.'}</p>
    </div>
  {/if}
</Card>

<Confirm bind:open={confirmOpen} title={pending?.kind === 'force' ? 'Sleep on this signal?' : 'Mute the bus on this signal?'} {busy}
  confirmLabel={pending?.kind === 'force' ? 'Use as sleep input' : 'Use as mute input'}
  consequence={pending?.kind === 'force' ? 'The module can sleep with outputs on and only wakes from the ticked wake sources or USB. Set it back to No driver to undo.' : 'The module goes quiet on the bus and looks unplugged until the signal ends. Set it back to No driver to undo.'}
  onconfirm={() => commit(pending)}>
  {#if pending && d}
    <p>{pending.kind === 'force'
      ? `While “${labelOf(forceItems, pending.n)}” is true, ${d.name} goes to sleep straight away, even with outputs on or a busy bus.`
      : `While “${labelOf(muteItems, pending.n)}” is true, ${d.name} stops sending its cyclic frames.`}</p>
  {/if}
</Confirm>

<style>
  .sel { max-width: 320px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-4); }
  .f { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start; }
  .f :global(.f) { width: 100%; }
  .note { font-size: var(--text-xs); }
  .blk { display: flex; flex-direction: column; gap: 4px; padding-top: var(--space-2); border-top: 1px solid var(--color-line); }
  .err { color: var(--color-fault); font-weight: 600; }
</style>
