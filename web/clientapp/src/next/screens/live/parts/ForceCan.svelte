<script>
  // Force a CAN input on the real car: the app sends the input's source frame with the value you pick, so the
  // module's logic and outputs react as if the ECU / switch sent it. Only CAN-sourced values can be forced
  // without firmware support. The backend stops by itself after the hold, so a closed tab never leaves it running.
  import { untrack } from 'svelte'
  import { Card, Button, Banner, Dialog, Field } from '../../../ui/index.js'
  import { live, api, toast, isPdm, isCanboard, hex } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import { feed } from './feed.svelte.js'
  import { encodeForce, toRaw, fromRaw, parseHex, toHex } from './canforce.js'

  let { devs = [] } = $props()

  // ---- enabled CAN inputs of the modules shown ----
  let inputs = $state([])   // { key, guid, mod, inp }
  const guidKey = $derived(devs.filter((d) => isPdm(d) || isCanboard(d)).map((d) => d.guid).join(','))
  $effect(() => {
    const guids = guidKey ? guidKey.split(',') : []
    let alive = true
    untrack(() => Promise.all(guids.map(async (g) => {
      const fx = await api.functions(g).catch(() => null)
      const mod = live.devices.find((d) => d.guid === g)?.name ?? ''
      return (fx?.canInputs ?? []).filter((x) => x.enabled).map((inp) => ({ key: g + ':' + inp.number, guid: g, mod, inp }))
    })).then((l) => { if (alive) inputs = l.flat() }))
    return () => { alive = false }
  })
  const liveVal = (r) => { feed.tick; return (feed.byGuid[r.guid] ?? []).find((s) => s.kind === 'CAN input' && s.n === r.inp.number)?.value ?? '-' }

  const blocked = $derived(!live.connected ? 'Connect to the car first.' : !live.programmingAllowed ? 'The Sim adapter or a log replay cannot send to the car.' : '')

  // ---- confirm ----
  let ask = $state(null)          // the row to force
  let value = $state(0), hold = $state(10), step = $state(1)
  function openAsk(r) {
    ask = r
    const v = parseFloat(liveVal(r))
    value = Number.isFinite(v) ? v : 0
    step = r.inp.bitLength === 1 ? 1 : Math.max(Number(r.inp.factor) || 1, 1)
  }
  const holdOk = $derived(Number.isInteger(+hold) && +hold >= 1 && +hold <= 30)

  // ---- forcing ----
  let on = $state(null)            // { r, value, base, left }
  let busy = $state(false)
  let poll
  async function send(r, v, base) {
    const data = encodeForce(r.inp, v, base)
    const res = await api.canForce({ Id: r.inp.id, Ide: !!r.inp.ide, Data: toHex(data), PeriodMs: 50, HoldSec: +hold })
    on = { r, value: fromRaw(r.inp, toRaw(r.inp, v)), base, left: Math.ceil((res?.untilMs ?? hold * 1000) / 1000) }
  }
  async function start() {
    const r = ask
    busy = true
    try {
      // other signals in the same frame keep the bits last seen on the bus
      const seen = ((await api.canlog().catch(() => [])) ?? []).find((m) => m.id === r.inp.id && !!m.ide === !!r.inp.ide)
      await send(r, value, seen ? parseHex(seen.data) : [])
      ask = null
      clearInterval(poll)
      poll = setInterval(watch, 500)
    } catch (e) { toast(e?.message ?? String(e), 'error', 7000) } finally { busy = false }
  }
  async function watch() {
    const s = await api.canForceStatus().catch(() => null)
    if (!on) return
    if (!s?.active) { clearInterval(poll); toast(`Stopped forcing ${on.r.inp.name}.`, 'info', 3000); on = null; return }
    on.left = Math.ceil(s.remainingMs / 1000)
  }
  async function nudge(d) {
    if (!on || busy) return
    busy = true
    try { await send(on.r, on.value + d, on.base) } catch (e) { toast(e?.message ?? String(e), 'error', 7000) } finally { busy = false }
  }
  async function stop() {
    clearInterval(poll)
    on = null
    try { await api.canForceStop() } catch (e) { toast(e?.message ?? String(e), 'error', 7000) }
  }
  // leaving the page stops it at once (the hold would stop it anyway)
  $effect(() => () => { clearInterval(poll); if (on) api.canForceStop().catch(() => {}) })
</script>

<Card title="Force a CAN input" subtitle="test wiring and logic on the real car" data-testid="force-card">
  {#if on}
    <Banner tone="fault" title={`FORCED: ${on.r.inp.name} on ${on.r.mod}`} data-testid="forced">
      The app is sending {hex(on.r.inp.id)} with <strong class="mono" data-testid="forced-value">{on.value}</strong>. Stops by itself in {on.left} s.
      {#snippet actions()}
        <Button size="sm" onclick={() => nudge(-step)} disabled={busy} aria-label="Step down">−</Button>
        <Button size="sm" onclick={() => nudge(+step)} disabled={busy} aria-label="Step up">+</Button>
        <Button size="sm" variant="danger" onclick={stop} data-testid="force-stop">Stop forcing</Button>
      {/snippet}
    </Banner>
  {/if}
  <p class="muted small">Only values that come in over CAN can be forced: the app sends their frame. Pins and module logic cannot be forced without firmware support. To switch an output by hand, use the bench test on the output's page (<a href={href('hardware', 'outputs')}>every output</a>).</p>
  {#if blocked}<p class="muted" data-testid="force-blocked">{blocked}</p>{/if}
  {#if !inputs.length}
    <p class="muted">No enabled CAN inputs on these modules.</p>
  {:else}
    <div class="tw"><table class="nx-table">
      <thead><tr><th>CAN input</th><th>Module</th><th>Frame</th><th class="r">Now</th><th><span class="sr-only">Force</span></th></tr></thead>
      <tbody>
        {#each inputs as r (r.key)}
          <tr data-testid="force-row">
            <td>{r.inp.name}</td><td>{r.mod}</td><td class="mono">{hex(r.inp.id)}{r.inp.ide ? ' ext' : ''}</td><td class="r mono">{liveVal(r)}</td>
            <td class="r"><Button size="sm" disabled={!!blocked || !!on} title={blocked || (on ? 'Stop the value being forced first.' : '')} onclick={() => openAsk(r)}>Force…</Button></td>
          </tr>
        {/each}
      </tbody>
    </table></div>
  {/if}
</Card>

<Dialog open={!!ask} onclose={() => (ask = null)} title={`Force ${ask?.inp.name ?? ''}?`} data-testid="force-dialog">
  <Banner tone="warn" title="This drives the real car.">The module's logic and outputs react as if this value arrived: loads can switch on. If the real sender is also on the bus, both values fight and the input flickers.</Banner>
  <Field label="Value" type="number" bind:value step="any" data-testid="force-value" />
  <Field label="Step for − and +" type="number" bind:value={step} step="any" />
  <Field label="Stop by itself after" type="number" bind:value={hold} min="1" max="30" unit="s" error={holdOk ? '' : 'Use 1 to 30 seconds.'} />
  {#snippet footer()}
    <Button onclick={() => (ask = null)}>Cancel</Button>
    <Button variant="test" busy={busy} disabled={!holdOk || !!blocked} onclick={start} data-testid="force-confirm">Force it</Button>
  {/snippet}
</Dialog>

<style>
  .tw { max-width: 100%; overflow-x: auto; }
  .r { text-align: right; }
  .small { font-size: var(--text-xs); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
