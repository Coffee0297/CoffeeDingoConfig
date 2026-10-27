<script>
  import { untrack } from 'svelte'
  // Ignition modes + start button (firmware 5.6, Ignition block, param base 0x1E00, one per module).
  // The main module reads the switch / button and runs the state machine; the others follow its state frame.
  // Backed by GET /devices/{id}/functions (ignition), /inputs?type=bool and POST /function/ignition/1.
  import { Page, PageHeader, Banner, Button, Card, FwBadge, Select, Checkbox, Stepper, Chip, Field } from '../../ui/index.js'
  import { href, route } from '../../router.svelte.js'
  import { live, api, toast, project, isCanboard } from '../../lib/live.svelte.js'
  import { olderThan, parseVersion, lacks, isUpstream } from '../hardware/parts/util.js'
  import { remoteItems } from '../../lib/remote.js'
  import SignalRule from './parts/SignalRule.svelte'
  import { decodeRule, compileRule, ruleSet } from './parts/signalRule.js'
  import { ignitionBlocksHref, ignitionToLua } from './parts/ignitionSelf.js'
  import { ignitionMain, hasSync, resolveSync, statusWords, DEFAULT_SYNC_ID, hasStatusId, resolveStatus, statusSlot } from './parts/ignition.js'
  import MakeMain from './parts/MakeMain.svelte'

  const MODES = [
    { value: 0, name: 'Ignition switch + start button', what: 'A switch (or key with only ON) powers the ignition. The button only cranks, and only while the ignition is on.' },
    { value: 1, name: 'Start button only', what: 'One button does both. Pressed alone it turns the ignition on or off; with the clutch or brake held it also cranks.' },
    { value: 2, name: 'Key switch', what: 'The key holds ON; START is a spring-back position that cranks. Everything in one switch.' },
  ]
  const RULES = {
    0: [
      ['Ignition switch on', 'Ignition on: ECU power, accessories, dash. Ready to start.'],
      ['Switch on · crank allowed + press', 'Cranks, stops when the engine runs or after the max crank time.'],
      ['Engine running', 'A press does nothing: the button never stops the engine in this mode.'],
      ['Ignition switch off', 'Engine off; the dash stays on for the dash hold time.'],
    ],
    1: [
      ['Press, engine off', 'Ignition on. Press again to turn it off.'],
      ['Crank allowed held + press', 'Cranks, stops when the engine runs or after the max crank time. A press while cranking stops it.'],
      ['Press while running', 'Turns everything off.'],
    ],
    2: [
      ['Key at ON', 'Ignition on: ECU power, accessories, dash.'],
      ['Key at START', 'Cranks while held, stops when the engine runs or after the max crank time.'],
      ['Key off', 'Engine off; the dash stays on for the dash hold time.'],
    ],
  }
  const STATE_WORD = { off: 'Off', on: 'On', cranking: 'Cranking', running: 'Running' }

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  const known = $derived(mods.filter((d) => parseVersion(d.version)))
  const capable = $derived(mods.filter((d) => !lacks(d, [5, 6, 0], 0x1E00)))
  const ready = $derived(capable.length > 0)
  const oldText = $derived([...new Set(known.filter((d) => olderThan(d.version, [5, 6, 0])).map((d) => d.version.replace(/^v/, '')))].join(', '))
  // the module's own state-frame id (fork: base + 30, CANBoard + 14; upstream dingoFW: + 32, PT-DPDM + 33)
  const stateIdOf = (d) => d.ignition?.stateId ?? d.baseId + (isCanboard(d) ? 14 : 30)

  // ---- the setup, seeded from the module that is main today (or the first PDM) ----
  let mainGuid = $state(''), f = $state(null), follow = $state(true), busy = $state(false), err = $state('')
  let funcsOf = $state({}), boolsOf = $state({}), numsOf = $state({}), fullOf = {}, vmapOf = {}
  // 5.7 status frame id per module (sub 23): { fixed, val }; not fixed = its slot
  let stIds = $state({})
  // the four signals, each a rule: [NOT] signal [is above N] [OR / AND …] (parts/signalRule.js)
  const FIELDS = { ignitionInput: 'Switch', startInput: 'Start', crankAllowInput: 'Crank OK', runningInput: 'Running' }
  let rules = $state({})
  const word = (v) => v.name + (v.prop && v.prop !== 'Value' && v.prop !== 'State' ? ' · ' + v.prop : '')
  async function load(d) {
    try {
      const [fn, vars, inUse] = await Promise.all([api.functions(d.guid), api.inputs(d.guid), fetch(`/api/devices/${d.guid}/inputs?inUse=true`).then((r) => r.json())])
      funcsOf[d.guid] = fn?.ignition ?? null
      const sid = fn?.ignition?.statusId ?? 0
      stIds[d.guid] ??= { fixed: sid > 0, val: sid > 0 ? '0x' + sid.toString(16).toUpperCase() : '' }   // Save reloads the main: keep an edit
      fullOf[d.guid] = fn; vmapOf[d.guid] = vars ?? []   // the whole var map: rules are read back from any slot
      const usable = (inUse ?? []).filter((v) => v.index > 0 && v.kind !== 'ignition' && !(v.name ?? '').startsWith('Ign '))
      boolsOf[d.guid] = usable.filter((v) => v.type === 'bool').map((v) => ({ value: String(v.index), label: word(v) }))
      numsOf[d.guid] = usable.filter((v) => v.type !== 'bool').map((v) => ({ value: String(v.index), label: word(v) }))
    } catch { /* offline module: no list */ }
  }
  let seeded = false
  $effect(() => {
    if (seeded || !capable.length) return
    seeded = true
    Promise.all(capable.map(load)).then(() => {
      const main = capable.find((d) => funcsOf[d.guid]?.enabled && [0, 2].includes(funcsOf[d.guid]?.role)) ?? capable.find((d) => !isCanboard(d)) ?? capable[0]
      pick(main.guid)
    })
  })
  function pick(guid) {
    mainGuid = guid
    const g = funcsOf[guid] ?? {}
    f = { mode: g.mode ?? 0, maxCrankS: (g.maxCrankMs ?? 5000) / 1000, crankWhileHeld: g.crankWhileHeld ?? true, dashHoldS: (g.dashHoldMs ?? 0) / 1000,
      // firmware 5.7 (hasSync): role 0 main / 2 standalone, the sync id (absolute hex, or an offset from the main's base)
      role: g.role === 2 ? 2 : 0, syncMode: g.syncMode ?? 0,
      syncVal: (g.syncMode ?? 0) === 1 ? String(g.mainStateId ?? 0) : '0x' + (g.mainStateId || DEFAULT_SYNC_ID).toString(16).toUpperCase(),
      stopInput: String(g.stopInput ?? 0), doorInput: String(g.doorInput ?? 0), doorOnS: (g.doorOnMs ?? 60000) / 1000,
      dashOffS: (g.dashOffDelayMs ?? 0) / 1000, sleepMin: (g.sleepDelayMs ?? 0) / 60000,
      btnExt: !!g.buttonExtended, btnId: '0x' + (g.buttonId ?? 0).toString(16).toUpperCase(), btnByte: g.buttonByte ?? 0, btnMask: g.buttonMask ?? 0, btnTimeoutS: (g.buttonTimeoutMs ?? 1000) / 1000 }
    rules = Object.fromEntries(Object.keys(FIELDS).map((k) => [k, decodeRule(g[k] ?? 0, fullOf[guid], vmapOf[guid] ?? [])]))
  }
  const main = $derived(mods.find((d) => d.guid === mainGuid) ?? null)
  // on/off signals on other modules and ECUs; Save links the picked one to a CAN input on the main module
  let remote = $state([]), remoteNum = $state([])
  $effect(() => {
    const g = mainGuid
    if (!g) return
    let alive = true
    untrack(() => Promise.all([remoteItems(g, 'bool'), remoteItems(g, 'num')])).then(([b, n]) => { if (alive) { remote = b; remoteNum = n } })   // untracked: reads the polled device list
    return () => { alive = false }
  })
  const items = $derived([{ value: '0', label: '— not set' }, ...(boolsOf[mainGuid] ?? []), ...remote])
  const numItems = $derived([...(numsOf[mainGuid] ?? []), ...remoteNum])
  const followers = $derived(capable.filter((d) => d.guid !== mainGuid))
  const isOn = $derived(!!funcsOf[mainGuid]?.enabled && [0, 2].includes(funcsOf[mainGuid]?.role))
  // firmware 5.7 ignition parity on the main module
  const syncFw = $derived(!!main && hasSync(main))
  const sync = $derived(syncFw && f ? resolveSync(main, f.syncMode, Number(f.syncVal), mods) : null)
  const following = $derived(follow && f?.role !== 2)
  const syncBody = () => ({ mainStateId: Number(f.syncVal), syncMode: f.syncMode })
  // status frame ids: the main and (when they follow) the followers whose firmware has sub 23
  const statusMods = $derived(syncFw && f ? [main, ...(following ? followers : [])].filter((d) => hasStatusId(d) && stIds[d.guid]) : [])
  const statusOf = (d) => (stIds[d.guid]?.fixed ? Number(stIds[d.guid].val) : 0)
  const edited = $derived(mods.map((d) => (stIds[d.guid] && d.ignition ? { ...d, ignition: { ...d.ignition, statusId: statusOf(d) || null } } : d)))
  const statusRes = $derived(Object.fromEntries(statusMods.filter((d) => stIds[d.guid].fixed)
    .map((d) => [d.guid, resolveStatus(d, statusOf(d), edited, f.role === 2 ? null : sync?.id ?? null)])))
  const localItems = $derived([{ value: '0', label: '— not set' }, ...(boolsOf[mainGuid] ?? [])])   // stop / door: the main's own signals
  function problem() {
    if (!f) return 'Pick the main module first.'
    if (f.mode !== 1 && !ruleSet(rules.ignitionInput)) return f.mode === 2 ? 'Pick the key ON signal.' : 'Pick the ignition switch.'
    if (!ruleSet(rules.startInput)) return f.mode === 2 ? 'Pick the key START signal.' : 'Pick the start button.'
    if (!(f.maxCrankS >= 0.5 && f.maxCrankS <= 30)) return 'Max crank time must be 0.5 to 30 s.'
    if (!(f.dashHoldS >= 0 && f.dashHoldS <= 60)) return 'Dash hold must be 0 to 60 s.'
    if (!syncFw) return ''
    if (f.role === 0 && sync?.error) return sync.error
    const bad = Object.values(statusRes).find((r) => r.error)
    if (bad) return bad.error
    if (f.btnMask) {
      const id = Number(f.btnId)
      if (!Number.isInteger(id) || id < 0 || id > (f.btnExt ? 0x1FFFFFFF : 0x7FF)) return `The start button's CAN id must be 0 to ${f.btnExt ? '0x1FFFFFFF' : '0x7FF'}.`
      if (!(Number.isInteger(+f.btnMask) && f.btnMask >= 1 && f.btnMask <= 255)) return 'The start button mask must be 1 to 255.'
    }
    if (!(f.doorOnS >= 1 && f.doorOnS <= 3600)) return 'Door on-time must be 1 to 3600 s.'
    if (!(f.sleepMin >= 0 && f.sleepMin <= 60)) return 'Sleep delay must be 0 to 60 min.'
    return ''
  }
  async function save() {
    err = problem()
    if (err) return
    busy = true
    // each rule becomes one signal: a picked one as is, or helper blocks for NOT / OR / AND / a number test
    const sig = {}
    try { for (const [k, label] of Object.entries(FIELDS)) sig[k] = await compileRule(mainGuid, label, f.mode === 1 && k === 'ignitionInput' ? null : rules[k]) }
    catch (e) { err = e?.message ?? String(e); busy = false; return }
    await load(main)
    const failed = []
    const put = async (d, body) => { try { const r = await api.setFunction(d.guid, 'ignition', 1, body); funcsOf[d.guid] = { ...(funcsOf[d.guid] ?? {}), ...body }; return r } catch (e) { failed.push(`${d.name}: ${e?.message ?? e}`) } }
    await put(main, { enabled: true, role: 0, mode: f.mode, ignitionInput: sig.ignitionInput, startInput: sig.startInput, crankAllowInput: sig.crankAllowInput,
      runningInput: sig.runningInput, maxCrankMs: Math.round(f.maxCrankS * 1000), crankWhileHeld: f.crankWhileHeld, dashHoldMs: Math.round(f.dashHoldS * 1000), mainStateId: 0,
      ...(syncFw ? { role: f.role, ...syncBody(), syncBase: 0, stopInput: +f.stopInput, doorInput: +f.doorInput, doorOnMs: Math.round(f.doorOnS * 1000),
        dashOffDelayMs: Math.round(f.dashOffS * 1000), sleepDelayMs: Math.round(f.sleepMin * 60000), buttonExtended: f.btnExt, buttonId: f.btnMask ? Number(f.btnId) : 0,
        buttonByte: f.btnByte, buttonMask: +f.btnMask, buttonTimeoutMs: Math.round(f.btnTimeoutS * 1000), ...(hasStatusId(main) ? { statusId: statusOf(main) } : {}) } : {}) })
    for (const d of followers) {
      // 5.7: a follower listens to the main's sync id (offset mode: + the main's base); older firmware to its state frame
      if (following) await put(d, { enabled: true, role: 1, ...(syncFw && hasSync(d) ? { ...syncBody(), syncBase: f.syncMode === 1 ? main.baseId : 0 } : { mainStateId: stateIdOf(main) }),
        ...(syncFw && hasStatusId(d) ? { statusId: statusOf(d) } : {}) })
      else if (funcsOf[d.guid]?.enabled) await put(d, { enabled: false })
    }
    busy = false
    project.dirty = true
    if (failed.length) toast(`Ignition not saved everywhere: ${failed.join('; ')}`, 'error', 9000)
    else toast(`Ignition saved: ${main.name} is the main module${following && followers.length ? `, ${followers.length} follow it` : ''}. Apply to car to store it.`, 'info', 5000)
  }
  // 5.7: the main's sync setting to every module whose ignition role is follower (backend IgnitionMain.SyncFollowers: nothing else changes)
  async function syncAll() {
    err = sync?.error ?? ''
    if (err) return
    busy = true
    try {
      await api.setFunction(mainGuid, 'ignition', 1, syncBody())
      const x = await fetch(`/api/ignition/sync/${mainGuid}`, { method: 'POST' })
      const r = await x.json().catch(() => ({}))
      if (!x.ok) throw new Error(r.error ?? `HTTP ${x.status}`)
      await Promise.all(capable.map(load))
      project.dirty = true
      toast((r.changed.length ? `Sync setting copied to ${r.changed.join(', ')}. Apply to car to store it.` : 'No module is a follower: nothing copied.')
        + (r.skipped.length ? ` Not changed (firmware older than 5.7): ${r.skipped.join(', ')}.` : ''), 'info', 7000)
    } catch (e) { err = e?.message ?? String(e) }
    finally { busy = false }
  }
  // Build the signals yourself (the Ignition block stays): its blocks in the flow builder, or Lua that feeds it
  async function selfLua() {
    err = ''; busy = true
    try { location.hash = await ignitionToLua(mainGuid, rules, FIELDS, f.mode === 1 ? ['ignitionInput'] : []); project.dirty = true }
    catch (e) { err = e?.message ?? String(e) }
    finally { busy = false }
  }
  async function turnOff() {
    busy = true
    for (const d of capable) if (funcsOf[d.guid]?.enabled) { try { await api.setFunction(d.guid, 'ignition', 1, { enabled: false }); funcsOf[d.guid].enabled = false } catch (e) { toast(`${d.name}: ${e?.message ?? e}`, 'error', 8000) } }
    busy = false; project.dirty = true
  }
</script>

<Page>
  <PageHeader crumbs={[{ label: 'Power & ignition', href: href('power') }, { label: 'Ignition setup' }]} title="How is the car started?">
    {#snippet tag()}{#if !ready}<FwBadge version="5.6" />{:else if main?.ignition?.live}<Chip tone="on" symbol="●">{STATE_WORD[main.ignition.state] ?? main.ignition.state}</Chip>{/if}{/snippet}
  </PageHeader>

  {#if !ready}
    <Banner tone="warn" title="Needs firmware 5.6" data-testid="ignition-banner">
      {known.length ? `The modules run ${oldText} and have no Ignition block yet` : 'No module has reported firmware 5.6 yet'}, so nothing on this page can be saved. The power-down order and sleep settings already work. <a href={href('hardware', 'firmware')}>Update firmware</a>
    </Banner>
  {:else}
    <Banner tone={isOn ? 'ok' : 'info'} title={isOn ? `${main?.name} runs the ignition` : 'Ignition is not set up'} data-testid="ignition-banner">
      {isOn ? `State: ${main?.ignition?.live ? `${STATE_WORD[main.ignition.state] ?? main.ignition.state}${main.ignition.status ? ` · ${statusWords(main.ignition.status)}` : ''}` : `${main?.name} is not sending it`}. Outputs follow it through their roles.` : 'Pick the module the switch and button are wired to, then the signals. Outputs get their roles on the next page.'}
      {#if capable.length < mods.length} {mods.length - capable.length} module{mods.length - capable.length === 1 ? '' : 's'} without firmware 5.6 cannot follow it.{/if}
    </Banner>
  {/if}

  <Card title="Main module" subtitle="reads the switch and button, tells the others">
    <div class="two">
      <Select label="Main module" items={capable.map((d) => ({ value: d.guid, label: d.name }))} value={mainGuid} onchange={pick} disabled={!ready || busy} data-testid="ign-main" />
      <Checkbox label="The other modules follow it" hint={followers.length ? followers.map((d) => d.name + (d.ignition?.live && d.ignition.status ? ` (${statusWords(d.ignition.status)})` : d.ignition?.enabled ? ' (not heard)' : '')).join(', ') : 'no other module with firmware 5.6'} bind:checked={follow} disabled={!ready || busy || !followers.length || f?.role === 2} data-testid="ign-follow" />
    </div>
    {#if syncFw}
      <Select label="This module" items={[{ value: '0', label: 'Main: runs the ignition and tells the others' }, { value: '2', label: 'Standalone: runs the ignition, tells nobody' }]}
        value={String(f?.role ?? 0)} onchange={(v) => f && (f.role = +v)} disabled={busy} data-testid="ign-role" />
    {/if}
    {#if follow && followers.some(isUpstream)}<p class="muted">If the main module goes quiet, a follower on upstream dingoFW keeps Ignition, Accessory, Running and Dash, drops Cranking after 0.5 s, and its Link OK turns off.</p>{/if}
  </Card>

  <fieldset class="modes" disabled={!ready || busy} aria-label="How is the car started?">
    <legend class="sr-only">Start mode</legend>
    {#each MODES as m (m.value)}
      <label class="mode" class:sel={f?.mode === m.value}>
        <input type="radio" name="mode" value={m.value} checked={f?.mode === m.value} onchange={() => f && (f.mode = m.value)} />
        <span><strong>{m.name}</strong><span class="muted">{m.what}</span></span>
      </label>
    {/each}
  </fieldset>

  <Card title="Signals and limits">
    <div class="fields">
      {#if (f?.mode ?? 0) !== 1}
        <div class="field"><div><strong>{f?.mode === 2 ? 'Key at ON' : 'Ignition switch'}</strong><div class="muted hint">held on while the ignition should be on</div></div>
          {#if rules.ignitionInput}<SignalRule bind:rule={rules.ignitionInput} {items} {numItems} label={f?.mode === 2 ? 'Key at ON' : 'Ignition switch'} disabled={!ready || busy} testid="ign-switch" />{/if}</div>
      {/if}
      <div class="field"><div><strong>{f?.mode === 2 ? 'Key at START' : 'Start button'}</strong><div class="muted hint">a pin, a keypad button, or a bit in a CAN frame</div></div>
        {#if rules.startInput}<SignalRule bind:rule={rules.startInput} {items} {numItems} label={f?.mode === 2 ? 'Key at START' : 'Start button'} disabled={!ready || busy} testid="ign-start" />{/if}</div>
      <div class="field"><div><strong>Also required to crank</strong><div class="muted hint">clutch or brake pressed, neutral · optional</div></div>
        {#if rules.crankAllowInput}<SignalRule bind:rule={rules.crankAllowInput} {items} {numItems} label={'Also required to crank'} disabled={!ready || busy} testid="ign-allow" />{/if}</div>
      <div class="field"><div><strong>Engine running</strong><div class="muted hint">stops the starter; no cranking while it runs · optional. An ECU's RPM works too: pick it, then "is above" 300</div></div>
        {#if rules.runningInput}<SignalRule bind:rule={rules.runningInput} {items} {numItems} label={'Engine running'} disabled={!ready || busy} testid="ign-running" />{/if}</div>
      <div class="field"><div><strong>Max crank time</strong><div class="muted hint">then release and press again</div></div>
        <div class="stp"><Stepper label="Seconds of cranking at most" min={0.5} max={30} step={0.5} decimals={1} unit="s" bind:value={() => f?.maxCrankS ?? 5, (v) => f && (f.maxCrankS = +v)} disabled={!ready || busy} data-testid="ign-crank" /></div></div>
      <div class="field"><div><strong>Dash hold after the key is off</strong><div class="muted hint">outputs with the Dash role (gauges, radio, clock…) follow the ignition, but stay on this many seconds after it goes off. 0 = they go off with the ignition</div></div>
        <div class="stp"><Stepper label="Seconds the dash stays on" min={0} max={60} step={1} unit="s" bind:value={() => f?.dashHoldS ?? 0, (v) => f && (f.dashHoldS = +v)} disabled={!ready || busy} data-testid="ign-dash" /></div></div>
    </div>
  </Card>

  <Card title="What the switch and button do">
    <fieldset class="hold" disabled={!ready || busy || f?.mode === 2}>
      <legend class="nx-label">Cranking</legend>
      <label><input type="radio" name="hold" checked={f?.crankWhileHeld !== false} onchange={() => f && (f.crankWhileHeld = true)} /> Crank while the button is held</label>
      <label><input type="radio" name="hold" checked={f?.crankWhileHeld === false} onchange={() => f && (f.crankWhileHeld = false)} /> One press cranks until it runs</label>
    </fieldset>
    <ul class="rules" data-testid="ignition-rules">
      {#each RULES[f?.mode ?? 0] as [when, then] (when)}
        <li><strong>{when}</strong><span class="muted">{then}</span></li>
      {/each}
    </ul>
    <Checkbox checked label="No cranking with the engine running" hint="always on in the firmware: protects the starter if the button is pressed by mistake" disabled />
  </Card>

  {#snippet statusRows()}
    {#if statusMods.length}
      <div class="fields" data-testid="ign-status-ids">
        {#each statusMods as d (d.guid)}
          {@const r = statusRes[d.guid]}
          <div class="field"><div><strong>{d.name} status frame</strong><div class="muted hint">its ignition status (state, dash, sleep, link). Move it when the slot is another module's id</div></div>
            <div class="two">
              <Select label="{d.name} status id" items={[{ value: '0', label: `Default: 0x${statusSlot(d).toString(16).toUpperCase()}` }, { value: '1', label: 'A fixed CAN id' }]}
                value={stIds[d.guid].fixed ? '1' : '0'} onchange={(v) => (stIds[d.guid].fixed = v === '1')} disabled={busy} data-testid="ign-status-mode-{d.name}" />
              <Field label="{d.name} status CAN id (hex)" bind:value={stIds[d.guid].val} mono disabled={busy || !stIds[d.guid].fixed}
                error={r?.error ?? ''} hint={r?.warn ?? ''} data-testid="ign-status-id-{d.name}" />
            </div></div>
        {/each}
      </div>
    {/if}
  {/snippet}

  {#if syncFw && f}
    {#if f.role === 2 && statusMods.length}
      <Card title="Status frame" subtitle="the id this module sends its ignition status on">{@render statusRows()}</Card>
    {/if}
    {#if f.role === 0}
      <Card title="Sync frame" subtitle="the id the main module sends the ignition state on; every module of the car must use the same">
        <div class="two">
          <Select label="Id" items={[{ value: '0', label: 'A fixed CAN id' }, { value: '1', label: `An offset from ${main.name}'s base id` }]} value={String(f.syncMode)}
            onchange={(v) => { f.syncMode = +v; f.syncVal = +v === 1 ? '48' : '0x' + DEFAULT_SYNC_ID.toString(16).toUpperCase() }} disabled={busy} data-testid="ign-sync-mode" />
          <Field label={f.syncMode === 1 ? 'Offset' : 'CAN id (hex)'} bind:value={f.syncVal} mono disabled={busy}
            error={sync?.error ?? ''} hint={sync?.warn || (sync?.id != null ? `Sent on 0x${sync.id.toString(16).toUpperCase()}${f.syncMode === 0 && sync.id === DEFAULT_SYNC_ID ? ' (the default)' : ''}` : '')} data-testid="ign-sync-id" />
        </div>
        <div class="foot">
          <Button disabled={busy || !!sync?.error} onclick={syncAll} title="Writes the sync id and mode (and, for an offset, this module's base id) to every module whose ignition is a follower; nothing else is changed" data-testid="ign-sync-all">Use this sync setting on all followers</Button>
          <span class="muted hint">A follower on paleppp's dingoFW follows the same frame on the same id.</span>
        </div>
        {@render statusRows()}
      </Card>
    {/if}
    <Card title="More (firmware 5.7)" subtitle="stop input, CAN start button, dash power down, door, sleep">
      <div class="fields">
        <div class="field"><div><strong>Stop</strong><div class="muted hint">everything off while it is on (kill switch) · optional</div></div>
          <Select label="Stop signal" items={localItems} value={f.stopInput} onchange={(v) => (f.stopInput = v)} disabled={busy} data-testid="ign-stop" /></div>
        <div class="field"><div><strong>Start button from a CAN frame</strong><div class="muted hint">pressed while any masked bit is set; replaces the start button above. Mask 0 = off</div></div>
          <div class="two">
            <Field label="CAN id (hex)" bind:value={f.btnId} mono disabled={busy || !f.btnMask} data-testid="ign-btn-id" />
            <Checkbox label="Extended (29-bit) id" bind:checked={f.btnExt} disabled={busy || !f.btnMask} data-testid="ign-btn-ext" />
            <Stepper label="Byte" min={0} max={7} bind:value={f.btnByte} disabled={busy || !f.btnMask} data-testid="ign-btn-byte" />
            <Stepper label="Mask" min={0} max={255} bind:value={f.btnMask} disabled={busy} data-testid="ign-btn-mask" />
            <Stepper label="Released after no frame for" min={0} max={60} step={0.5} decimals={1} unit="s" bind:value={f.btnTimeoutS} disabled={busy || !f.btnMask} data-testid="ign-btn-timeout" />
          </div></div>
        <div class="field"><div><strong>Dash power down</strong><div class="muted hint">after the dash hold: the dash stays powered this long with Ignition · Dash Shutdown on (cannot be cancelled), then 2 s unpowered. 0 = none. For a shutdown frame: a CAN Message on Ignition · Dash Shutdown, mode Repeat</div></div>
          <div class="stp"><Stepper label="Seconds of dash power down" min={0} max={60} step={1} unit="s" bind:value={f.dashOffS} disabled={busy} data-testid="ign-dash-off" /></div></div>
        <div class="field"><div><strong>Door</strong><div class="muted hint">opening it powers the dash for the on-time with the ignition off · optional</div></div>
          <div class="two">
            <Select label="Door signal" items={localItems} value={f.doorInput} onchange={(v) => (f.doorInput = v)} disabled={busy} data-testid="ign-door" />
            <Stepper label="On-time" min={1} max={3600} step={10} unit="s" bind:value={f.doorOnS} disabled={busy} data-testid="ign-door-on" />
          </div></div>
        <div class="field"><div><strong>Sleep after the ignition is off</strong><div class="muted hint">ignition, door and dash off this long: every module sleeps together (outputs off). Put the switch, door or start input in the wake mask. 0 = off</div></div>
          <div class="stp"><Stepper label="Minutes to sleep" min={0} max={60} step={1} unit="min" bind:value={f.sleepMin} disabled={busy} data-testid="ign-sleep" /></div></div>
      </div>
    </Card>
  {:else}
    <MakeMain devices={live.devices} main={ignitionMain(live.devices)} initial={route.query.main ?? ''} onchange={(g) => Promise.all(capable.map(load)).then(() => g && pick(g))} />
  {/if}

  {#if err}<p class="err" role="alert">■ {err}</p>{/if}
  <div class="foot">
    <Button href={href('power')} data-testid="ignition-cancel">Cancel</Button>
    {#if ready && Object.values(funcsOf).some((g) => g?.enabled)}<Button variant="danger" disabled={busy} onclick={turnOff} data-testid="ignition-off">Turn ignition off</Button>{/if}
    <span class="grow"></span>
    {#if isOn}
      <Button href={ignitionBlocksHref(main)} title="The Ignition block and the blocks that feed it, in the flow builder" data-testid="ign-self-blocks">Build the signals myself: blocks</Button>
      {#if main && !isCanboard(main)}<Button disabled={busy} onclick={selfLua} title="Each signal from a Lua Out; a stub doing today's rules is added to the module's Lua" data-testid="ign-self-lua">…in Lua</Button>{/if}
    {/if}
    <Button disabled={!ready || busy} busy={busy} onclick={save} data-testid="ignition-save">Save</Button>
    <Button variant="primary" href={href('power', 'roles')} data-testid="ignition-next">Next: output roles</Button>
  </div>
</Page>

<style>
  .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-4); align-items: end; }
  .modes { border: 0; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-3); }
  .mode { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-4); border: 2px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); }
  .modes:disabled .mode { border-style: dashed; opacity: 0.85; }
  .mode.sel { border-color: var(--color-accent); background: var(--color-raised); }
  .mode span { display: flex; flex-direction: column; gap: 4px; }
  .mode input { margin-top: 4px; width: 20px; height: 20px; }
  .fields { display: flex; flex-direction: column; }
  .field { display: grid; grid-template-columns: minmax(200px, 1fr) minmax(260px, 1.6fr); gap: var(--space-4); align-items: center; padding: var(--space-2) 0; border-bottom: 1px solid var(--color-line); }
  .hint { font-size: var(--text-xs); }
  .stp :global(.nx-label) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }   /* the row already names it */
  .hold { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .rules { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--space-2); }
  .rules li { display: grid; grid-template-columns: minmax(180px, 0.6fr) minmax(0, 1.4fr); gap: var(--space-4); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-raised); }
  .err { color: var(--color-fault); font-weight: 600; margin: 0; }
  .foot { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .grow { flex: 1 1 auto; }
  @media (max-width: 640px) { .field, .rules li { grid-template-columns: 1fr; gap: var(--space-1); } }
</style>
