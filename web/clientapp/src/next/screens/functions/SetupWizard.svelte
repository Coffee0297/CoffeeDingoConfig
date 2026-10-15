<script>
  // Set up a function from a template: a short guided wizard (see parts/Wizard.svelte). Route
  // functions/setup/<templateKey>[?edit=<id> | ?from=<id>]. edit changes an applied function; from copies one.
  import { Page, PageHeader, Button, Empty } from '../../ui/index.js'
  import { href } from '../../router.svelte.js'
  import { templateByKey } from './parts/catalog.js'
  import Wizard from './parts/Wizard.svelte'

  let { template, query = {} } = $props()
  const tpl = $derived(templateByKey(template))
</script>

<Page wide>
  <PageHeader crumbs={[{ label: 'Functions', href: href('functions') }, { label: 'Add function', href: href('functions', 'add') }, { label: tpl?.name ?? 'Unknown function' }]}
    title={tpl ? (query.edit ? 'Change ' + tpl.name : tpl.name) : 'Unknown function'}
    subtitle={tpl ? 'Nothing is written to the car until you apply.' : ''} />
  {#if !tpl}
    <Empty title="That function is not in the list" text="Pick one from the list of ready-made functions.">
      {#snippet actions()}<Button variant="primary" href={href('functions', 'add')}>Add a function</Button>{/snippet}
    </Empty>
  {:else}
    {#key template + '|' + (query.edit ?? '') + '|' + (query.from ?? '')}
      <Wizard {tpl} editId={query.edit ?? ''} fromId={query.from ?? ''} />
    {/key}
  {/if}
</Page>
