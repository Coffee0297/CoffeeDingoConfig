<script>
  // Expert > CAN & parameters (board H28): CAN map, DBC devices, raw parameters, project-vs-module compare.
  import { Page, PageHeader, Tabs } from '../../ui/index.js'
  import CanMap from './parts/CanMap.svelte'
  import DbcDevices from './parts/DbcDevices.svelte'
  import Params from './parts/Params.svelte'
  import Compare from './parts/Compare.svelte'

  let { query = {} } = $props()
  const TABS = ['can', 'dbc', 'par', 'cmp']
  let tab = $state('can')
  $effect.pre(() => { tab = TABS.includes(query?.tab) ? query.tab : 'can' })   // a link to another tab while this screen is open
  const items = [
    { value: 'can', label: 'CAN map' },
    { value: 'dbc', label: 'DBC devices' },
    { value: 'par', label: 'Parameters' },
    { value: 'cmp', label: 'Compare' },
  ]
</script>

<Page>
  <PageHeader title="CAN & parameters" subtitle="For when the blocks are not enough: the CAN ids on the bus, DBC files, every raw setting, and what the project holds against the modules." />
  <Tabs {items} bind:value={tab} label="CAN and parameter views">
    {#snippet panel(v)}
      <div class="pane">
        {#if v === 'can'}<CanMap />
        {:else if v === 'dbc'}<DbcDevices />
        {:else if v === 'par'}<Params />
        {:else}<Compare />{/if}
      </div>
    {/snippet}
  </Tabs>
</Page>

<style>
  .pane { display: flex; flex-direction: column; gap: var(--space-4); margin-top: var(--space-4); }
</style>
