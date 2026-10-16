<script>
  // Add module dialog (board H16): Find on CAN · From USB · By hand.
  // Backed by GET /api/identify, POST /api/usb/identify, POST /api/devices, POST /api/devices/{id}/add-like.
  import { untrack } from 'svelte'
  import { Dialog, Tabs, Button, Banner, Field, Checkbox, Switch, Chip, StateDot, Select } from '../ui/index.js'
  import { live, api, toast, defs, mutate, hex } from '../lib/live.svelte.js'
  import { ui } from './ui.svelte.js'
  import { addLike } from './parts/addmodule.svelte.js'
  import { parseId, hexId, clashOf, freeBases, hitsObd, spanText, nextName, fwText, busIds, busyIn } from '../screens/hardware/parts/ids.js'

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const devices = $derived(live.devices)
  const open = $derived(ui.addModule)

  let tab = $state('can')
  // Find on CAN
  let scanning = $state(false)
  let scanned = $state(false)
  let scanErr = $state('')
  let elapsed = $state(0)
  let found = $state([])
  let seen = $state(0)
  let off = $state({}) // baseId → true when the user unticked it
  let stopScan = false
  // From USB
  let usbBusy = $state(false)
  let usbDone = $state(false)
  let usbBase = $state(null)
  let usbErr = $state('')
  let usbType = $state('pdm:0')
  let usbKnown = $state(false)
  let usbName = $state('')
  let usbRead = $state(true)
  // By hand
  let typeSel = $state('pdm:0')
  let name = $state('')
  let baseText = $state('')
  let reserve = $state(true)
  let nameTouched = false
  let busy = $state(false)

  const kindOf = (v) => (/canboard/i.test(v) ? 'canboard' : 'pdm')
  const typeItems = $derived([
    ...defs.pdms.map((p) => ({ value: `pdm:${p.pdmType}`, label: p.typeName, desc: `${p.numOutputs} switched outputs` })),
    ...defs.canboards.map((c) => ({ value: 'canboard', label: c.typeName, desc: `${c.numDigitalInputs} digital + ${c.numAnalogInputs} analog inputs, ${c.numOutputs} outputs` })),
  ])

  // ---- open / close -------------------------------------------------------
  let wasOpen = false
  $effect(() => {
    const o = open
    untrack(() => onOpenChange(o))
  })
  function onOpenChange(open) {
    if (open && !wasOpen) {
      scanned = false; scanning = false; scanErr = ''; found = []; seen = 0; off = {}
      usbDone = false; usbErr = ''; usbBase = null
      reserve = true; nameTouched = false
      if (addLike.guid) {
        const src = live.devices.find((d) => d.guid === addLike.guid)
        tab = 'hand'
        typeSel = src ? (/canboard/i.test(src.type) ? 'canboard' : (defs.pdms.find((p) => p.typeName === src.type)?.pdmType != null ? `pdm:${defs.pdms.find((p) => p.typeName === src.type).pdmType}` : 'pdm:0')) : 'pdm:0'
        name = nextName(live.devices, kindOf(typeSel)); nameTouched = false
        baseText = ''
      } else { tab = 'can'; name = nextName(live.devices, 'pdm'); typeSel = 'pdm:0'; baseText = '' }
      onBus = new Set()
      busIds().then((b) => { onBus = b; if (!baseText) baseText = hexId(freeBases(live.devices, null, kindOf(typeSel), { reserve, busy: onBus })[0] ?? 0x700) })
      if (!addLike.guid && live.connected) scan()
    }
    if (!open && wasOpen) { stopScan = true; addLike.guid = null }
    wasOpen = open
  }

  function close() { ui.addModule = false }

  // ---- Find on CAN --------------------------------------------------------
  const normType = (t) => (t === 'blinkkeypad' ? 'blinkkeypad-PKP-2400' : t)
  async function scan() {
    if (scanning) return
    if (!live.connected) { scanErr = 'Not connected. Connect first, then scan.'; scanned = true; return }
    scanning = true; scanned = false; scanErr = ''; stopScan = false; found = []; elapsed = 0
    const t0 = Date.now()
    let last = -1, stable = 0
    try {
      while (Date.now() - t0 < 10_000 && !stopScan) {
        const r = await api.identify()
        const known = new Set(live.devices.map((d) => d.baseId))
        found = (r?.found ?? []).map((f) => ({ ...f, type: normType(f.type), already: live.devices.find((d) => d.baseId === f.baseId) ?? null, isNew: !known.has(f.baseId) }))
        seen = (r?.seen ?? []).length
        elapsed = Math.round((Date.now() - t0) / 1000)
        stable = found.length && found.length === last ? stable + 1 : 0
        last = found.length
        if (found.length && stable >= 3 && elapsed >= 5) break
        await sleep(1500)
      }
    } catch (e) { scanErr = e.message }
    elapsed = Math.round((Date.now() - t0) / 1000)
    scanning = false; scanned = true
  }
  const picked = $derived(found.filter((f) => f.isNew && !off[f.baseId]))
  const flooded = $derived(live.canRate > 2000)

  async function addFound() {
    if (!picked.length || busy) return
    busy = true
    let n = 0
    const names = [...live.devices]
    try {
      for (const f of picked) {
        const kind = f.type === 'canboard' ? 'canboard' : f.type.startsWith('pdm') ? 'pdm' : f.type
        const nm = kind === 'pdm' || kind === 'canboard' ? nextName(names, kind) : `${f.label} ${f.hex}`
        const type = f.label === 'dingoPDM-Max' ? 'pdm:1' : f.type
        if (await mutate(() => api.addDevice(type, nm, f.hex))) { n++; names.push({ name: nm }) }
      }
    } finally { busy = false }
    if (n) { toast(`Added ${n} module${n === 1 ? '' : 's'}`, 'info', 3000); close() }
  }

  // ---- From USB -----------------------------------------------------------
  async function lookUsb() {
    if (usbBusy) return
    usbBusy = true; usbErr = ''; usbDone = false; usbBase = null; usbKnown = false
    try {
      if (!live.connected) { usbErr = 'Not connected. Open the Connect panel and connect to the module first.'; return }
      const r = await api.usbIdentify()
      usbBase = r?.gatewayBaseId ?? null
      if (usbBase == null) { usbErr = 'No module answered on USB. Plug a dingoPDM or CANBoard into this PC with a data cable (some cables only charge), then look again.'; return }
      // The USB identify only returns the base ID. The bus scan can tell the board type.
      try {
        const id = await api.identify()
        const f = (id?.found ?? []).find((x) => x.baseId === usbBase)
        if (f) { usbType = f.label === 'dingoPDM-Max' ? 'pdm:1' : f.type === 'canboard' ? 'canboard' : 'pdm:0'; usbKnown = true }
      } catch { /* type stays a choice */ }
      usbName = nextName(live.devices, kindOf(usbType))
      usbDone = true
    } catch (e) { usbErr = 'Could not read the module on USB: ' + e.message + ' Unplug it, wait 5 seconds and plug it in again.' }
    finally { usbBusy = false }
  }
  const usbInProject = $derived(usbBase != null ? devices.find((d) => d.baseId === usbBase) : null)
  const usbClash = $derived(usbBase != null && !usbInProject ? clashOf(devices, null, kindOf(usbType), usbBase) : null)

  async function addUsb() {
    if (!usbDone || usbBase == null || busy || !usbName.trim() || usbInProject) return
    busy = true
    try {
      if (!(await mutate(() => api.addDevice(usbType, usbName.trim(), hexId(usbBase))))) return
      if (usbRead) {
        let d = null
        for (let i = 0; i < 20 && !d; i++) { d = live.devices.find((x) => x.baseId === usbBase); if (!d) await sleep(250) }
        if (d) { try { await api.action(d.guid, 'read') } catch (e) { toast('Added, but reading its settings failed: ' + e.message, 'error', 6000); close(); return } }
      }
      toast(`Added ${usbName.trim()}${usbRead ? ' and read its settings' : ''}`, 'info', 3000)
      close()
    } finally { busy = false }
  }

  // ---- By hand ------------------------------------------------------------
  const handKind = $derived(kindOf(typeSel))
  const base = $derived(parseId(baseText))
  const handClash = $derived(base != null ? clashOf(devices, null, handKind, base) : null)
  const handError = $derived.by(() => {
    if (!name.trim()) return 'Give the module a name.'
    if (devices.some((d) => d.name.toLowerCase() === name.trim().toLowerCase())) return `A module named ${name.trim()} is already in the project.`
    if (base == null) return 'Use a hex ID from 0x001 to 0x7FF, like 0x720.'
    if (handClash) return `${spanText(handKind, base)} overlaps ${handClash.name} (${spanText(handClash.type, handClash.baseId)}).`
    if (reserve && hitsObd(handKind, base)) return `${hexId(base)} is in the OBD-II range. Turn the reserve off to use it.`
    return ''
  })
  let onBus = $state(new Set())
  const handBusy = $derived(base != null ? busyIn(handKind, base, onBus) : null)
  const suggs = $derived(freeBases(devices, null, handKind, { reserve, count: 3, busy: onBus }))

  function pickType(v) {
    typeSel = v
    if (!nameTouched) name = nextName(devices, kindOf(v))
  }

  async function addHand() {
    if (handError || busy) return
    busy = true
    try {
      if (addLike.guid) {
        const r = await mutate(() => api.addLike(addLike.guid, name.trim(), hexId(base)))
        if (!r) return
      } else if (!(await mutate(() => api.addDevice(typeSel, name.trim(), hexId(base))))) return
      toast(`Added ${name.trim()} at ${hexId(base)}. It shows as Not found until it is on the bus.`, 'info', 4000)
      close()
    } finally { busy = false }
  }

  const primary = $derived(tab === 'can' ? { label: picked.length ? `Add ${picked.length} module${picked.length === 1 ? '' : 's'}` : 'Add selected', dis: !picked.length || scanning || busy, act: addFound }
    : tab === 'usb' ? { label: usbDone ? `Add ${usbName || 'module'}` : 'Add module', dis: !usbDone || !!usbInProject || !usbName.trim() || busy, act: addUsb }
    : { label: addLike.guid ? 'Add one like this' : 'Add module', dis: !!handError || busy, act: addHand })
</script>

<Dialog bind:open={() => open, (v) => { if (!v) close() }} title="Add module" description="Pick where the module comes from. You can name it and move it later." width={900}>
  <Tabs label="Where the module comes from" bind:value={tab}
    items={[{ value: 'can', label: 'Find on CAN' }, { value: 'usb', label: 'From USB' }, { value: 'hand', label: 'By hand' }]}>
    {#snippet panel(v)}
      {#if v === 'can'}
        <div class="stack">
          {#if !live.connected}
            <Banner tone="warn" title="Not connected">Scanning listens on the CAN bus, so connect first.
              {#snippet actions()}<Button onclick={() => { close(); ui.panel = 'connect' }}>Open Connect panel</Button>{/snippet}
            </Banner>
          {:else}
            <div class="row">
              <span role="status" class="grow">
                {#if scanning}Listening on the bus… {elapsed} s of 10 s. {found.length} answered so far.
                {:else if scanned && scanErr}{scanErr}
                {:else if scanned}Scan finished: {found.length} module{found.length === 1 ? '' : 's'} answered in {elapsed} s.{:else}Ready to scan.{/if}
              </span>
              <Button onclick={scan} busy={scanning} data-testid="scan-again">Scan again</Button>
            </div>
            {#if scanning}<div class="bar" aria-hidden="true"><span style="width: {Math.min(100, elapsed * 10)}%"></span></div>{/if}
            {#if flooded}
              <Banner tone="warn" title={`The bus is flooded: about ${live.canRate.toLocaleString()} frames a second`}>One or more devices send without being acknowledged, so module answers can get lost. A module missing below may only be drowned out. Unplug other CAN devices or switch off the loudest one, then scan again.</Banner>
            {/if}
            {#if scanned && !found.length && !scanErr}
              <Banner tone="fault" title="No module answered in 10 s">
                The bus was quiet, or the speed does not match. Try these in order:
                <ol class="steps">
                  <li>Check the modules have 12 V. A module that is asleep does not answer: switch the ignition on.</li>
                  <li>Check you are connected: the pill at the top says how many modules are live.</li>
                  <li>Set the speed to Auto-detect in the Connect panel.</li>
                  <li>Check CAN-H and CAN-L, and the 120 ohm terminators at both ends of the bus.</li>
                </ol>
                {#snippet actions()}<Button onclick={() => { close(); ui.panel = 'connect' }}>Open Connect panel</Button><Button onclick={() => (tab = 'hand')}>Add by hand instead</Button>{/snippet}
              </Banner>
            {/if}
            {#if found.length}
              <table class="nx-table" aria-label="Modules found">
                <thead><tr><th><span class="sr-only">Add</span></th><th>Type</th><th>Base ID</th><th>Firmware</th><th>In this project?</th></tr></thead>
                <tbody>
                  {#each found as f (f.baseId)}
                    <tr>
                      <td class="ck">
                        {#if f.isNew}<Checkbox label="" checked={!off[f.baseId]} onchange={(c) => (off = { ...off, [f.baseId]: !c })} aria-label={`Add ${f.label} at ${f.hex}`} />{:else}<span aria-hidden="true">–</span>{/if}
                      </td>
                      <td>{f.label}</td>
                      <td class="mono">{f.hex}</td>
                      <td class="muted" title="The scan does not report firmware yet (gap G8)">not reported</td>
                      <td>{#if f.isNew}<strong>New: not in the project</strong>{:else}<span class="muted">In project as {f.already?.name}</span>{/if}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
              {#if scanning}<p class="muted" role="status">Still listening…</p>{/if}
            {/if}
          {/if}
        </div>
      {:else if v === 'usb'}
        <div class="stack">
          <p class="muted">The module plugged into this PC with a USB cable. dingoConfig talks to it directly, so this works without a CAN bus.</p>
          <div class="row"><Button onclick={lookUsb} busy={usbBusy} data-testid="usb-look">{usbDone || usbErr ? 'Look again' : 'Look for the module on USB'}</Button></div>
          {#if usbErr}<Banner tone="fault" title="Nothing to add from USB">{usbErr}</Banner>{/if}
          {#if usbDone}
            <div class="found" role="status">
              <StateDot tone="on" />
              <div class="ft"><strong>Module on USB</strong><span class="muted mono">base ID {hexId(usbBase)} · firmware not reported</span></div>
              {#if usbInProject}<Chip tone="muted">In project as {usbInProject.name}</Chip>{:else}<Chip tone="ok" symbol="●">New: not in the project</Chip>{/if}
            </div>
            {#if usbInProject}
              <p class="muted">This module is already in the project, so there is nothing to add.</p>
            {:else}
              {#if !usbKnown}
                <Select label="Board type" items={typeItems.map((t) => ({ value: t.value, label: t.label }))} bind:value={usbType} />
                <p class="muted">The USB link only reports the base ID. Pick the board you plugged in.</p>
              {:else}
                <p class="muted">Board found on the bus: <strong>{typeItems.find((t) => t.value === usbType)?.label}</strong>.</p>
              {/if}
              <Field label="Name" bind:value={usbName} />
              {#if usbClash}<Banner tone="warn" title="CAN ID overlap">{hexId(usbBase)} overlaps {usbClash.name}. Fix one of them after adding.</Banner>{/if}
              <Checkbox label="Read its settings into the project" hint="So outputs and inputs match what is on the module." bind:checked={usbRead} />
            {/if}
          {/if}
        </div>
      {:else}
        <div class="stack">
          <p class="muted">{addLike.guid ? 'A new module of the same kind as the one you picked.' : 'For a module you have not wired up yet. It shows as Not found until it is on the bus.'}</p>
          <div class="cards" role="radiogroup" aria-label="Module type">
            {#each typeItems as t (t.value)}
              <label class="card" class:on={typeSel === t.value}>
                <input type="radio" class="ri" name="nx-type" value={t.value} checked={typeSel === t.value} onchange={() => pickType(t.value)} disabled={!!addLike.guid} />
                <span class="ring" aria-hidden="true"></span>
                <span class="ct"><strong>{t.label}</strong><span class="muted">{t.desc}</span></span>
              </label>
            {/each}
          </div>
          <div class="two">
            <Field label="Name" bind:value={name} oninput={() => (nameTouched = true)} error={handError && /name/i.test(handError) ? handError : ''} />
            <Field label="Base CAN ID" bind:value={baseText} mono error={handError && !/name/i.test(handError) ? handError : ''} />
          </div>
          {#if !handError && handBusy != null}<p class="warn" role="status">Something on the bus already sends {hexId(handBusy)}, inside {spanText(handKind, base)}. The module will look connected when it is not.</p>
          {:else if !handError}<p class="ok" role="status">✓ {spanText(handKind, base)} is free. No other module or bus traffic uses it.</p>{/if}
          <div class="row">
            <span class="muted">Free base IDs:</span>
            {#each suggs as b (b)}<Button size="sm" onclick={() => (baseText = hexId(b))}>{hexId(b)}</Button>{/each}
            {#if !suggs.length}<span class="muted">none left</span>{/if}
          </div>
          <Switch label="Keep the OBD-II range free" hint="Skips 0x7DF to 0x7EF so a scan tool can still talk to the car." bind:checked={reserve} />
        </div>
      {/if}
    {/snippet}
  </Tabs>

  {#snippet footer()}
    {#if tab === 'can' && found.length}<span class="muted sm">{picked.length} new selected · the others are already in the project</span>{/if}
    <Button onclick={close}>Cancel</Button>
    <Button variant="primary" disabled={primary.dis} busy={busy} onclick={primary.act} data-testid="add-primary">{primary.label}</Button>
  {/snippet}
</Dialog>

<style>
  .stack { display: flex; flex-direction: column; gap: var(--space-3); padding-top: var(--space-3); min-height: 320px; }
  .row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .grow { flex: 1 1 auto; font-weight: 600; }
  .bar { height: 4px; border-radius: 2px; background: var(--color-line); }
  .bar span { display: block; height: 4px; border-radius: 2px; background: var(--color-accent); transition: width var(--dur-mid) var(--ease); }
  .steps { margin: var(--space-2) 0 0; padding-left: var(--space-5); }
  .ck { width: 48px; }
  .found { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-raised); }
  .ft { flex: 1 1 auto; display: flex; flex-direction: column; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-2); }
  .ri { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
  .card { position: relative; display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); border: 2px solid var(--color-line-strong); border-radius: var(--radius-md); cursor: pointer; min-height: 60px; }
  .card.on { border-color: var(--color-accent); background: var(--color-raised); }
  .card:has(input:focus-visible) { outline: 3px solid var(--color-focus); outline-offset: 2px; }
  .ring { flex: none; width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--color-line-strong); }
  .card.on .ring { border: 5px solid var(--color-accent); }
  .ct { display: flex; flex-direction: column; }
  .ct .muted { font-size: var(--text-xs); }
  .two { display: grid; grid-template-columns: 1fr 200px; gap: var(--space-3); }
  .ok { color: var(--color-ok); font-weight: 600; }
  .warn { color: var(--color-warn); font-weight: 600; }
  .sm { font-size: var(--text-xs); margin-right: auto; align-self: center; }
</style>
