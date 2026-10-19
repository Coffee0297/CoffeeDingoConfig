<script>
  // "Load shedding" card: the signal that holds the opted-in outputs off on a module (upstream feat/load-shed, device
  // param 0x0000:13). Only modules that have it (dev.shedInput != null) are listed.
  import { untrack } from 'svelte'
  import { Card, Select } from '../../../ui/index.js'
  import { api } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import { writeDeviceInput } from './sleepLogic.js'
  import { remoteItems, resolveRemote, isRemoteKey } from '../../../lib/remote.js'

  let { mods = [] } = $props()
  const key = $derived(mods.map((d) => d.guid).join())
  let opts = $state({}), status = $state(''), busy = $state(false)
  async function load(g) {
    const [local, remote] = await Promise.all([api.inputs(g, 'bool').catch(() => []), remoteItems(g, 'bool').catch(() => [])])
    // module signals (always on, battery volts …) are never off: they would shed for good
    opts = { ...opts, [g]: [{ value: '0', label: 'Never shed' }, ...local.filter((x) => x.kind !== 'sys').map((s) => ({ value: String(s.index), label: s.name })), ...remote] }
  }
  $effect(() => { key; untrack(() => { for (const d of mods) if (!opts[d.guid]) load(d.guid) }) })
  const items = (d) => { const it = opts[d.guid] ?? [{ value: '0', label: 'Never shed' }]; const cur = String(d.shedInput ?? 0); return it.some((i) => i.value === cur) ? it : [...it, { value: cur, label: `Signal #${cur}` }] }
  const shedOuts = (d) => (d.outputs ?? []).filter((o) => o.shed).map((o) => o.name?.trim() || `out ${o.number}`)

  async function pick(d, v) {
    busy = true; status = ''
    try {
      const n = await resolveRemote(d.guid, isRemoteKey(v) ? v : Number(v), 'bool')
      if (await writeDeviceInput(d, { shedInput: n })) status = `${d.name}: ${n ? 'shed signal set' : 'load shedding off'}.`
      if (isRemoteKey(v)) load(d.guid)
    } catch (e) { status = `${d.name}: ${e?.message ?? e}` } finally { busy = false }
  }
</script>

<Card title="Load shedding" aria-label="Load shedding">
  <p class="muted">While this signal is on, the module holds off every output set to "Switch off while load shedding" (on the output's page), and lets them come back when it goes off. The <a href={href('functions', 'setup', 'loadshed')}>Load shed (low battery)</a> function builds the battery signal for you.</p>
  {#each mods as d (d.guid)}
    <Select label={`${d.name}: shed loads while this is on`} items={items(d)} value={String(d.shedInput ?? 0)} disabled={busy} onchange={(v) => pick(d, v)} data-testid="shed-input" />
    <p class="muted small">{shedOuts(d).length ? `Sheds: ${shedOuts(d).join(', ')}.` : 'No output is set to shed yet.'}</p>
  {/each}
  {#if status}<p class="muted" role="status" data-testid="shed-status">{status}</p>{/if}
</Card>

<style>
  .small { font-size: var(--text-xs); }
</style>
