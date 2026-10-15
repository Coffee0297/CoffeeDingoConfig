<script>
  import { Page, PageHeader, Button, Card, FwBadge } from '../../ui/index.js'
  import { href } from '../../router.svelte.js'
  import { live } from '../../lib/live.svelte.js'
  import PowerDown from './parts/PowerDown.svelte'
  import ModuleSleepTable from './parts/ModuleSleepTable.svelte'
  import { canSleep } from './parts/sleepLogic.js'
  import { onDestroy } from 'svelte'
  import { watchSequence } from './parts/sequence.svelte.js'
  let props = $props()
  const seq = watchSequence()
  onDestroy(() => seq.stop())

  const modules = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  const sleepers = $derived(modules.filter((d) => canSleep(d) && d.sleepEnabled))
  const sub = $derived(!modules.length ? 'No modules in the project yet.'
    : `${modules.length} modules` + (sleepers.length ? ` · ${sleepers.length} sleep on their own after about ${Math.round(Math.min(...sleepers.map((d) => d.sleepTimeoutMs)) / 1000)} s of nothing in use` : ' · none sleep on their own') + ' · ignition setup needs firmware 5.6')
  const STATES = [
    { name: 'Off', out: 'door opens: dash on 3 min', next: 'press button' },
    { name: 'Ignition', out: 'ignition + accessory + dash', next: 'clutch + press' },
    { name: 'Cranking', out: 'starter on, accessory off', next: 'engine runs' },
    { name: 'Running', out: 'ignition + accessory + dash', next: '' },
  ]
</script>

<Page>
  <PageHeader title="Power & ignition" subtitle={sub}>
    {#snippet actions()}
      <Button href={href('power', 'sleep')}>Sleep settings</Button>
      <Button variant="primary" href={href('power', 'ignition')}>Edit ignition setup</Button>
    {/snippet}
  </PageHeader>

  <Card title="Ignition, live" aria-label="Ignition state">
    {#snippet tag()}<FwBadge version="5.6" />{/snippet}
    <p class="muted" role="status" data-testid="ignition-gap">Not available yet: the modules do not report an ignition state, a main module or the last change time until firmware 5.6 (gap G13). The four states are shown as designed.</p>
    <ol class="states" aria-label="Ignition states">
      {#each STATES as s (s.name)}
        <li class="st"><div class="box"><strong>{s.name}</strong><span class="muted">{s.out}</span><span class="mono muted">now: unknown</span></div>{#if s.next}<div class="arrow" aria-hidden="true"><span class="muted">{s.next}</span><span class="line"></span></div>{/if}</li>
      {/each}
    </ol>
    <p class="muted">From Running, one press of the button turns everything off and starts the power-down below. Cranking stops by itself after 8 s or when the engine runs.</p>
  </Card>

  <div class="two">
    <PowerDown {seq} />
    <ModuleSleepTable {seq} />
  </div>
</Page>

<style>
  .states { list-style: none; margin: 0; padding: 0; display: flex; align-items: stretch; }
  .st { flex: 1 1 0; display: flex; align-items: center; min-width: 0; }
  .box { flex: 1 1 auto; min-height: 110px; border-radius: var(--radius-lg); border: 2px dashed var(--color-line-strong); background: var(--color-raised); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .box strong { font-size: var(--text-lg); }
  .arrow { flex: none; width: 96px; display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: var(--text-xs); text-align: center; }
  .line { width: 100%; height: 2px; background: var(--color-line-strong); }
  .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); gap: var(--space-5); align-items: start; }
  @media (max-width: 1200px) { .two { grid-template-columns: minmax(0, 1fr); } .arrow { width: 56px; } }
</style>
