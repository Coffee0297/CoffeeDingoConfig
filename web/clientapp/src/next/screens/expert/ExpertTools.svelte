<script>
  // Expert > AI agent & Sim replay (board H29).
  import { Page, PageHeader, Tabs } from '../../ui/index.js'
  import AiAgent from './parts/AiAgent.svelte'
  import SimReplay from './parts/SimReplay.svelte'

  let { query = {} } = $props()
  let tab = $state(query?.tab === 'sim' ? 'sim' : 'ai')
  const items = [{ value: 'ai', label: 'AI agent' }, { value: 'sim', label: 'Sim replay' }]
</script>

<Page>
  <PageHeader title="AI agent & Sim replay" subtitle="Let an AI assistant work on the car, or replay a recorded CAN log on the simulated bus." />
  <Tabs {items} bind:value={tab} label="Tools">
    {#snippet panel(v)}
      <div class="pane">{#if v === 'ai'}<AiAgent />{:else}<SimReplay />{/if}</div>
    {/snippet}
  </Tabs>
</Page>

<style>
  .pane { display: flex; flex-direction: column; gap: var(--space-4); margin-top: var(--space-4); }
</style>
