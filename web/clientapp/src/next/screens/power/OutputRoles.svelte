<script>
  import { untrack } from 'svelte'
  // Output roles: what each output does when the ignition changes. A role is the output's input set to one of
  // its module's ignition signals (firmware 5.6 var map: Ignition, Accessory, Cranking, Dash, Ready) or to
  // Always On; anything else is Custom (the output's own rule). Accessory is already off while cranking in the
  // firmware, so no extra starter-disable is needed. Backed by GET /devices/{id}/inputs and POST /outputconfig.
  // Firmware 5.7 PDMs have their own output roles (0x1E00 sub 0x30 + output: Ignition / Accessory / Dash / Starter,
  // overriding the output's input while the Ignition block is on): those four are set there (POST /function/ignition/1).
  import { Page, PageHeader, Banner, Card, FwBadge, Button, Chip } from '../../ui/index.js'
  import { href } from '../../router.svelte.js'
  import { live, hex, api, mutate, toast, project } from '../../lib/live.svelte.js'
  import Confirm from './parts/Confirm.svelte'
  import { pinFor } from '../../../lib/pinmap.js'
  import { lacks, isUpstream, has } from '../hardware/parts/util.js'

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
  const newFw = $derived(pdms.filter((d) => !lacks(d, [5, 6, 0], 0x1E00)))
  const total = $derived(pdms.reduce((n, d) => n + (d.outputs?.length ?? 0), 0))
  const versions = $derived([...new Set(pdms.map((d) => d.version).filter(Boolean))].join(', ') || 'unknown')
  const spec = (d, o) => {
    const p = pinFor(d, 'output', o.number)
    return [p?.label, o.currentLimit ? `${o.currentLimit} A` : ''].filter(Boolean).join(' · ')
  }

  const FW_ROLE = { Ignition: 1, Accessory: 2, Dash: 3, Starter: 4 }
  // ignition var indexes per module: { prop -> index }; 5.7 output roles per module (null: the module has none)
  let idx = $state({}), fwRoles = $state({}), loadedFor = ''
  $effect(() => {
    const key = newFw.map((d) => d.guid).join(',')
    if (key === loadedFor) return
    loadedFor = key
    for (const d of newFw) api.inputs(d.guid).then((vars) => {
      const m = { always: 1 }
      for (const v of vars ?? []) if (v.kind === 'ignition') m[v.prop] = v.index
      idx[d.guid] = m
    }).catch(() => {})
    untrack(() => { for (const d of newFw.filter((d) => isUpstream(d) && has(d, 0x1E00, 0x30))) api.functions(d.guid).then((fn) => { fwRoles[d.guid] = fn?.ignition?.outputRoles ?? null }).catch(() => {}) })   // keyed on the guids only
  })
  const roleOf = (d, o) => {
    const fr = fwRoles[d.guid]?.[o.number - 1]
    if (fr) return Object.keys(FW_ROLE).find((k) => FW_ROLE[k] === fr) ?? ''
    const m = idx[d.guid]
    if (!m || !o.inputVal) return ''
    return ROLES.find((x) => m[x.prop] === o.inputVal)?.r ?? ''
  }
  const counts = $derived(Object.fromEntries(ROLES.map((x) => [x.r, pdms.reduce((n, d) => n + (d.outputs ?? []).filter((o) => roleOf(d, o) === x.r).length, 0)])))
  const starters = $derived(pdms.flatMap((d) => (d.outputs ?? []).filter((o) => roleOf(d, o) === 'Starter').map((o) => `${d.name} o${o.number}`)))
  const noIgn = $derived(newFw.filter((d) => !d.ignition?.enabled && (d.outputs ?? []).some((o) => roleOf(d, o) && roleOf(d, o) !== 'Always on')))

  async function setRole(d, o, value) {
    if (value === '') return
    const roles = fwRoles[d.guid]
    if (roles) {
      // 5.7: the module's own role for the four ignition roles; anything else clears it and goes through the input
      const next = [...roles]
      next[o.number - 1] = FW_ROLE[value] ?? 0
      if (next[o.number - 1] !== roles[o.number - 1])
        await mutate(async () => { await api.setFunction(d.guid, 'ignition', 1, { outputRoles: next }); fwRoles[d.guid] = next; if (FW_ROLE[value]) await api.outputConfig(d.guid, { Number: o.number, Enabled: true }) },
          FW_ROLE[value] ? `${o.name || 'Output ' + o.number} is now ${value}` : `${o.name || 'Output ' + o.number}: ignition role cleared`)
      if (FW_ROLE[value]) return
    }
    const target = value === 'none' ? 0 : idx[d.guid]?.[ROLES.find((x) => x.r === value)?.prop]
    if (target == null) return
    const what = value === 'none' ? `${o.name || 'Output ' + o.number}: no input` : `${o.name || 'Output ' + o.number} is now ${value}`
    await mutate(() => api.outputConfig(d.guid, { Number: o.number, Input: target, ...(value === 'none' ? {} : { Enabled: true }) }), what)
  }

  // Unused = not enabled but still has an input (a role or a custom rule) left over.
  const unused = $derived(newFw.flatMap((d) => (d.outputs ?? []).filter((o) => !o.enabled && o.inputVal).map((o) => ({ d, o }))))
  let askNone = $state(false), noneBusy = $state(false)
  async function clearUnused() {
    noneBusy = true
    const failed = []
    for (const { d, o } of unused) {
      try { await api.outputConfig(d.guid, { Number: o.number, Input: 0 }) } catch (e) { failed.push(`${d.name} o${o.number}: ${e?.message ?? e}`) }
    }
    project.dirty = true
    noneBusy = false; askNone = false
    if (failed.length) toast(`Not every output changed: ${failed.join('; ')}`, 'error', 9000)
    else toast('Unused outputs set to None. Apply to car to store it.', 'info', 4000)
  }
</script>

<Page>
  <PageHeader crumbs={[{ label: 'Power & ignition', href: href('power') }, { label: 'Output roles' }]} title="Output roles"
    subtitle="What each output does when the ignition turns on, off or cranks.">
    {#snippet actions()}<Button disabled={!unused.length || noneBusy} title={unused.length ? '' : 'No output that is not enabled has an input left'} onclick={() => (askNone = true)} data-testid="roles-unused-none">Set all unused to None{unused.length ? ` (${unused.length})` : ''}</Button>{/snippet}
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
        {@const old = lacks(d, [5, 6, 0], 0x1E00)}
        <Card title={d.name} subtitle={hex(d.baseId)} aria-label={`${d.name} outputs`}>
          {#snippet actions()}{#if old}<FwBadge version="5.6" upstream={isUpstream(d)} />{/if}{/snippet}
          {#if !d.outputs?.length}<p class="muted">No outputs read from this module yet.</p>{/if}
          <ul class="rows" data-testid={`roles-${d.name}`}>
            {#each d.outputs ?? [] as o (o.number)}
              {@const role = roleOf(d, o)}
              <li class="row" data-output={o.number}>
                <span class="o mono">o{o.number}</span>
                <span class="nm"><strong>{o.name || `Output ${o.number}`}</strong><span class="muted sp">{spec(d, o)}{o.enabled ? '' : ' · not enabled'}</span>
                  <span class="muted fx">{role ? 'follows the ignition' : o.inputVal ? `Custom: ${o.input}` : 'no input'}</span></span>
                <label class="sr-only" for={`role-${d.guid}-${o.number}`}>Role for {o.name || `output ${o.number}`}, {d.name} output {o.number}</label>
                <select id={`role-${d.guid}-${o.number}`} class="nx-input role" disabled={old || !idx[d.guid]} value={role} onchange={(e) => setRole(d, o, e.currentTarget.value)} data-testid={`role-${d.name}-o${o.number}`}>
                  {#if old}<option value="">Not available</option>{:else if !role}<option value="">{o.inputVal ? 'Custom' : 'None'}</option>{/if}
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
            <div><dt><strong>{x.r}</strong> <Chip tone="muted">used by {counts[x.r] ?? 0}</Chip></dt><dd class="muted">{x.what}</dd></div>
          {/each}
        </dl>
        <p class="muted">A role sets the output's input; changing it on the output's own page later makes it Custom again.{#if Object.values(fwRoles).some(Boolean)} On firmware 5.7 Ignition, Accessory, Dash and Starter are the module's own output roles instead: they override the output's input while the Ignition block is on.{/if}</p>
      </Card>
      <Button href={href('power', 'ignition')}>Back to ignition setup</Button>
    </div>
  </div>
  <Confirm bind:open={askNone} title="Set all unused outputs to None?" confirmLabel={`Set ${unused.length} to None`} busy={noneBusy} onconfirm={clearUnused}
    description="These outputs are not enabled but still have an input. Each one loses it; nothing switches, they stay off."
    consequence="Pick the role again, or give the output its input back on its own page.">
    <p class="muted">{unused.map(({ d, o }) => `${d.name} o${o.number}`).join(', ')}</p>
  </Confirm>
</Page>

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: var(--space-5); align-items: start; }
  .mods { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: var(--space-4); align-items: start; }
  .side { display: flex; flex-direction: column; gap: var(--space-4); align-items: flex-start; }
  .side :global(.card) { align-self: stretch; }
  .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .row { display: grid; grid-template-columns: 36px minmax(0, 1fr) 160px; gap: var(--space-3); align-items: center; padding: var(--space-2) 0; border-bottom: 1px solid var(--color-line); }
  .nm { display: flex; flex-direction: column; min-width: 0; }
  .sp, .fx { font-size: var(--text-xs); }
  .role { min-width: 0; }
  .legend { margin: 0; display: flex; flex-direction: column; gap: var(--space-3); }
  .legend dd { margin: 2px 0 0; }
  @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 640px) { .mods { grid-template-columns: minmax(0, 1fr); } .row { grid-template-columns: 28px minmax(0, 1fr) 130px; } }
</style>
