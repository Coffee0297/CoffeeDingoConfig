<script>
  import { Page, PageHeader } from '../../ui/index.js'
  import { href } from '../../router.svelte.js'
  import SleepSimple from './parts/SleepSimple.svelte'
  import SleepCustom from './parts/SleepCustom.svelte'
  import WakeMatrix from './parts/WakeMatrix.svelte'
  import SleepLive from './parts/SleepLive.svelte'
  import WontSleep from './parts/WontSleep.svelte'
  let props = $props()
</script>

<Page wide>
  <PageHeader crumbs={[{ label: 'Power & ignition', href: href('power') }, { label: 'Sleep & wake' }]} title="Sleep & wake"
    subtitle="Simple settings first, custom below, live status on the right. The power-down order is the timeline on Power & ignition." />
  <div class="cols">
    <div class="col">
      <SleepSimple />
      <SleepCustom />
      <WakeMatrix />
    </div>
    <div class="col">
      <SleepLive />
      <WontSleep />
    </div>
  </div>
</Page>

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: var(--space-5); align-items: start; }
  .col { display: flex; flex-direction: column; gap: var(--space-5); min-width: 0; }
  @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
</style>
