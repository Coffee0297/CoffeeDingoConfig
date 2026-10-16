<script>
  // "Why will it not sleep": derived from live frame rates (GET /api/canlog counts), module telemetry and
  // the sleep settings. Firmware 5.6 modules also say what keeps them awake and what last woke them.
  import { onDestroy } from 'svelte'
  import { Card, Button, Chip } from '../../../ui/index.js'
  import { live, hex, toast } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import { SUB, canSleep, writeParams, moduleOfId, wakeWords } from './sleepLogic.js'
  import { pollCanRates } from './canRates.svelte.js'
  import Confirm from './Confirm.svelte'

  const poller = pollCanRates(2000)
  onDestroy(() => poller.stop())
  const rates = $derived(poller.state.rates)

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  const perModule = $derived.by(() => {
    const out = new Map(), other = []
    for (const [idStr, r] of Object.entries(rates)) {
      const id = Number(idStr), m = moduleOfId(id, mods)
      if (m) out.set(m.guid, (out.get(m.guid) ?? 0) + r)
      else other.push({ id, r })
    }
    other.sort((a, b) => b.r - a.r)
    return { out, other }
  })

  const reasons = $derived.by(() => {
    if (!live.connected) return []
    const list = []
    if (/usb/i.test(live.adapter ?? '')) list.push({ key: 'usb', text: 'dingoConfig is connected over USB. Modules never sleep while USB is connected.' })
    for (const d of mods) {
      if (!d.connected) continue
      const on = (d.outputs ?? []).filter((o) => /^on|overcurrent|warning/i.test(o.state ?? ''))
      if (on.length) list.push({ key: 'out-' + d.guid, text: `${d.name} has ${on.length} output${on.length === 1 ? '' : 's'} on (${d.current.toFixed(1)} A). An output that is on counts as in use.` })
      if (canSleep(d) && !d.sleepEnabled) list.push({ key: 'auto-' + d.guid, text: `${d.name}: automatic sleep is off.`, fix: { label: `Turn on automatic sleep for ${d.name}`, run: () => fixAuto(d) } })
      // firmware 5.6: the module's own word
      if ((d.sleepBlockers ?? 0) & 8) list.push({ key: 'rx-' + d.guid, text: `${d.name} says CAN traffic keeps it awake${wakeWords(d) ? `; it last woke from ${wakeWords(d)}` : ''}.` })
      if ((d.sleepBlockers ?? 0) & 4 && !/usb/i.test(live.adapter ?? '')) list.push({ key: 'usb-' + d.guid, text: `${d.name} has a USB cable connected. It never sleeps while USB is connected.` })
    }
    const chatty = perModule.other.filter((x) => x.r >= 1)
    if (chatty.length) {
      const wakeCan = mods.filter((d) => canSleep(d) && d.wakeOnCan !== false)
      list.push({ key: 'other', text: `${chatty.length} frame id${chatty.length === 1 ? '' : 's'} outside your modules keep the bus busy: ${chatty.slice(0, 4).map((x) => `${hex(x.id)} (${x.r.toFixed(0)} per s)`).join(', ')}. ${wakeCan.length ? `${wakeCan.map((d) => d.name).join(', ')} wake on CAN activity, so this traffic keeps waking them.` : ''}` })
    }
    const talking = mods.filter((d) => d.connected && (perModule.out.get(d.guid) ?? 0) >= 1 && !d.muteTxInput)
    if (talking.length) list.push({ key: 'talk', text: `Still sending: ${talking.map((d) => `${d.name} (${(perModule.out.get(d.guid) ?? 0).toFixed(0)} frames per s)`).join(', ')}. Modules wake on each other's CAN traffic unless the bus goes quiet first (mute-transmit input).` })
    return list
  })

  async function fixAuto(d) {
    if ((d.wakeDigInputMask ?? 0) === 0 && d.wakeOnCan === false) { toast(`${d.name} has no wake source. Tick one in the wake table first.`, 'error', 8000); return }
    if (await writeParams(d, [[SUB.enabled, 1]])) toast(`${d.name}: automatic sleep is on.`, 'info', 3000)
  }
  let offCan = $state(null), canBusy = $state(false)
  const canWakers = $derived(mods.filter((d) => d.connected && canSleep(d) && d.wakeOnCan !== false && ((d.wakeDigInputMask ?? 0) !== 0)))
  async function doOffCan() {
    canBusy = true
    const ok = await writeParams(offCan, [[SUB.wakeCan, 0]])
    canBusy = false; offCan = null
    if (ok) toast('CAN activity no longer wakes that module.', 'info', 3000)
  }
  const verdict = $derived(!live.connected ? 'No connection' : !mods.some((d) => d.connected) ? 'Nothing is answering' : reasons.length ? 'Something keeps the car awake' : 'Nothing found keeping it awake')
</script>

<Card title="Why a module will not sleep" aria-label="Why a module will not sleep">
  {#snippet tag()}<Chip tone={reasons.length ? 'warn' : 'muted'} symbol={reasons.length ? '▲' : '○'}>{reasons.length ? 'FOUND ' + reasons.length : 'NONE'}</Chip>{/snippet}
  <p><strong data-testid="why-verdict">{verdict}</strong></p>
  {#if !live.connected}
    <p class="muted">Connect to the car to read the bus.</p>
  {:else if !poller.state.ok}
    <p class="muted" role="status">Reading the bus…{poller.state.error ? ' ' + poller.state.error : ''}</p>
  {:else if reasons.length}
    <ul class="why" data-testid="why-list">
      {#each reasons as r (r.key)}
        <li><span>{r.text}</span>{#if r.fix}<Button size="sm" onclick={r.fix.run}>{r.fix.label}</Button>{/if}</li>
      {/each}
    </ul>
    {#if canWakers.length}
      <div class="fix"><strong>Stop CAN traffic waking a module</strong>
        <div class="btns">{#each canWakers as d (d.guid)}<Button size="sm" onclick={() => (offCan = d)} data-testid={`why-offcan-${d.name}`}>Stop CAN waking {d.name}</Button>{/each}</div>
        <span class="muted note">The module then wakes only from its ticked inputs or USB.</span></div>
    {/if}
    <div><Button href={href('expert', 'can')} size="sm">Watch the bus live</Button></div>
  {:else}
    <p class="muted">Nothing is keeping the bus awake. If a module does not go to sleep, or wakes again and again, the reason shows here: which frames keep the bus busy, which outputs are on, and what to change.</p>
  {/if}
  <p class="muted note">Based on the last 2 seconds of bus traffic, and on what modules with firmware 5.6 report about themselves.</p>
</Card>

<Confirm bind:open={() => !!offCan, (v) => { if (!v) offCan = null }} title="Stop CAN activity waking this module?" confirmLabel="Stop waking on CAN" busy={canBusy}
  consequence="A sleeping module then wakes only from its ticked inputs or USB. If it is behind the dash and no input is ticked, you cannot wake it."
  onconfirm={doOffCan}>
  <p>{offCan?.name} stays asleep when other modules talk. Tick CAN activity again in the wake table to undo.</p>
</Confirm>

<style>
  .why { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: var(--space-2); }
  .why li { line-height: 1.5; }
  .why :global(.b) { margin-left: var(--space-3); }
  .fix { display: flex; flex-direction: column; gap: var(--space-2); padding-top: var(--space-2); border-top: 1px solid var(--color-line); }
  .btns { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .note { font-size: var(--text-xs); }
</style>
