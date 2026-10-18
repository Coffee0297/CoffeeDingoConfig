<script>
  // Sleep: the setup the modules hold (see sequence.svelte.js), as a timeline from the moment nothing is in use.
  import { Card, Banner, Button } from '../../../ui/index.js'
  import { live } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import SleepSetup from './SleepSetup.svelte'
  let { seq } = $props()
  let editOpen = $state(false)

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  const master = $derived(mods.find((d) => seq.state.perModule[d.guid]?.master) ?? null)
  const s = $derived(master ? seq.state.perModule[master.guid] : null)
  const follows = $derived(mods.filter((d) => seq.state.perModule[d.guid]?.follows).map((d) => d.name))
  const ins = $derived((s?.inputs ?? []).map((i) => seq.state.names[i] ?? `signal ${i}`))
  const awakeS = $derived(s ? s.keepS - (s.preS ?? 0) : 0)
</script>

<Card title="Sleep" aria-label="Sleep">
  {#if !live.connected}
    <Banner tone="warn" title="Not connected">The setup is read from the modules. Connect to the car to see it.</Banner>
  {:else if !seq.state.loaded}
    <p class="muted" role="status">Reading the modules…</p>
  {:else if !s}
    <Banner tone="info" title="No sleep master is set up" data-testid="no-sequence">Each module sleeps by its own timer (see the table). Set a master to keep the car awake for a set time after the ignition or a door goes off, give a pre-sleep signal, then put every module to sleep together.
      {#snippet actions()}<Button size="sm" onclick={() => (editOpen = true)} disabled={!live.connected} data-testid="edit-sequence">Set up sleep</Button>{/snippet}
    </Banner>
  {:else}
    <p class="muted" data-testid="sequence-source">{master.name} is the master: it keeps the car awake while {ins.join(' or ') || 'its signal'} is on.</p>
    <div class="tl" role="img" aria-label={`Sleep timeline: awake ${awakeS} s, pre-sleep ${s.preS ?? 0} s, then asleep`} data-testid="power-timeline">
      <div class="seg" style="flex: {Math.max(1, awakeS)} 1 0"><span class="n">Awake</span><span class="l mono">{awakeS} s</span></div>
      {#if s.preS}<div class="seg pre" style="flex: {s.preS} 1 0"><span class="n">Pre-sleep</span><span class="l mono">{s.preS} s</span></div>{/if}
      <div class="seg end" style="flex: {Math.max(1, s.keepS / 3)} 1 0"><span class="n">Asleep</span><span class="l mono">until a wake source</span></div>
    </div>
    <ul class="muted rules" data-testid="power-rules">
      <li>The car stays awake {s.keepS} s after {ins.length > 1 ? 'all of them are' : 'it is'} off; turning one on again starts over.</li>
      {#if s.preS}<li><strong>Sleep · pre-sleep</strong> comes on {s.preS} s before sleep{s.pulseS ? ` as a ${s.pulseS} s pulse` : ', until sleep'}{s.wakeS ? `; used again in that time, a ${s.wakeS} s wake pulse` : ''}.</li>{/if}
      <li>Then {master.name} goes quiet: {follows.length ? follows.join(', ') : 'no module'} go{follows.length === 1 ? 'es' : ''} quiet and sleep{follows.length === 1 ? 's' : ''}, and {master.name} a few seconds later.</li>
    </ul>
  {/if}
  <div class="acts">{#if s}<Button size="sm" onclick={() => (editOpen = true)} data-testid="edit-sequence">Change the sleep</Button>{/if}<Button size="sm" href={href('power', 'sleep')}>Open sleep settings</Button></div>
</Card>
<SleepSetup bind:open={editOpen} {seq} />

<style>
  .tl { display: flex; gap: 4px; min-height: 64px; }
  .seg { border-radius: var(--radius-md); background: var(--color-on-soft); padding: 8px 10px; display: flex; flex-direction: column; justify-content: center; min-width: 0; border: 1px solid var(--color-line); }
  .seg.pre { background: var(--color-warn-soft); }
  .seg.end { background: var(--color-raised); }
  .n { font-weight: 600; font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .l { font-size: var(--text-xs); color: var(--color-text-muted); }
  .acts { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .rules { margin: 0; padding-left: 20px; line-height: 1.7; }
</style>
