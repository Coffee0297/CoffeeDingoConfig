<script>
  import { Page, PageHeader, Button, Banner, Card, FwBadge, Chip } from '../../ui/index.js'
  import { href } from '../../router.svelte.js'
  import { live } from '../../lib/live.svelte.js'
  import PowerDown from './parts/PowerDown.svelte'
  import ModuleSleepTable from './parts/ModuleSleepTable.svelte'
  import RetryAll from './parts/RetryAll.svelte'
  import { canSleep } from './parts/sleepLogic.js'
  import { has56, ignitionMain } from './parts/ignition.js'
  import { onDestroy } from 'svelte'
  import { watchSequence } from './parts/sequence.svelte.js'
  let props = $props()
  const seq = watchSequence()
  onDestroy(() => seq.stop())

  const modules = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  const retryMods = $derived(modules.filter((d) => d.retryAllInput != null))   // upstream fault clear
  const sleepers = $derived(modules.filter((d) => canSleep(d) && d.sleepEnabled))
  // firmware 5.6: the main module's ignition state (from its own state frame)
  const ignMain = $derived(ignitionMain(modules))
  const ign = $derived(ignMain?.ignition ?? null)
  const anyNew = $derived(modules.some(has56))
  const nowKey = $derived(!ign?.live ? '' : ign.state === 'off' ? 'Off' : ign.state === 'on' ? 'Ignition' : ign.state === 'cranking' ? 'Cranking' : 'Running')
  const sub = $derived(!modules.length ? 'No modules in the project yet.'
    : `${modules.length} modules` + (sleepers.length ? ` · ${sleepers.length} sleep on their own after about ${Math.round(Math.min(...sleepers.map((d) => d.sleepTimeoutMs)) / 1000)} s of nothing in use` : ' · none sleep on their own') + (ignMain ? ` · ignition on ${ignMain.name}` : anyNew ? ' · ignition not set up' : ' · ignition setup needs firmware 5.6'))
  const STATES = [
    { name: 'Off', out: 'dash on for the dash hold time', next: 'switch or button' },
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
    {#snippet tag()}{#if ign?.live}<Chip tone="on" symbol="●">LIVE</Chip>{:else if !anyNew}<FwBadge version="5.6" />{/if}{/snippet}
    {#if ignMain}
      <p class="muted" role="status" data-testid="ignition-gap">{ign.live ? `${ignMain.name} runs the ignition. Now: ${nowKey}.` : `${ignMain.name} runs the ignition but its state frame is not heard right now.`}</p>
    {:else if anyNew}
      <Banner tone="warn" title="The ignition is not set up yet" data-testid="ignition-gap">Pick the main module and its switch and button, so outputs can follow the ignition.
        {#snippet actions()}<Button variant="primary" size="sm" href={href('power', 'ignition')} data-testid="ignition-setup">Set up ignition</Button>{/snippet}
      </Banner>
    {:else}
      <p class="muted" role="status" data-testid="ignition-gap">The modules report an ignition state from firmware 5.6. The four states are shown as designed.</p>
    {/if}
    <ol class="states" aria-label="Ignition states">
      {#each STATES as s (s.name)}
        <li class="st"><div class="box"><strong>{s.name}</strong><span class="muted">{s.out}</span><span class="mono muted">{nowKey === s.name ? '● now' : ''}</span></div>{#if s.next}<div class="arrow" aria-hidden="true"><span class="muted">{s.next}</span><span class="line"></span></div>{/if}</li>
      {/each}
    </ol>
    <p class="muted">Cranking stops by itself after the max crank time or when the engine runs. In "start button only" mode, a press while running turns everything off.</p>
  </Card>

  <div class="two">
    <PowerDown {seq} />
    <ModuleSleepTable {seq} />
  </div>
  {#if retryMods.length}<RetryAll mods={retryMods} />{/if}
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
  @media (max-width: 900px) { .states, .st { flex-direction: column; align-items: stretch; } .box { min-height: 0; } .arrow { width: auto; flex-direction: row; justify-content: center; padding: 4px 0; } .line { width: 2px; height: 16px; } }
</style>
