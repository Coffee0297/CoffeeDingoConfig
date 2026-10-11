<script>
  // Pick any input on the bus for this module: its own signals, or another module's configured broadcast
  // signal, which becomes a local CAN input decoding that frame when picked (reused if one already does).
  // Search by name, connector pin ('J3-3', 'pin 3'), function ('DI3') or module. `value` is always a local
  // var-map index, so callers wire it exactly like a pick from a plain select. With `defer` a remote pick
  // only sets its 'remote:<guid>:<signal>' key and nothing is created (the Templates tab resolves it on
  // Apply); onload(opts) hands the caller the options so it can look a value's pin and module up.
  import SearchSelect from './SearchSelect.svelte'
  import { api, addCanInputFromBroadcast, ensureInputEnabled } from './store.js'
  import { busInputOptions } from './businputs.js'
  import { toast } from './toast.js'
  import { untrack } from 'svelte'
  let { device, devices = [], kind = 'bool', value = $bindable(), optional = false, defer = false, disabled = false, onpick = undefined, onload = undefined } = $props()

  let opts = $state([])
  let sel = $state(value ?? '')
  $effect(() => { sel = value ?? '' })

  async function load() {
    const types = kind === 'bool' ? ['bool'] : ['float', 'int']
    // In-use signals, plus this module's physical inputs nobody uses yet (enabled by whoever applies the pick).
    const [used, all] = await Promise.all([false, true].map(async (every) => (await Promise.all(types.map((t) => api.inputs(device.guid, t, every).catch(() => [])))).flat()))
    const usedIdx = new Set(used.map((v) => v.index))
    const local = [...used, ...all.filter((v) => !usedIdx.has(v.index) && (v.kind === 'input' || v.kind === 'analoginput')).map((v) => ({ ...v, unused: true }))]
    const others = (devices ?? []).filter((d) => d.guid !== device.guid && /pdm|can.?board/i.test(d.type ?? ''))
    const remotes = await Promise.all(others.map(async (d) => ({ device: d, sigs: await api.broadcastSignals(d.guid).catch(() => []) })))
    opts = [...(optional ? [{ value: '', label: '— none —' }] : []), ...busInputOptions(device, local, remotes, kind)]
    onload?.(opts)
  }
  // Once per module and kind, not once per telemetry push (`devices` is a fresh array every poll).
  $effect(() => { if (device?.guid) { kind; untrack(load) } })

  async function pick(v) {
    const o = opts.find((x) => x.value === v)
    if (!o || v === '' || defer) { value = v; onpick?.(v, o); return }
    try {
      if (o.unused) await ensureInputEnabled(o.local ? device.guid : o.source.guid, o.phys)   // an unused pin reads nothing
      if (o.local) { value = v; onpick?.(v, o); return }
      const r = await addCanInputFromBroadcast(device.guid, o.source, o.sig)
      const idx = kind === 'bool' ? (r.stateIndex ?? r.valueIndex) : (r.valueIndex ?? r.stateIndex)
      if (idx == null) throw new Error('created the CAN input but could not resolve its signal index')
      await load()
      value = idx; sel = idx; onpick?.(idx)
      toast(r.reused ? `Using the existing CAN input “${r.name}”.` : `Added CAN input “${r.name}”: ${o.label.replace('  (over CAN)', '')}.`, 'info')
    } catch (e) { sel = value ?? ''; toast('Couldn’t add: ' + e.message, 'error') }
  }
</script>

<SearchSelect options={opts} bind:value={sel} placeholder="Search: name, J3-3, DI3, module…" {disabled} onpick={pick} />
