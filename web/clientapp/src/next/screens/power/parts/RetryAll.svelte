<script>
  // "Tripped outputs" card: the signal that retries every tripped output on a module (upstream fault clear,
  // device param 0x0000:12). Only modules that have it (dev.retryAllInput != null) are listed.
  import { untrack } from 'svelte'
  import { Card, Select } from '../../../ui/index.js'
  import { api } from '../../../lib/live.svelte.js'
  import { writeDeviceInput } from './sleepLogic.js'
  import { remoteItems, resolveRemote, isRemoteKey } from '../../../lib/remote.js'

  let { mods = [] } = $props()
  const key = $derived(mods.map((d) => d.guid).join())
  let opts = $state({}), status = $state(''), busy = $state(false)
  async function load(g) {
    const [local, remote] = await Promise.all([api.inputs(g, 'bool').catch(() => []), remoteItems(g, 'bool').catch(() => [])])
    opts = { ...opts, [g]: [{ value: '0', label: 'No reset signal' }, ...local.filter((x) => x.kind !== 'sys').map((s) => ({ value: String(s.index), label: s.name })), ...remote] }
  }
  $effect(() => { key; untrack(() => { for (const d of mods) if (!opts[d.guid]) load(d.guid) }) })
  const items = (d) => { const it = opts[d.guid] ?? [{ value: '0', label: 'No reset signal' }]; const cur = String(d.retryAllInput ?? 0); return it.some((i) => i.value === cur) ? it : [...it, { value: cur, label: `Signal #${cur}` }] }

  async function pick(d, v) {
    busy = true; status = ''
    try {
      const n = await resolveRemote(d.guid, isRemoteKey(v) ? v : Number(v), 'bool')
      if (await writeDeviceInput(d, { retryAllInput: n })) status = `${d.name}: ${n ? 'reset signal set' : 'reset signal cleared'}.`
      if (isRemoteKey(v)) load(d.guid)
    } catch (e) { status = `${d.name}: ${e?.message ?? e}` } finally { busy = false }
  }
</script>

<Card title="Tripped outputs" aria-label="Retry tripped outputs">
  <p class="muted">A dash or keypad button that retries every tripped output on the module, without a power cycle. A held button retries once; the module allows one retry every 2 s, so a short is not hammered.</p>
  {#each mods as d (d.guid)}
    <Select label={`${d.name}: retry all tripped outputs when this turns on`} items={items(d)} value={String(d.retryAllInput ?? 0)} disabled={busy} onchange={(v) => pick(d, v)} data-testid="retry-all-input" />
  {/each}
  {#if status}<p class="muted" role="status" data-testid="retry-all-status">{status}</p>{/if}
</Card>
