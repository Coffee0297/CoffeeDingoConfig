<script>
  // Route: hardware/module/<guid>/input/<kind>/<n>. kind: input (digital) | analoginput | caninput.
  import { Page, PageHeader, Empty, Button } from '../../ui/index.js'
  import { device } from '../../lib/live.svelte.js'
  import { href } from '../../router.svelte.js'
  import { normKind } from './parts/util.js'
  import DigitalInputPanel from './parts/DigitalInputPanel.svelte'
  import AnalogInputPanel from './parts/AnalogInputPanel.svelte'
  import CanInputPanel from './parts/CanInputPanel.svelte'

  let { guid, kind, n } = $props()
  const k = $derived(normKind(kind))
  const dev = $derived(device(guid))
</script>

{#if !dev}
  <Page>
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: 'Module not found' }]} title="Module not found" />
    <Empty title="This module is not in the project" text="It may have been removed. Open Hardware to pick another.">
      {#snippet actions()}<Button href={href('hardware')}>Back to Hardware</Button>{/snippet}
    </Empty>
  </Page>
{:else}
  {#key guid + ':' + k + ':' + n}
    {#if k === 'input'}
      <DigitalInputPanel {guid} {n} />
    {:else if k === 'analoginput'}
      <AnalogInputPanel {guid} {n} />
    {:else if k === 'caninput'}
      <CanInputPanel {guid} {n} />
    {:else}
      <Page>
        <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: dev.name, href: href('hardware', 'module', guid) }, { label: 'Input' }]} title="Unknown input type" />
        <Empty title={`"${kind}" is not an input type`} text="Use input (digital), analoginput or caninput." />
      </Page>
    {/if}
  {/key}
{/if}
