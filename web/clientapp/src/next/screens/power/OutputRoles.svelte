<script>
  // Output roles: what each output does when the ignition changes. The roles need firmware 5.6 (gap G13), so
  // every role control is disabled; the list itself is real (every output of every PDM). The bench test of an
  // output lives on the output screen.
  import { Page, PageHeader, Banner, Card, FwBadge, Button, Chip } from '../../ui/index.js'
  import { href } from '../../router.svelte.js'
  import { live, hex } from '../../lib/live.svelte.js'
  import { pinFor } from '../../../lib/pinmap.js'
  let props = $props()

  const ROLES = ['Ignition', 'Accessory', 'Starter', 'Dash', 'Always on', 'None']
  const LEGEND = {
    Ignition: 'On with the ignition, off when it goes off. Fuel pump, ECU, coils.',
    Accessory: 'Like Ignition, and also off while the engine is cranking to free current for the starter.',
    Starter: 'On only while cranking, for the starter solenoid. Only one output may have it.',
    Dash: 'Stays on after ignition off and follows the power-down sequence: shutdown frame, then power cut.',
    'Always on': 'Never switched by the ignition. Can be ignored when the car decides to sleep.',
    None: 'Not part of ignition. Driven only by its own chain in the flow builder.',
  }
  const pdms = $derived(live.devices.filter((d) => /pdm/i.test(d.type ?? '')))
  const total = $derived(pdms.reduce((n, d) => n + (d.outputs?.length ?? 0), 0))
  const versions = $derived([...new Set(pdms.map((d) => d.version).filter(Boolean))].join(', ') || 'unknown')
  const spec = (d, o) => {
    const p = pinFor(d, 'output', o.number)
    return [p?.label, o.currentLimit ? `${o.currentLimit} A` : ''].filter(Boolean).join(' · ')
  }
</script>

<Page>
  <PageHeader crumbs={[{ label: 'Power & ignition', href: href('power') }, { label: 'Output roles' }]} title="Output roles"
    subtitle="What each output does when the ignition turns on, off or cranks.">
    {#snippet tag()}<FwBadge version="5.6" />{/snippet}
  </PageHeader>

  <Banner tone="warn" title="Roles need firmware 5.6" data-testid="roles-banner">
    The modules run {versions}. Until the Ignition block ships, the modules cannot store a role and these lists are read-only (gap G13). The outputs below are your real outputs.
  </Banner>

  <div class="cols">
    <div class="mods">
      {#each pdms as d (d.guid)}
        <Card title={d.name} subtitle={hex(d.baseId)} aria-label={`${d.name} outputs`}>
          {#snippet actions()}<FwBadge version="5.6" />{/snippet}
          {#if !d.outputs?.length}<p class="muted">No outputs read from this module yet.</p>{/if}
          <ul class="rows" data-testid={`roles-${d.name}`}>
            {#each d.outputs ?? [] as o (o.number)}
              <li class="row" data-output={o.number}>
                <span class="o mono">o{o.number}</span>
                <span class="nm"><strong>{o.name || `Output ${o.number}`}</strong><span class="muted sp">{spec(d, o)}{o.enabled ? '' : ' · not enabled'}</span><span class="muted fx">Role not stored yet</span></span>
                <label class="sr-only" for={`role-${d.guid}-${o.number}`}>Role for {o.name || `output ${o.number}`}, {d.name} output {o.number}</label>
                <select id={`role-${d.guid}-${o.number}`} class="nx-input role" disabled data-testid={`role-${d.name}-o${o.number}`}>
                  <option>Not available</option>
                  {#each ROLES as r (r)}<option>{r}</option>{/each}
                </select>
              </li>
            {/each}
          </ul>
        </Card>
      {/each}
      {#if !pdms.length}<Card title="No PDM in the project"><p class="muted">Add a PDM to see its outputs here.</p></Card>{/if}
    </div>

    <div class="side">
      <Card title="Conflicts" aria-label="Conflicts">
        <p class="muted" role="status" data-testid="roles-conflicts">Nothing to check yet: no role is stored. Two outputs with the role Starter will be flagged here once roles exist.</p>
      </Card>
      <Card title="What each role does" aria-label="Roles at a glance">
        <dl class="legend">
          {#each ROLES as r (r)}
            <div><dt><strong>{r}</strong> <Chip tone="muted" dashed>0 of {total}</Chip></dt><dd class="muted">{LEGEND[r]}</dd></div>
          {/each}
        </dl>
        <p class="muted">The number will be how many of the {total} outputs have the role.</p>
      </Card>
      <Button href={href('power', 'ignition')}>Back to ignition setup</Button>
    </div>
  </div>
</Page>

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: var(--space-5); align-items: start; }
  .mods { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: var(--space-4); align-items: start; }
  .side { display: flex; flex-direction: column; gap: var(--space-4); align-items: flex-start; }
  .side :global(.card) { align-self: stretch; }
  .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .row { display: grid; grid-template-columns: 36px minmax(0, 1fr) 150px; gap: var(--space-3); align-items: center; padding: var(--space-2) 0; border-bottom: 1px solid var(--color-line); }
  .nm { display: flex; flex-direction: column; min-width: 0; }
  .sp, .fx { font-size: var(--text-xs); }
  .role { min-width: 0; }
  .legend { margin: 0; display: flex; flex-direction: column; gap: var(--space-3); }
  .legend dd { margin: 2px 0 0; }
  @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
</style>
