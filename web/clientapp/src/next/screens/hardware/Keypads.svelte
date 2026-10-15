<script>
  // Keypads configured on the modules: list, add, face (keys, LEDs, backlight), button mapping, expert SDO.
  import { onMount, onDestroy } from 'svelte'
  import { Page, PageHeader, Banner, Empty } from '../../ui/index.js'
  import { live, api, isPdm } from '../../lib/live.svelte.js'
  import { pollCanRates } from '../power/parts/canRates.svelte.js'
  import { loadKeypads } from './parts/keypads/keypadLogic.js'
  import KeypadList from './parts/keypads/KeypadList.svelte'
  import KeypadFace from './parts/keypads/KeypadFace.svelte'
  import ButtonEditor from './parts/keypads/ButtonEditor.svelte'
  import SdoExpert from './parts/keypads/SdoExpert.svelte'
  let props = $props()

  const pdms = $derived(live.devices.filter((d) => isPdm(d)))
  let pads = $state([]), free = $state([]), loaded = $state(false), loadErr = $state('')
  let selKey = $state(''), selBtn = $state(1), signals = $state([])
  const poller = pollCanRates(2000)
  let timer, stopped = false, again = false

  let current = null
  // One read at a time. A write that finishes while a read runs asks for one more read; callers wait for the last one.
  function reload() {
    if (current) { again = true; return current }
    current = (async () => {
      do {
        again = false
        try {
          const r = await loadKeypads(pdms)
          pads = r.pads; free = r.free; loaded = true; loadErr = ''
        } catch (e) { loadErr = e?.message ?? String(e) }
      } while (again)
      current = null
    })()
    return current
  }
  const pdmKey = $derived(pdms.map((d) => d.guid).join(','))
  $effect(() => { if (pdmKey) reload() })
  onMount(() => { const tick = () => { reload(); if (!stopped) timer = setTimeout(tick, 6000) }; timer = setTimeout(tick, 6000) })
  onDestroy(() => { stopped = true; clearTimeout(timer); poller.stop() })

  $effect(() => { if (!pads.some((p) => p.key === selKey)) { selKey = pads[0]?.key ?? ''; selBtn = 1 } })
  const pad = $derived(pads.find((p) => p.key === selKey) ?? null)
  const btn = $derived(pad ? (pad.kp.buttons.find((b) => b.number === selBtn) ?? pad.kp.buttons[0]) : null)
  $effect(() => {
    const g = pad?.pdm.guid
    if (!g) { signals = []; return }
    api.inputs(g, 'bool').then((v) => { if (g === pad?.pdm.guid) signals = (v ?? []).filter((x) => x.kind !== 'sys') }).catch(() => {})
  })

  /** Heartbeat of node N is CAN id 0x700+N. */
  function heard(node) {
    const id = 0x700 + node, st = poller.state
    const answering = (st.rates[id] ?? 0) > 0
    const t = st.lastSeen[id]
    return { answering, last: t ? new Date(t).toLocaleTimeString('en-GB') : (st.counts[id] ? 'earlier' : '') }
  }
  const retry = () => reload()
</script>

<Page wide>
  <PageHeader crumbs={[{ label: 'Hardware', href: '#/next/hardware' }, { label: 'Keypads' }]} title="Keypads"
    subtitle="Each button is an input you can use anywhere. Its LED mirrors any signal. A keypad is wired to a PDM." />
  {#if loadErr}<Banner tone="fault" title="Could not read the keypads">{loadErr}</Banner>{/if}
  {#if !live.connected && !pdms.length}
    <Empty title="No modules" text="Add a PDM or connect to the car first." />
  {:else}
    <div class="cols">
      <div class="col">
        <KeypadList {pads} {free} bind:selKey {heard} onchanged={reload} />
      </div>
      {#if pad && btn}
        <div class="col wide">
          <KeypadFace {pad} {heard} {signals} bind:selBtn onchanged={reload} onretry={retry} />
          <ButtonEditor {pad} {btn} {signals} onchanged={reload} />
        </div>
      {:else if loaded}
        <div class="col wide"><Empty title="No keypad selected" text="Add a keypad on the left, then map its buttons here." /></div>
      {/if}
    </div>
    <SdoExpert node={pad?.kp.id ?? 0} />
  {/if}
</Page>

<style>
  .cols { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(0, 2.4fr); gap: var(--space-5); align-items: start; }
  .col { display: flex; flex-direction: column; gap: var(--space-5); min-width: 0; }
  @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
</style>
