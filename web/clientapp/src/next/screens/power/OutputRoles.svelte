<script>
  // Output roles: what each output does when the ignition changes. A role is the output's input set to one of
  // its module's ignition signals (firmware 5.6 var map: Ignition, Accessory, Cranking, Dash, Ready) or to
  // Always On; anything else is the output's own rule. Accessory is already off while cranking in the
  // firmware, so no extra starter-disable is needed. Backed by GET /devices/{id}/inputs and POST /outputconfig.
  import { Page, PageHeader, Banner, Card, FwBadge, Button, Chip } from '../../ui/index.js'
  import { href } from '../../router.svelte.js'
  import { live, hex, api, mutate } from '../../lib/live.svelte.js'
  import { pinFor } from '../../../lib/pinmap.js'
  import { olderThan } from '../hardware/parts/util.js'

  // role -> the var-map property it follows ('always' = sys Always On, index 1)
  const ROLES = [
    { r: 'Ignition', prop: 'Ignition', what: 'On with the ignition, off when it goes off. Fuel pump, ECU, coils.' },
    { r: 'Accessory', prop: 'Accessory', what: 'Like Ignition, and also off while the engine is cranking to free current for the starter.' },
    { r: 'Starter', prop: 'Cranking', what: 'On only while cranking, for the starter solenoid. Only one output may have it.' },
    { r: 'Dash', prop: 'Dash', what: 'On with the ignition and for the dash hold time after it goes off.' },
    { r: 'Start light', prop: 'Ready', what: 'Lit when ready to start: ignition on, engine not running, not cranking.' },
    { r: 'Always on', prop: 'always', what: 'Never switched by the ignition.' },
  ]
  const pdms = $derived(live.devices.filter((d) => /pdm/i.test(d.type ?? '')))
  const newFw = $derived(pdms.filter((d) => !olderThan(d.version, [5, 6, 0])))
  const total = $derived(pdms.reduce((n, d) => n + (d.outputs?.length ?? 0), 0))
  const versions = $derived([...new Set(pdms.map((d) => d.version).filter(Boolean))].join(', ') || 'unknown')
  const spec = (d, o) => {
    const p = pinFor(d, 'output', o.number)
    return [p?.label, o.currentLimit ? `${o.currentLimit} A` : ''].filter(Boolean).join(' · ')
  }

  // ignition var indexes per module: { prop -> index }
  let idx = $state({}), loadedFor = ''
  $effect(() => {
    const key = newFw.map((d) => d.guid).join(',')
    if (key === loadedFor) return
    loadedFor = key
    for (const d of newFw) api.inputs(d.guid).then((vars) => {
      const m = { always: 1 }
      for (const v of vars ?? []) if (v.kind === 'ignition') m[v.prop] = v.index
      idx[d.guid] = m
    }).catch(() => {})
  })
  const roleOf = (d, o) => {
    const m = idx[d.guid]
    if (!m || !o.inputVal) return ''
    return ROLES.find((x) => m[x.prop] === o.inputVal)?.r ?? ''
  }
  const counts = $derived(Object.fromEntries(ROLES.map((x) => [x.r, pdms.reduce((n, d) => n + (d.outputs ?? []).filter((o) => roleOf(d, o) === x.r).length, 0)])))
  const starters = $derived(pdms.flatMap((d) => (d.outputs ?? []).filter((o) => roleOf(d, o) === 'Starter').map((o) => `${d.name} o${o.number}`)))
  const noIgn = $derived(newFw.filter((d) => !d.ignition?.enabled && (d.outputs ?? []).some((o) => roleOf(d, o) && roleOf(d, o) !== 'Always on')))

  async function setRole(d, o, value) {
    if (value === '') return
    const target = value === 'none' ? 0 : idx[d.guid]?.[ROLES.find((x) => x.r === value)?.prop]
    if (target == null) return
    const what = value === 'none' ? `${o.name || 'Output ' + o.number}: no input` : `${o.name || 'Output ' + o.number} is now ${value}`
    await mutate(() => api.outputConfig(d.guid, { Number: o.number, Input: target, ...(value === 'none' ? {} : { Enabled: true }) }), what)
  }
</script>

<Page>
  <PageHeader crumbs={[{ label: 'Power & ignition', href: href('power') }, { label: 'Output roles' }]} title="Output roles"
    subtitle="What each output does when the ignition turns on, off or cranks.">
    {#snippet tag()}{#if !newFw.length}<FwBadge version="5.6" />{/if}{/snippet}
  </PageHeader>

  {#if !newFw.length}
    <Banner tone="warn" title="Roles need firmware 5.6" data-testid="roles-banner">
      The modules run {versions}. Without the Ignition block an output has nothing to follow, so these lists are read-only. <a href={href('hardware', 'firmware')}>Update firmware</a>
    </Banner>
  {:else if noIgn.length}
    <Banner tone="warn" title="Ignition is not set up on every module" data-testid="roles-banner">
      {noIgn.map((d) => d.name).join(', ')} {noIgn.length === 1 ? 'has' : 'have'} outputs with a role but no Ignition block on, so those outputs stay off. <a href={href('power', 'ignition')}>Set up the ignition</a>
    </Banner>
  {/if}

  <div class="cols">
    <div class="mods">
      {#each pdms as d (d.guid)}
        {@const old = olderThan(d.version, [5, 6, 0])}
        <Card title={d.name} subtitle={hex(d.baseId)} aria-label={`${d.name} outputs`}>
          {#snippet actions()}{#if old}<FwBadge version="5.6" />{/if}{/snippet}
          {#if !d.outputs?.length}<p class="muted">No outputs read from this module yet.</p>{/if}
          <ul class="rows" data-testid={`roles-${d.name}`}>
            {#each d.outputs ?? [] as o (o.number)}
              {@const role = roleOf(d, o)}
              <li class="row" data-output={o.number}>
                <span class="o mono">o{o.number}</span>
                <span class="nm"><strong>{o.name || `Output ${o.number}`}</strong><span class="muted sp">{spec(d, o)}{o.enabled ? '' : ' · not enabled'}</span>
                  <span class="muted fx">{role ? 'follows the ignition' : o.inputVal ? `own rule: ${o.input}` : 'no input'}</span></span>
                <label class="sr-only" for={`role-${d.guid}-${o.number}`}>Role for {o.name || `output ${o.number}`}, {d.name} output {o.number}</label>
                <select id={`role-${d.guid}-${o.number}`} class="nx-input role" disabled={old || !idx[d.guid]} value={role} onchange={(e) => setRole(d, o, e.currentTarget.value)} data-testid={`role-${d.name}-o${o.number}`}>
                  {#if old}<option value="">Not available</option>{:else if !role}<option value="">{o.inputVal ? 'Own rule' : 'None'}</option>{/if}
                  {#each ROLES as x (x.r)}<option value={x.r}>{x.r}</option>{/each}
                  {#if role}<option value="none">None (no input)</option>{/if}
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
        <p class="muted" role="status" data-testid="roles-conflicts">{starters.length > 1 ? `■ ${starters.length} outputs have the role Starter: ${starters.join(', ')}. Only one may crank.` : 'No conflicts. Two outputs with the role Starter would be flagged here.'}</p>
      </Card>
      <Card title="What each role does" aria-label="Roles at a glance">
        <dl class="legend">
          {#each ROLES as x (x.r)}
            <div><dt><strong>{x.r}</strong> <Chip tone="muted">{counts[x.r] ?? 0} of {total}</Chip></dt><dd class="muted">{x.what}</dd></div>
          {/each}
        </dl>
        <p class="muted">A role sets the output's input; changing it on the output's own page later turns it back into its own rule.</p>
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
  @media (max-width: 640px) { .mods { grid-template-columns: minmax(0, 1fr); } }
</style>
