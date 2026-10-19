<script>
  // First run (board H13): connect, find the modules, name them, place them on the car map.
  // Steps 3 to 6 of the board (what the car has, questions, wiring list, apply and test) are the
  // Functions screens; "Next" goes there. Backed by telemetry, GET /api/adapters, POST /api/connect,
  // POST /api/devices/{id}/rename, /identify (Blink LED, firmware 5.6).
  import { Page, PageHeader, Card, Button, Banner, Chip, StateDot, Empty } from '../../ui/index.js'
  import { live, api, toast, mutate, moduleState, hex, blinkModule, modulesOf } from '../../lib/live.svelte.js'
  import { go, href } from '../../router.svelte.js'
  import { ui } from '../../shell/ui.svelte.js'
  import CarMap from '../car/parts/CarMap.svelte'
  import { layout } from '../car/parts/layout.svelte.js'
  import { fwText } from '../hardware/parts/ids.js'
  import { lacks, isUpstream } from '../hardware/parts/util.js'

  let { query } = $props()

  let back = $state(false) // user pressed Change: show step 1 even when connected
  let connecting = $state(false)
  let connErr = $state('')
  let names = $state({}) // guid → draft
  let nameErr = $state({})
  // the same layout the Car screen's map uses: a module with no position sits in the map's tray
  const placed = $derived(layout.pos)

  const mods = $derived(modulesOf(live.devices).sort((a, b) => a.baseId - b.baseId))
  const step = $derived(!live.connected || back ? 1 : 2)
  const answering = $derived(mods.filter((d) => d.connected).length)
  const rate = $derived(live.devices.find((d) => d.bitrate)?.bitrate)
  const unplaced = $derived(mods.filter((d) => !placed[d.guid]))
  const STEPS = ['Connect', 'Find and name', 'Add functions']

  async function usbConnect() {
    connecting = true; connErr = ''
    try {
      const r = await api.connect('USB', '', '500K')
      if (!r?.ok) { connErr = r?.error ?? 'USB did not open. Check the cable carries data and the module has 12 V.'; return }
      back = false
      toast('Connected through USB', 'info', 2500)
    } catch (e) { connErr = e.message } finally { connecting = false }
  }

  async function commitName(d) {
    const v = (names[d.guid] ?? d.name).trim()
    nameErr[d.guid] = ''
    if (v === d.name) { delete names[d.guid]; return }
    if (!v) { nameErr[d.guid] = 'The name cannot be empty.'; return }
    if (live.devices.some((x) => x.guid !== d.guid && x.name.toLowerCase() === v.toLowerCase())) { nameErr[d.guid] = `Another module is called ${v}.`; return }
    const r = await mutate(() => api.rename(d.guid, v), `Renamed to ${v}`)
    if (r) delete names[d.guid]
    else nameErr[d.guid] = 'Could not rename. See the message.'
  }
</script>

<Page>
  <PageHeader title={step === 1 ? 'Connect to the car' : `${mods.length} module${mods.length === 1 ? '' : 's'} found. Name them.`}
    subtitle={step === 1 ? 'Plug in, pick how this PC reaches the modules, and connect.' : 'Give each module a name you will recognise, and drag it to where it sits in the car. You can change this later.'}>
    {#snippet tag()}<span class="muted">Step {step} of {STEPS.length}</span>{/snippet}
    {#snippet actions()}<Button variant="ghost" href={href('car')}>Skip to the app</Button>{/snippet}
  </PageHeader>

  <ol class="steps" aria-label="Steps">
    {#each STEPS as s, i (s)}
      <li aria-current={i + 1 === step ? 'step' : undefined} class:on={i + 1 === step} class:done={i + 1 < step}><span class="n" aria-hidden="true">{i + 1 < step ? '✓' : i + 1}</span>{s}</li>
    {/each}
  </ol>

  {#if step === 1}
    <Card title="How do you reach the car?">
      <p class="muted">Not connected, nothing can be read from or written to the car. The simplest way is a USB cable straight to any dingoPDM or CANBoard: dingoConfig talks to the whole bus through it.</p>
      <div class="row">
        <Button variant="primary" size="lg" onclick={usbConnect} busy={connecting} data-testid="usb-connect">Connect through USB</Button>
        <Button size="lg" onclick={() => (ui.panel = 'connect')} data-testid="other-adapters">Other adapters: WiFi, PCAN, serial, simulator…</Button>
        {#if live.connected}<Button size="lg" onclick={() => (back = false)}>Keep the current connection</Button>{/if}
      </div>
      {#if connErr}<Banner tone="fault" title="Could not connect">{connErr}</Banner>{/if}
      {#if live.connected}<Banner tone="ok" title={`Already connected through ${live.adapter ?? 'an adapter'}`}>{answering} of {mods.length} modules answering{rate ? ` at ${rate}` : ''}.</Banner>{/if}
    </Card>
  {:else}
    <div class="two">
      <div class="left">
        <div class="conn" role="status">
          <StateDot tone={answering === mods.length && mods.length ? 'on' : 'warn'} />
          <strong>Connected through {live.adapter ?? 'an adapter'}</strong>
          <span class="muted">{rate ?? 'speed unknown'} · {answering} of {mods.length} answering</span>
          <span class="grow"></span>
          <Button variant="ghost" onclick={() => (back = true)} data-testid="change-conn">Change</Button>
        </div>

        {#if !mods.length}
          <Empty title="No modules in the project yet" text="Find the modules on the bus, or add one by hand.">
            {#snippet actions()}<Button variant="primary" onclick={() => (ui.addModule = true)}>Find modules</Button>{/snippet}
          </Empty>
        {:else}
          <div class="list" role="list" aria-label="Modules">
            <div class="lh muted" aria-hidden="true"><span></span><span>Module</span><span>Name</span><span>Where</span><span>Identify</span></div>
            {#each mods as d (d.guid)}
              {@const st = moduleState(d)} {@const oldFw = !isUpstream(d) && lacks(d, [5, 6, 0])}
              <div class="mrow" role="listitem" data-testid={'first-' + d.name}>
                <StateDot tone={st.key} shape={st.shape} label={st.word} />
                <span class="ty"><strong>{d.type}</strong><span class="mono muted">{hex(d.baseId)} · {fwText(d)}</span></span>
                <label class="nm">
                  <span class="sr-only">Name of {d.type} at {hex(d.baseId)}</span>
                  <input class="nx-input" type="text" value={names[d.guid] ?? d.name} aria-invalid={nameErr[d.guid] ? 'true' : undefined}
                    oninput={(e) => (names[d.guid] = e.currentTarget.value)} onchange={() => commitName(d)} onkeydown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
                  {#if nameErr[d.guid]}<span class="err" role="alert">■ {nameErr[d.guid]}</span>{/if}
                </label>
                <span class={placed[d.guid] ? '' : 'muted'}>{placed[d.guid] ? 'placed ✓' : 'not placed'}</span>
                <Button size="sm" disabled={oldFw || !d.connected || !live.connected} title={oldFw ? `Needs firmware 5.6: ${d.name} runs ${fwText(d)}` : isUpstream(d) ? 'Blink its LEDs for 10 s (upstream dingoFW: only if its build has identify)' : 'Blink its LEDs for 10 s'} onclick={() => blinkModule(d)} aria-label={`Blink the LED of ${d.name}`}>Blink LED</Button>
              </div>
            {/each}
          </div>
          {#if unplaced.length}<p class="muted" role="status">Not placed yet: {unplaced.map((d) => d.name).join(', ')}. Drag {unplaced.length === 1 ? 'it' : 'them'} from the tray onto the car.</p>{/if}
          <p class="muted">Blink LED needs firmware 5.6. A CANBoard has no LED: it only answers.</p>
        {/if}

        <div class="row">
          <Button onclick={() => (ui.addModule = true)} data-testid="find-modules">Find modules</Button>
          <span class="grow"></span>
          <Button onclick={() => (back = true)}>Back</Button>
          <Button variant="primary" onclick={() => go('functions', 'add')} data-testid="first-next">Next: add the car's functions</Button>
        </div>
      </div>
      <div class="right">
        <CarMap devices={mods} />
      </div>
    </div>
  {/if}
</Page>

<style>
  .steps { display: flex; gap: var(--space-2); list-style: none; margin: 0; padding: 0; flex-wrap: wrap; }
  .steps li { display: flex; align-items: center; gap: var(--space-2); min-height: 40px; padding: 0 14px; border-radius: 999px; color: var(--color-text-muted); font-weight: 600; }
  .steps li.on { background: var(--color-raised); color: var(--color-text); }
  .steps li.done { color: var(--color-text); }
  .n { width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: var(--text-xs); background: var(--color-raised); color: var(--color-text-muted); }
  .steps li.on .n { background: var(--color-accent); color: var(--color-on-accent); }
  .steps li.done .n { background: var(--color-ok); color: var(--color-bg); }
  .row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .grow { flex: 1 1 auto; }
  .two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 520px); gap: var(--space-5); align-items: start; }
  .left { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .conn { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--color-surface); border: 1px solid var(--color-line); flex-wrap: wrap; }
  .list { display: flex; flex-direction: column; gap: var(--space-2); }
  .lh, .mrow { display: grid; grid-template-columns: 124px 140px minmax(140px, 1fr) 84px 112px; gap: var(--space-3); align-items: center; }
  .lh { padding: 0 var(--space-4); font-size: var(--text-xs); }
  .mrow { min-height: 64px; padding: var(--space-2) var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface); }
  .ty { display: flex; flex-direction: column; min-width: 0; }
  .ty .mono { font-size: var(--text-xs); }
  .nm { display: flex; flex-direction: column; gap: 2px; }
  .err { color: var(--color-fault); font-size: var(--text-xs); font-weight: 600; }
  @media (max-width: 1500px) { .two { grid-template-columns: 1fr; } .lh { display: none; } .mrow { grid-template-columns: 1fr 1fr; } }
</style>
