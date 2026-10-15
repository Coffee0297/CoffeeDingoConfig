<script>
  import { Page, PageHeader, Tabs } from '../../ui/index.js'
  import LiveTabs from './parts/LiveTabs.svelte'
  import CanTraffic from './parts/CanTraffic.svelte'
  import SysLog from './parts/SysLog.svelte'

  let tab = $state('can')
</script>

<Page wide>
  <PageHeader title="Live">
    {#snippet tag()}<LiveTabs current="logs" />{/snippet}
  </PageHeader>

  <Tabs label="Log type" bind:value={tab} items={[{ value: 'can', label: 'CAN traffic' }, { value: 'sys', label: 'System log' }]}>
    {#snippet panel(v)}
      {#if v === 'can'}<CanTraffic />{:else}<SysLog />{/if}
    {/snippet}
  </Tabs>
</Page>
