<script>
  // Hardware › one module: overview with tabs Outputs / Inputs / Settings.
  // Backed by telemetry (live.devices: outputs, battery, current, temp, state), GET /devices/{id}/signals
  // (live inputs, polled) and the module actions in Settings. Outputs and inputs link to their own screens.
  import { onMount } from 'svelte'
  import { Page, PageHeader, Card, Button, Tabs, StateDot, Chip, Empty, Banner } from '../../ui/index.js'
  import { live, api, device, moduleState, hex, defs, read, toast } from '../../lib/live.svelte.js'
  import { setupSheetHtml, printHtml } from '../../../lib/setupsheet.js'
  import { href, go } from '../../router.svelte.js'
  import ModuleSettings from './parts/ModuleSettings.svelte'
  import { hexId, fwText } from './parts/ids.js'
  import { isTripped, isOn, fmt1, num, worstCaseA } from '../car/parts/summary.js'

  let { guid, tab } = $props()

  const d = $derived(device(guid))
  const st = $derived(d ? moduleState(d) : null)
  const isPdm = $derived(/pdm/i.test(d?.type ?? ''))
  let current = $state('outputs')
  $effect.pre(() => { current = ['outputs', 'inputs', 'settings'].includes(tab) ? tab : 'outputs' })   // a link to another tab while this page is open
  $effect(() => { const t = current; try { history.replaceState(null, '', href('hardware', 'module', guid, t)) } catch { /* ignore */ } })

  // Live signals (inputs, and CANBoard outputs), polled while this page is open.
  let signals = $state(null)
  let sigErr = $state('')
  async function pull() {
    if (!d) return
    try { signals = await api.signals(guid); sigErr = '' } catch (e) { sigErr = e.message }
  }
  onMount(() => { pull(); const t = setInterval(pull, 1500); return () => clearInterval(t) })

  const byKind = (kind) => (signals ?? []).filter((s) => s.kind === kind).map((s, i) => ({ ...s, n: i + 1 }))

  // Which signal kinds are inputs, and the route kind the input screen expects.
  const INPUT_GROUPS = [
    { kind: 'Digital input', route: 'input', title: 'Digital inputs', unit: '' },
    { kind: 'Analog input', route: 'analoginput', title: 'Analog inputs', unit: 'mV' },
    { kind: 'CAN input', route: 'caninput', title: 'CAN inputs', unit: '' },
  ]
  let showUnused = $state({})

  const outputs = $derived.by(() => {
    if (!d) return []
    if (isPdm) return (d.outputs ?? []).map((o) => ({ n: o.number, name: o.name, enabled: o.enabled !== false, state: o.state, current: o.current, limit: o.currentLimit, input: o.input, tripped: isTripped(o), on: isOn(o) }))
    return byKind('Digital output').map((s) => ({ n: s.n, name: s.name, enabled: s.enabled, state: s.value === 'on' ? 'On' : s.value === 'off' ? 'Off' : `${s.value}%`, on: s.on, tripped: false }))
  })
  // Printable setup / pinout sheet: this module's project config, pins and wiring notes.
  let printing = $state(false)
  async function printSheet() {
    printing = true
    try {
      const [fx, map, vm] = await Promise.all([read(() => api.functions(guid)), api.canIdMap().catch(() => null), api.inputs(guid).catch(() => [])])
      if (!fx) return
      const names = Object.fromEntries((vm ?? []).map((v) => [v.index, v.name]))
      if (!printHtml(setupSheetHtml({ device: d, fx, defs, claimed: map?.claimed ?? {}, names }))) toast('The browser blocked the print window. Allow pop-ups for this page and try again.', 'error', 8000)
    } finally { printing = false }
  }
  const stateWord = (o) => (!d?.connected ? 'No data' : o.tripped ? 'Tripped' : o.on ? 'On' : 'Off')
  const stateTone = (o) => (!d?.connected ? 'stale' : o.tripped ? 'fault' : o.on ? 'on' : 'off')
  const stateShape = (o) => (!d?.connected ? 'ring' : o.tripped ? 'square' : o.on ? 'dot' : 'ring')
</script>

{#if !d}
  <Page>
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: 'Module' }]} title="Module not found" />
    <Empty title="This module is not in the project" text="It may have been removed, or the project was changed.">
      {#snippet actions()}<Button variant="primary" href={href('hardware')}>Back to Modules</Button>{/snippet}
    </Empty>
  </Page>
{:else}
  <Page>
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: 'Modules', href: href('hardware') }, { label: d.name }]} title={d.name} subtitle={`${d.type} · base ${hexId(d.baseId)} · firmware ${fwText(d)}`}>
      {#snippet tag()}<StateDot tone={st.key} shape={st.shape} label={st.word} />{/snippet}
      {#snippet actions()}
        <Button onclick={printSheet} busy={printing} data-testid="print-sheet">Print setup sheet</Button>
        {#if d.configMismatch}<Chip tone="warn" symbol="◆">Differs from the car or not compared yet</Chip>{/if}
      {/snippet}
    </PageHeader>

    <div class="stats">
      {#if isPdm}
        <div class="stat"><span class="nx-label">Battery</span><span class="v mono">{d.connected ? fmt1(num(d.battery)) + ' V' : '–'}</span></div>
        <div class="stat"><span class="nx-label">Current</span><span class="v mono">{d.connected ? fmt1(num(d.current)) + ' A' : '–'}</span></div>
        <div class="stat" title="The sum of the current limits of its enabled outputs: what it draws if every output hit its limit at once" data-testid="max-current">
          <span class="nx-label">Max current</span><span class="v mono">{fmt1(worstCaseA([d]))} A</span><span class="sub muted">if every limit tripped at once</span></div>
      {/if}
      <div class="stat"><span class="nx-label">Temperature</span><span class="v mono">{d.connected && Number.isFinite(d.temp) ? Math.round(d.temp) + ' °C' : '–'}</span></div>
      <div class="stat"><span class="nx-label">Reported state</span><span class="v">{d.state || (d.connected ? 'Running' : '–')}</span></div>
    </div>

    {#if !d.connected}
      <Banner tone="warn" title={live.connected ? `${d.name} is not answering` : 'Not connected'}>Values below are from the project, not from the module. {live.connected ? 'Check power, wiring, base ID and speed.' : 'Connect to see live values.'}</Banner>
    {/if}

    <div class="wrap"><Tabs label="Module" bind:value={current} items={[{ value: 'outputs', label: 'Outputs', count: outputs.filter((o) => o.enabled).length }, { value: 'inputs', label: 'Inputs' }, { value: 'settings', label: 'Settings' }]}>
      {#snippet panel(v)}
        {#if v === 'outputs'}
          <Card>
            {#if !outputs.length}
              <p class="muted">{isPdm ? 'This module reports no outputs.' : signals ? 'This module has no outputs.' : 'Reading the outputs…'}</p>
            {:else}
              <table class="nx-table" aria-label="Outputs">
                <thead><tr><th>#</th><th>Name</th><th>State</th>{#if isPdm}<th>Current</th><th>Limit</th><th>Driven by</th>{/if}<th><span class="sr-only">Open</span></th></tr></thead>
                <tbody>
                  {#each outputs as o (o.n)}
                    <tr class:unused={!o.enabled} data-testid={'out-' + o.n}>
                      <td class="mono">{o.n}</td>
                      <td>{o.name}{#if !o.enabled} <Chip dashed>Unused</Chip>{/if}</td>
                      <td>{#if o.enabled}<StateDot tone={stateTone(o)} shape={stateShape(o)} label={stateWord(o)} />{:else}<span class="muted">–</span>{/if}</td>
                      {#if isPdm}
                        <td class="mono">{o.enabled && d.connected ? fmt1(num(o.current)) + ' A' : '–'}</td>
                        <td class="mono">{o.enabled ? fmt1(num(o.limit)) + ' A' : '–'}</td>
                        <td class="muted">{o.enabled ? (o.input || 'nothing') : '–'}</td>
                      {/if}
                      <td><Button size="sm" href={href('hardware', 'module', guid, 'output', o.n)} aria-label={`Open output ${o.n}, ${o.name}`}>Open</Button></td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </Card>
        {:else if v === 'inputs'}
          {#if sigErr}<Banner tone="fault" title="Could not read the inputs">{sigErr}</Banner>{/if}
          {#each INPUT_GROUPS as g (g.kind)}
            {@const all = byKind(g.kind)}
            {#if all.length}
              {@const used = all.filter((s) => s.enabled)}
              {@const unused = all.length - used.length}
              <Card title={g.title} subtitle={`${used.length} in use, ${unused} unused`}>
                <table class="nx-table" aria-label={g.title}>
                  <thead><tr><th>#</th><th>Name</th><th>Now</th><th><span class="sr-only">Open</span></th></tr></thead>
                  <tbody>
                    {#each (showUnused[g.kind] ? all : used) as s (s.n)}
                      <tr class:unused={!s.enabled} data-testid={'in-' + g.route + '-' + s.n}>
                        <td class="mono">{s.n}</td>
                        <td>{s.name}{#if !s.enabled} <Chip dashed>Unused</Chip>{/if}</td>
                        <td><StateDot tone={!d.connected ? 'stale' : s.on ? 'on' : 'off'} shape={s.on && d.connected ? 'dot' : 'ring'} label={d.connected ? (g.unit ? `${s.value} ${g.unit}` : /^(on|off)$/.test(s.value) ? s.value[0].toUpperCase() + s.value.slice(1) : s.value) : 'No data'} /></td>
                        <td><Button size="sm" href={href('hardware', 'module', guid, 'input', g.route, s.n)} aria-label={`Open ${g.title.toLowerCase().replace(/s$/, '')} ${s.n}, ${s.name}`}>Open</Button></td>
                      </tr>
                    {:else}
                      <tr><td colspan="4" class="muted">None in use.</td></tr>
                    {/each}
                  </tbody>
                </table>
                {#if unused > 0}
                  <div><Button size="sm" aria-expanded={!!showUnused[g.kind]} onclick={() => (showUnused[g.kind] = !showUnused[g.kind])}>{showUnused[g.kind] ? 'Hide unused' : `Show ${unused} unused`}</Button></div>
                {/if}
              </Card>
            {/if}
          {:else}
            {#if !signals}<p class="muted">Reading the inputs…</p>{/if}
          {/each}
        {:else}
          <div class="set"><ModuleSettings {guid} full onremoved={() => go('hardware')} /></div>
        {/if}
      {/snippet}
    </Tabs></div>
  </Page>
{/if}

<style>
  .stats { display: flex; gap: var(--space-4); flex-wrap: wrap; }
  .sub { font-size: var(--text-xs); }
  .stat { display: flex; flex-direction: column; gap: 2px; min-width: 140px; padding: var(--space-3) var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface); }
  .v { font-size: var(--text-lg); font-weight: 600; }
  tr.unused td { color: var(--color-text-muted); }
  .wrap :global(.nx-tabpanel) { display: flex; flex-direction: column; gap: var(--space-4); padding-top: var(--space-4); }
  .set { max-width: 760px; }
</style>
