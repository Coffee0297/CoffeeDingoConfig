<script>
  // Guided setup for one template. Steps come from the template's fields: where it goes (outputs, relay),
  // what drives it (inputs from any module), settings, then check and apply. Nothing is written until Apply;
  // the preview shows what will be created. Apply / remove use apply.js, the same code the MCP tools run.
  import { get } from 'svelte/store'
  import { untrack } from 'svelte'
  import { Button, Banner, Checkbox, Field, Dialog, Select, Chip, Empty } from '../../../ui/index.js'
  import { live, api, project, toast, deviceDefs } from '../../../lib/live.svelte.js'
  import { go, href } from '../../../router.svelte.js'
  import { templateInstances, addCanInputFromDbc } from '../../../../lib/store.js'
  import { defaults, validate, previewTemplate, logicModule, shortfalls, freedBy, isInput, blank, OPS, shedCaps } from '../../../../lib/templates.js'
  import { isMod, numOut, loadOutputOptions, loadInputOptions, applyTemplate, remoteShortfalls, undoTemplate } from '../../../../lib/apply.js'
  import SearchPick from './SearchPick.svelte'
  import PreviewAside from './PreviewAside.svelte'
  import Drawings from './Drawings.svelte'
  import { buildMyself } from './buildMyself.js'

  let { tpl, editId = '', fromId = '' } = $props()

  const src = untrack(() => (editId || fromId ? get(templateInstances).find((i) => i.id === (editId || fromId)) : null))
  // No relay by default: a PDM output drives lamps, motors and pumps directly (it handles their kick-back). Only an
  // output the template itself names a relay (a relay-switched wiper, a starter relay) starts with one.
  const RELAY_WHY = "Not needed on a PDM output: it drives lamps, motors and pumps directly. Use one on a CANBoard output, or for a load above the output's rating. The drawing shows how to wire it."
  const relayDefaults = () => Object.fromEntries(tpl.fields.filter((f) => f.t === 'out').map((f) => [f.k, /relay/i.test(f.label ?? '')]))
  const init = () => {
    const s = { ...defaults(tpl), ...(src?.sel ?? {}) }
    if (src && !editId) for (const f of tpl.fields) if (f.t === 'out') s[f.k] = ''   // a copy needs its own outputs
    return s
  }
  let sel = $state(untrack(init)), relays = $state(untrack(() => ({ ...relayDefaults(), ...(src?.relays ?? {}) })))
  let name = $state(untrack(() => (src ? (editId ? src.name : src.name + ' copy') : tpl.name)))
  const editing = untrack(() => (editId ? src : null))
  let step = $state(0), maxStep = $state(0), busy = $state(false), result = $state(null), applyErr = $state('')
  let confirmTake = $state(false)

  const mods = $derived(live.devices.filter(isMod))
  const devOf = (g) => live.devices.find((d) => d.guid === g)

  // ---- the lists to pick from
  let outOpts = $state([]), funcs = $state({}), inOpts = $state({})
  async function loadOutputs() { const r = await loadOutputOptions(api, mods, get(deviceDefs)); outOpts = r.outOpts.map((o) => ({ ...o, search: `${o.search} o${o.number} out${o.number} output ${o.number}` })); funcs = r.funcs }
  const modKey = $derived(mods.map((d) => d.guid).join())
  $effect(() => { modKey; untrack(loadOutputs) })

  const lm = $derived(logicModule(tpl, sel))
  const logicGuid = $derived(lm.guid ?? null)
  const logic = $derived(devOf(logicGuid))
  // Inputs were picked against the previous logic module: its local indices mean nothing on another one.
  let lastLogic = untrack(() => (logicModule(tpl, sel).guid ?? null))
  let logicMoved = $state(false)
  $effect(() => {
    const g = logicGuid
    if (lastLogic && g && g !== lastLogic) {
      let cleared = false
      for (const f of tpl.fields) if (isInput(f) && !blank(sel[f.k])) { sel[f.k] = ''; cleared = true }
      logicMoved = cleared
    }
    if (g) lastLogic = g
  })
  const inKinds = $derived([...new Set(tpl.fields.filter(isInput).map((f) => f.t))])
  // once per logic module and kind, not once per telemetry push
  $effect(() => {
    const g = logicGuid, kinds = inKinds
    if (!g) return
    untrack(() => {
      const d = devOf(g); if (!d) return
      for (const k of kinds) loadInputOptions(api, d, live.devices, k).then((o) => { inOpts = { ...inOpts, [g + '|' + k]: o } }).catch(() => {})
    })
  })
  // ECU signals (DBC devices): Apply fills a CAN input on the logic module from the DBC record
  let ecuOpts = $state([])
  const ecuKey = $derived(live.devices.filter((d) => /dbc/i.test(d.type ?? '')).map((d) => d.guid).join())
  $effect(() => {
    if (!ecuKey) { ecuOpts = []; return }
    let alive = true
    untrack(async () => {
      const out = []
      for (const d of live.devices.filter((x) => /dbc/i.test(x.type ?? ''))) {
        const r = await api.dbcSearch(d.guid, '', 5000).catch(() => null)   // a car DBC holds thousands: the picker searches them all
        for (const g of r?.items ?? []) out.push({ value: `ecu:${d.guid}:${g.id}:${g.startBit}:${g.name}`, label: `${d.name} · ${g.name} (ECU, over CAN)`, search: `${g.messageName ?? ''} ecu dbc`, local: false, module: d.name, dbc: g, sig: { label: g.name }, bit: g.length === 1 })
      }
      if (alive) ecuOpts = out
    })
    return () => { alive = false }
  })
  const ecuFor = (t) => (t === 'bool' ? ecuOpts.filter((o) => o.bit) : ecuOpts)
  const optsFor = (f) => [...(f.opt ? [{ value: '', label: '— none —' }] : []), ...(inOpts[logicGuid + '|' + f.t] ?? []), ...ecuFor(f.t)]
  const inOpt = (k) => { const f = tpl.fields.find((x) => x.k === k); return [...(inOpts[logicGuid + '|' + f.t] ?? []), ...ecuFor(f.t)].find((o) => o.value === sel[k] && o.value !== '') }
  const outOpt = (k) => outOpts.find((o) => o.value === sel[k])
  const outName = (v) => outOpts.find((x) => x.value === v)?.name || 'output ' + numOut(v)

  // ---- preview, re-run on every change
  let preview = $state(null), previewErr = $state('')
  $effect(() => {
    const s = { ...sel }
    // untracked: the device list updates 10 times a second
    previewTemplate(tpl, s, outName, untrack(() => shedCaps(mods))).then((p) => { preview = p; previewErr = '' }).catch((e) => { preview = null; previewErr = e.message })
  })
  const freed = $derived(freedBy(editing))
  const short = $derived(preview && logicGuid ? shortfalls(preview.need, funcs[logicGuid], freed[logicGuid]) : [])
  const remoteShort = $derived(logicGuid ? remoteShortfalls(tpl, sel, logicGuid, funcs, live.devices, freed) : [])
  const drawIns = $derived(tpl.fields.filter(isInput).filter((f) => !f.opt || !blank(sel[f.k])).map((f) => ({ k: f.k, label: f.label, opt: inOpt(f.k) })))
  const drawOuts = $derived(tpl.fields.filter((f) => f.t === 'out' && (!f.opt || !blank(sel[f.k]))).map((f) => ({ k: f.k, label: f.label, load: f.load, opt: outOpt(f.k), num: blank(sel[f.k]) ? null : sel[f.k] })))

  // ---- steps
  const fOut = $derived(tpl.fields.filter((f) => f.t === 'out'))
  // a module pick (the module the logic runs on and whose outputs it uses): the project's PDMs
  const fMod = $derived(tpl.fields.filter((f) => f.t === 'module'))
  const modOpts = $derived(mods.filter((d) => !/can.?board/i.test(d.type ?? '')).map((d) => ({ value: d.guid, label: d.name })))
  const fIn = $derived(tpl.fields.filter(isInput))
  const fSet = $derived(tpl.fields.filter((f) => f.t === 'number' || f.t === 'op' || f.t === 'check'))
  const steps = $derived([
    { id: 'out', name: 'Where it goes', sub: 'module, pin, relay?' },
    ...(fIn.length ? [{ id: 'in', name: 'What drives it', sub: 'switches, sensors, signals' }] : []),
    ...(fSet.length ? [{ id: 'set', name: 'Settings', sub: 'times, limits, options' }] : []),
    { id: 'check', name: 'Check and apply', sub: 'preview, then apply' },
  ])
  const cur = $derived(steps[Math.min(step, steps.length - 1)])
  const stepIssue = $derived.by(() => {
    if (cur.id === 'out') {
      const miss = [...fMod, ...fOut].filter((f) => !f.opt && blank(sel[f.k]))
      if (miss.length) return 'Pick: ' + miss.map((f) => f.label).join(', ')
      const o = fOut.filter((f) => !blank(sel[f.k])).map((f) => String(sel[f.k]))
      if (new Set(o).size !== o.length) return 'The same output is picked twice.'
      return lm.error ?? ''
    }
    if (cur.id === 'in') {
      const miss = fIn.filter((f) => !f.opt && blank(sel[f.k]))
      if (miss.length) return 'Pick: ' + miss.map((f) => f.label).join(', ')
      const none = (tpl.need ?? []).find((ks) => ks.every((k) => blank(sel[k])))
      return none ? 'Pick one of: ' + none.map((k) => tpl.fields.find((f) => f.k === k).label).join(' or ') : ''
    }
    if (cur.id === 'set') {
      const bad = fSet.find((f) => f.t === 'number' && (blank(sel[f.k]) || (f.max != null && (+sel[f.k] < (f.min ?? 0) || +sel[f.k] > f.max))))
      return bad ? (blank(sel[bad.k]) ? `${bad.label}: enter a number.` : `${bad.label}: must be ${bad.min ?? 0} to ${bad.max}. The module rejects anything outside.`) : ''
    }
    return validate(tpl, sel) || lm.error || previewErr || (short.length ? 'Not enough free slots on ' + logic?.name + ': ' + short.join(', ') : '')
      || (remoteShort.length ? 'Outputs on other modules follow the logic over CAN. Not enough free CAN inputs on ' + remoteShort.join(', ') : '')
  })

  // ---- live values of the picked inputs
  let liveVals = $state({})
  const picked = $derived(fIn.map((f) => ({ f, o: inOpt(f.k) })).filter((x) => x.o))
  $effect(() => {
    if (cur.id !== 'in' && cur.id !== 'check') return
    const guids = [...new Set(picked.map(({ o }) => (o.local ? logicGuid : o.source?.guid)).filter(Boolean))]
    let dead = false
    const tick = async () => {
      const got = {}
      await Promise.all(guids.map(async (g) => { got[g] = await api.signals(g).catch(() => []) }))
      if (!dead) liveVals = got
    }
    tick(); const t = setInterval(tick, 1500)
    return () => { dead = true; clearInterval(t) }
  })
  function nowText(f) {
    const o = inOpt(f.k); if (!o) return ''
    if (o.unused) return 'switched on when you apply'
    const g = o.local ? logicGuid : o.source?.guid
    const nm = o.label.replace(/\s+\(over CAN\)$/, '').split(' · ').pop().replace(/ · not enabled yet$/, '').trim().toLowerCase()
    const s = (liveVals[g] ?? []).find((x) => x.name?.toLowerCase() === nm)
    return s ? 'now: ' + (/^(true|false|on|off)$/i.test(s.value) ? (s.on ? 'on' : 'off') : s.value + (s.on ? '' : '')) : ''
  }

  // ---- apply
  function applyIssues() { return stepIssue }
  async function apply(force = false) {
    applyErr = ''
    const issue = applyIssues(); if (issue) { applyErr = issue; return }
    const mine = (editing?.wired ?? []).map((w) => (/^\d+$/.test(String(w)) ? `${editing.guid}:${w}` : String(w)))
    const taken = fOut.filter((f) => !tpl.keepsRule && outOpt(f.k)?.used && !mine.includes(sel[f.k]))
    if (taken.length && !force) { confirmTake = true; return }
    busy = true
    const others = get(templateInstances).filter((i) => i.id !== editing?.id)
    // ECU picks become CAN inputs on the logic module first; listed as a kept instance so an edit's undo of
    // the old version leaves the ones this run reuses (it hands their slots over instead)
    const ecu = { guid: logicGuid, created: [], cans: [] }
    try {
      const s = { ...sel }
      for (const f of fIn) {
        const o = inOpt(f.k)
        if (!o?.dbc) continue
        const r = await addCanInputFromDbc(logicGuid, o.dbc)
        if (!r.reused) ecu.created.push({ kind: 'caninput', number: r.number, before: r.before })
        ecu.cans.push(r.number)
        s[f.k] = f.t === 'bool' ? (r.stateIndex ?? r.valueIndex) : (r.valueIndex ?? r.stateIndex)
        if (s[f.k] == null) throw new Error(`${f.label}: created the CAN input but couldn't resolve its signal`)
      }
      const keep = ecu.cans.length ? [...others, ecu] : others
      const { partial, ...inst } = await applyTemplate(api, { devices: live.devices, tpl, sel: s, relays, name, id: editing?.id ?? crypto.randomUUID(), old: editing, others: keep, inOpt, outOpts })
      inst.created = [...(inst.created ?? []), ...ecu.created]; inst.cans = [...(inst.cans ?? []), ...ecu.cans]
      templateInstances.set([...others, inst])
      project.dirty = true
      result = { inst, partial, outs: inst.wired?.length ?? 0, blocks: inst.created?.length ?? 0 }
      if (partial) toast(partial + '.', 'error')
      else toast(`Applied “${inst.name}” on ${logic?.name}.`, 'info', 3000)
    } catch (e) {
      if (ecu.created.length) await undoTemplate(api, live.devices, ecu, others).catch(() => {})
      if (editing) templateInstances.set(others)   // the previous version was undone before the failure
      applyErr = 'Failed: ' + e.message + (/roll-back/.test(e.message) ? ' Some changes may still be on the modules. Apply again, or remove the function from the list.' : editing ? ' The previous version was removed. Fix it and apply again.' : ' Nothing was left half-built. You can apply again.')
    } finally { busy = false; await loadOutputs() }
  }
  // "Build it myself": the same inputs and outputs, your own logic in the flow builder or in Lua (buildMyself.js)
  async function buildSelf(mode) {
    applyErr = ''
    const issue = applyIssues(); if (issue) { applyErr = issue; return }
    busy = true
    try {
      const s = { ...sel }
      for (const f of fIn) {   // ECU picks become CAN inputs on the logic module, as Apply does
        const o = inOpt(f.k)
        if (!o?.dbc) continue
        const r = await addCanInputFromDbc(logicGuid, o.dbc)
        s[f.k] = f.t === 'bool' ? (r.stateIndex ?? r.valueIndex) : (r.valueIndex ?? r.stateIndex)
      }
      const url = await buildMyself(mode, { tpl, sel: s, relays, name, inOpt, outOpts, logicGuid, others: get(templateInstances) })
      project.dirty = true
      toast(mode === 'lua' ? 'Inputs and outputs are ready: the Lua stub is on the module, write your logic in it.' : 'Inputs and outputs are ready: wire your logic between them.', 'info', 5000)
      location.hash = url
    } catch (e) { applyErr = 'Not built: ' + (e?.message ?? e) }
    finally { busy = false }
  }
  const takenNames = $derived(fOut.filter((f) => outOpt(f.k)?.used && !(editing?.wired ?? []).map((w) => (/^\d+$/.test(String(w)) ? `${editing.guid}:${w}` : String(w))).includes(sel[f.k])).map((f) => outOpt(f.k).label.split(' · ').slice(0, 3).join(' · ')))
  const next = () => { if (!stepIssue) { step = Math.min(step + 1, steps.length - 1); maxStep = Math.max(maxStep, step) } }
  const nextName = $derived(steps[step + 1]?.name)
</script>

{#if result}
  <div class="nx-card done" data-testid="wizard-result">
    <Banner tone={result.partial ? 'warn' : 'ok'} title={result.partial ? 'Applied, but not everywhere' : `“${result.inst.name}” is built`}>
      {#if result.partial}{result.partial}.{:else}{result.blocks} blocks created, {result.outs} output{result.outs === 1 ? '' : 's'} wired on {devOf(result.inst.guid)?.name}.{/if}
    </Banner>
    <p class="muted">
      {#if devOf(result.inst.guid)?.connected}The change is live on the modules. It is lost at power-off until you store it on the modules (Apply to car in the top bar).{:else}The module is not on the bus, so this was saved in the project only. Apply it when the module is back.{/if}
    </p>
    <ul class="made">
      {#each result.inst.created ?? [] as c}<li><span class="mono">{devOf(c.guid ?? result.inst.guid)?.name} {c.kind} {c.number}</span></li>{/each}
      {#each result.inst.wired ?? [] as w}<li>Output <span class="mono">{outOpts.find((o) => o.value === (/^\d+$/.test(String(w)) ? `${result.inst.guid}:${w}` : w))?.label.split(' · ').slice(0, 3).join(' · ') ?? w}</span> now follows this function.</li>{/each}
    </ul>
    <div class="acts">
      <Button variant="primary" href={href('functions')} data-testid="result-done">Back to functions</Button>
      <Button href={href('functions', 'flow', result.inst.guid)}>Open in builder</Button>
      <Button href={href('functions', 'add')}>Add another</Button>
    </div>
  </div>
{:else if !mods.length}
  <Empty title="No module to build on" text="Add a dingoPDM or a CANBoard first, then come back." />
{:else}
  <div class="wz">
    <nav class="rail" aria-label="Steps">
      <ol>
        {#each steps as s, i (s.id)}
          <li>
            <button type="button" class="st" class:on={i === step} aria-current={i === step ? 'step' : undefined} disabled={i > maxStep} onclick={() => (step = i)}>
              <span class="dot" class:done={i < step}>{i < step ? '✓' : i + 1}</span>
              <span class="tx"><b>{s.name}</b><span class="muted">{s.sub}</span></span>
            </button>
          </li>
        {/each}
      </ol>
    </nav>

    <section class="main" aria-label={cur.name}>
      <p class="eyebrow">STEP {Math.min(step, steps.length - 1) + 1} OF {steps.length}</p>

      {#if cur.id === 'out'}
        <h2>Where should “{name || tpl.name}” go?</h2>
        <p class="muted">{tpl.desc}</p>
        <Field label="Name of this function" bind:value={name} data-testid="fn-name" />
        {#each fMod as f (f.k)}
          <div class="fld" data-field={f.k}>
            <Select label={f.label} items={modOpts} value={String(sel[f.k] ?? '')} onchange={(v) => (sel[f.k] = v)} data-testid={'pick-' + f.k} />
            {#if !modOpts.length}<span class="muted">There is no PDM in the project.</span>{/if}
          </div>
        {/each}
        {#if fOut.length}<p class="muted relay-note" data-testid="relay-note"><b>Via relay?</b> {RELAY_WHY}</p>{/if}
        {#each fOut as f (f.k)}
          <div class="fld" data-field={f.k}>
            <SearchPick label={f.label + (f.opt ? ' (optional)' : '')} options={[...(f.opt ? [{ value: '', label: '— none —' }] : []), ...outOpts]} bind:value={sel[f.k]}
              placeholder="Search: module, J3-7, OUT1, name…" data-testid={'pick-' + f.k} />
            <span class="rl"><Checkbox bind:checked={relays[f.k]} label="Via relay" data-testid={'relay-' + f.k} /><span class="i" title={RELAY_WHY} aria-label={RELAY_WHY} role="img">i</span></span>
          </div>
        {/each}
        {#if takenNames.length}<Banner tone="warn" title="Already driven by something else">{takenNames.join(', ')}. Applying takes {takenNames.length > 1 ? 'them' : 'it'} over. Removing the function gives {takenNames.length > 1 ? 'them' : 'it'} back.</Banner>{/if}
        {#if lm.error}<Banner tone="warn" title={lm.error} />{/if}

      {:else if cur.id === 'in'}
        <h2>What should drive it?</h2>
        <p class="muted">Pick a switch, a sensor or a signal from any module. The logic runs on <b>{logic?.name ?? 'the module of the first output'}</b>; a signal from another module is sent over CAN.</p>
        {#if logicMoved}<Banner tone="info" title="Inputs were cleared">You moved the output to another module, so pick the inputs again.</Banner>{/if}
        {#each fIn as f (f.k)}
          <div class="fld" data-field={f.k}>
            <SearchPick label={f.label + (f.opt ? ' (optional)' : '')} options={optsFor(f)} bind:value={sel[f.k]} placeholder="Search: name, J3-3, DI3, module…" data-testid={'pick-' + f.k} />
            {#if nowText(f)}<span class="now mono" role="status" data-testid={'now-' + f.k}>{nowText(f)}</span>{/if}
          </div>
        {/each}

      {:else if cur.id === 'set'}
        <h2>Settings</h2>
        <p class="muted">The defaults fit most cars. The modules reject values outside the range.</p>
        {#each fSet as f (f.k)}
          {#if f.t === 'check'}
            <Checkbox bind:checked={sel[f.k]} label={f.label} data-testid={'set-' + f.k} />
          {:else if f.t === 'op'}
            <Select label={f.label} items={OPS.map((o) => ({ value: String(o.v), label: o.t }))} value={String(sel[f.k])} onchange={(v) => (sel[f.k] = +v)} />
          {:else}
            <Field label={f.label} type="number" bind:value={sel[f.k]} min={f.min} max={f.max} mono data-testid={'set-' + f.k} hint={f.max != null ? `${f.min ?? 0} to ${f.max}` : ''} />
          {/if}
        {/each}

      {:else}
        <h2>Check and apply</h2>
        <p class="muted">Applying writes to the modules right away. Read the list on the right, then apply.</p>
        <Drawings title={name} ins={drawIns} outs={drawOuts} {relays} {preview} logicName={logic?.name ?? ''} />
        {#if previewErr}<Banner tone="warn" title="Cannot build this yet">{previewErr}</Banner>{/if}
        {#if short.length}<Banner tone="warn" title={'Not enough free blocks on ' + logic?.name}>{short.join(', ')}. Free some in the flow builder or pick outputs on another module.</Banner>{/if}
        {#if remoteShort.length}<Banner tone="warn" title="Not enough free CAN inputs">{remoteShort.join(', ')}</Banner>{/if}
        {#if applyErr}<Banner tone="fault" title="Apply did not finish" data-testid="apply-error">{applyErr}</Banner>{/if}
        {#if editing}<p class="muted">Applying again replaces the old version: its blocks are removed first, then rebuilt.</p>{/if}
      {/if}

      {#if stepIssue && cur.id !== 'check'}<p class="issue" role="status" data-testid="step-issue">{stepIssue}</p>{/if}
      {#if stepIssue && cur.id === 'check' && !applyErr}<p class="issue" role="status" data-testid="step-issue">{stepIssue}</p>{/if}

      <div class="nav">
        <Button onclick={() => go('functions')} data-testid="wz-cancel">Cancel</Button>
        <span class="sp"></span>
        {#if step > 0}<Button onclick={() => (step = step - 1)} data-testid="wz-back">Back</Button>{/if}
        {#if cur.id === 'check'}
          {#if !editing}
            <Button {busy} disabled={busy || !!stepIssue} onclick={() => buildSelf('blocks')} title="Same inputs and outputs, your own blocks: opens the flow builder with them on the canvas" data-testid="wz-self-blocks">Build it myself: blocks</Button>
            <Button {busy} disabled={busy || !!stepIssue} onclick={() => buildSelf('lua')} title="Same inputs and outputs, your own Lua: the outputs follow Lua Outs and a stub reads every input" data-testid="wz-self-lua">…in Lua</Button>
          {/if}
          <Button variant="primary" {busy} disabled={busy || !!stepIssue} onclick={() => apply(false)} data-testid="wz-apply">{editing ? 'Apply again' : 'Apply'}</Button>
        {:else}
          <Button variant="primary" disabled={!!stepIssue} onclick={next} data-testid="wz-next">Next: {nextName}</Button>
        {/if}
      </div>
    </section>

    <PreviewAside {tpl} {sel} {relays} {preview} {previewErr} {drawIns} {drawOuts} {logic} {short} {remoteShort} {name} />
  </div>
{/if}

<Dialog bind:open={confirmTake} title="Take over an output that is in use?" description="Something else already drives it.">
  <ul class="made">{#each takenNames as n}<li class="mono">{n}</li>{/each}</ul>
  <p>The function takes {takenNames.length > 1 ? 'these outputs' : 'this output'} over. Removing the function later gives {takenNames.length > 1 ? 'them' : 'it'} back as before.</p>
  {#snippet footer()}
    <Button onclick={() => (confirmTake = false)}>Cancel</Button>
    <Button variant="primary" onclick={() => { confirmTake = false; apply(true) }} data-testid="confirm-take">Take over and apply</Button>
  {/snippet}
</Dialog>

<style>
  .wz { display: grid; grid-template-columns: 230px minmax(0, 1fr) 380px; gap: var(--space-5); align-items: start; }
  .rail ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .st { width: 100%; display: flex; align-items: center; gap: var(--space-3); min-height: 56px; padding: 0 var(--space-3); border-radius: var(--radius-md); border: 0; background: transparent; text-align: left; }
  .st.on { background: var(--color-raised); }
  .st:disabled { opacity: 0.7; }
  .dot { flex: none; width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; background: var(--color-raised); color: var(--color-text-muted); border: 1px solid var(--color-line-strong); }
  .on .dot { background: var(--color-accent); color: var(--color-on-accent); border-color: var(--color-accent); }
  .dot.done { color: var(--color-ok); }
  .tx { display: flex; flex-direction: column; font-size: var(--text-sm); }
  .tx .muted { font-size: var(--text-xs); }
  .main { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  .eyebrow { font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); }
  h2 { font-size: var(--text-xl); }
  .fld { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4); border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface); }
  .now { font-size: var(--text-sm); color: var(--color-on); }
  .relay-note { font-size: var(--text-sm); }
  .rl { display: inline-flex; align-items: center; gap: var(--space-2); }
  .i { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--color-line-strong); font-size: 11px; font-weight: 700; font-style: italic; color: var(--color-text-muted); cursor: help; }
  .issue { color: var(--color-warn); font-size: var(--text-sm); font-weight: 600; }
  .issue::before { content: '△ '; }
  .nav { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; padding-top: var(--space-2); }
  .sp { flex: 1 1 auto; }
  .done { display: flex; flex-direction: column; gap: var(--space-3); max-width: 760px; }
  .made { margin: 0; padding-left: var(--space-5); font-size: var(--text-sm); display: flex; flex-direction: column; gap: 4px; }
  .acts { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  @media (max-width: 1280px) { .wz { grid-template-columns: minmax(0, 1fr) 340px; } .rail { grid-column: 1 / -1; } .rail ol { flex-direction: row; flex-wrap: wrap; } .st { width: auto; } }
  @media (max-width: 900px) { .wz { grid-template-columns: 1fr; } }
</style>
