<script>
  // Templates tab: pick a ready-made circuit, choose its outputs on any module (optionally through a relay)
  // and its inputs from anywhere on the bus (by name, connector pin or module), preview the blocks it will
  // create with a wiring and a links drawing, then Apply. The logic runs on the module owning the outputs;
  // an input from another module becomes a CAN input there on Apply. Applied templates are kept in the
  // project so they can be edited or removed.
  import { get } from 'svelte/store'
  import SearchSelect from './SearchSelect.svelte'
  import BusInputPicker from './BusInputPicker.svelte'
  import TemplateDrawing from './TemplateDrawing.svelte'
  import { api, applyGraphConnection, addCanInputFromBroadcast, ensureInputEnabled, templateInstances, outputRatingA, deviceDefs } from './store.js'
  import { TEMPLATES, OPS, defaults, validate, previewTemplate, liveCtx, outputOptions, logicModule, shortfalls, isInput, blank } from './templates.js'
  import { pinFor, ioTag } from './pinmap.js'
  import { isDefaultName } from './businputs.js'
  import { toast } from './toast.js'
  import { labelFields } from './a11y.js'

  let { current, devices = [] } = $props()

  const isMod = (d) => /pdm|can.?board/i.test(d?.type ?? '')
  const isCb = (d) => /can.?board/i.test(d?.type ?? '')
  const mods = $derived(devices.filter(isMod))
  const devOf = (g) => devices.find((d) => d.guid === g)

  const relayDefaults = (t) => Object.fromEntries(t.fields.filter((f) => f.t === 'out').map((f) => [f.k, f.load !== 'load']))   // lamps, motors, pumps: relay
  let key = $state(TEMPLATES[0].key), sel = $state(defaults(TEMPLATES[0])), relays = $state(relayDefaults(TEMPLATES[0])), name = $state(TEMPLATES[0].name)
  let editing = $state(null)            // id of the instance being edited
  let busy = $state(false), msg = $state('')
  let inOpts = $state({})                // field → picker options (for pins / modules in the drawing)
  let outOpts = $state([])
  let funcsByGuid = $state({})
  let preview = $state(null), previewErr = $state('')
  const tpl = $derived(TEMPLATES.find((t) => t.key === key))

  function choose(k, inst = null) {
    key = k; const t = TEMPLATES.find((x) => x.key === k)
    sel = inst ? { ...defaults(t), ...inst.sel } : defaults(t)
    relays = inst ? { ...inst.relays } : relayDefaults(t)
    name = inst?.name ?? t.name; editing = inst?.id ?? null; msg = ''
    lastLogic = null   // the outputs just moved the logic module on purpose — keep the inputs
  }

  // Outputs on every module, with what drives them now (this module's functions for CANBoard outputs).
  async function loadOutputs() {
    const defs = get(deviceDefs)
    const f = {}
    await Promise.all(mods.map(async (d) => { f[d.guid] = await api.functions(d.guid).catch(() => null) }))
    funcsByGuid = f
    outOpts = outputOptions(mods.map((d) => ({ device: d, outs: isCb(d)
      ? (f[d.guid]?.digitalOut ?? []).map((o) => ({ number: o.number, name: o.name, input: o.enabled ? o.input : 0 }))
      : (d.outputs ?? []).map((o) => ({ number: o.number, name: o.name, input: o.inputVal, ratingA: outputRatingA(defs, d.type, o.number) })) })), pinFor, ioTag)
  }
  let modKey = $derived(mods.map((d) => d.guid).join())
  $effect(() => { modKey; loadOutputs() })

  // The logic module: owner of the picked outputs, else the selected module.
  const lm = $derived(logicModule(tpl, sel))
  const logicGuid = $derived(lm.guid ?? (isMod(current) ? current.guid : mods[0]?.guid))
  const logic = $derived(devOf(logicGuid))
  // Inputs were picked against the previous logic module — its local indices mean nothing on another one.
  let lastLogic = null
  $effect(() => {
    const g = logicGuid
    if (lastLogic && g !== lastLogic) for (const f of tpl.fields) if (isInput(f) && typeof sel[f.k] === 'number') sel[f.k] = ''
    lastLogic = g
  })

  const outOpt = (k) => outOpts.find((o) => o.value === sel[k])
  const inOpt = (k) => (inOpts[k] ?? []).find((o) => o.value === sel[k] && o.value !== '')
  const outName = (n) => { const o = outOpts.find((x) => x.value === `${logicGuid}:${n}`); return o?.name || 'output' + n }
  const numOut = (v) => +String(v).split(':')[1]

  // Live preview + drawings, re-run on every change.
  $effect(() => {
    const t = tpl, s = { ...sel }
    for (const f of t.fields) if (f.t === 'out' && !blank(s[f.k])) s[f.k] = numOut(s[f.k])
    previewTemplate(t, s, outName).then((p) => { preview = p; previewErr = '' }).catch((e) => { preview = null; previewErr = e.message })
  })
  const short = $derived(preview ? shortfalls(preview.need, funcsByGuid[logicGuid]) : [])
  const drawIns = $derived(tpl.fields.filter(isInput).filter((f) => !f.opt || !blank(sel[f.k])).map((f) => ({ k: f.k, label: f.label, opt: inOpt(f.k) })))
  const drawOuts = $derived(tpl.fields.filter((f) => f.t === 'out' && (!f.opt || !blank(sel[f.k]))).map((f) => ({ k: f.k, label: f.label, load: f.load, opt: outOpt(f.k), num: blank(sel[f.k]) ? null : numOut(sel[f.k]) })))
  const remoteIns = $derived(drawIns.filter((x) => x.opt && x.opt.local === false))

  // ---- apply / remove
  async function wireOut(dev, n, idx) {
    if (isCb(dev)) await api.setFunction(dev.guid, 'digitaloutput', n, { enabled: true, input: idx })
    else await applyGraphConnection(dev.guid, 'output:' + n, 'input', idx, devices)
  }
  // Disable what an instance made and unwire its outputs. CAN inputs and pins another applied template
  // still relies on (`keep`) stay on.
  async function undo(inst, keep = []) {
    const dev = devOf(inst.guid); if (!dev) return
    const busyCan = new Set(keep.filter((i) => i.guid === inst.guid).flatMap((i) => i.cans ?? []))
    const pinKey = (p) => `${p.guid}|${p.kind}|${p.number}`
    const busyPin = new Set(keep.flatMap((i) => (i.pins ?? []).map(pinKey)))
    for (const n of inst.wired ?? []) await wireOut(dev, n, inst.prev?.[n] ?? 0).catch(() => {})   // back to what drove it before
    for (const c of [...(inst.created ?? [])].reverse())
      if (!(c.kind === 'caninput' && busyCan.has(c.number))) await api.setFunction(dev.guid, c.kind, c.number, { enabled: false }).catch(() => {})
    for (const e of inst.enabled ?? []) if (!busyPin.has(pinKey(e))) await api.setFunction(e.guid, e.kind, e.number, { enabled: false }).catch(() => {})
  }
  async function apply() {
    msg = validate(tpl, sel) || lm.error || previewErr || (short.length ? 'Not enough free slots on ' + logic?.name + ': ' + short.join(', ') : '')
    if (msg) return
    const mine = editing ? get(templateInstances).find((i) => i.id === editing)?.wired ?? [] : []
    const taken = tpl.fields.filter((f) => f.t === 'out' && outOpt(f.k)?.used && !mine.includes(numOut(sel[f.k])))
    if (taken.length && !confirm(`${taken.map((f) => outOpt(f.k).label.split(' · ').slice(0, 3).join(' · ')).join(', ')} already driven by something else. The template takes ${taken.length > 1 ? 'them' : 'it'} over (Remove gives ${taken.length > 1 ? 'them' : 'it'} back). Continue?`)) return
    busy = true
    const dev = logic, created = [], enabled = [], cans = [], pins = [], prev = {}
    let ctx = null
    try {
      const old = editing && get(templateInstances).find((i) => i.id === editing)
      const others = get(templateInstances).filter((i) => i.id !== editing)
      if (old) { await undo(old, others); templateInstances.set(others) }
      const s = { ...sel }
      for (const f of tpl.fields) {
        if (f.t === 'out' && !blank(s[f.k])) s[f.k] = numOut(s[f.k])
        if (!isInput(f) || blank(s[f.k])) continue
        const o = inOpt(f.k)
        // An unused pin reads nothing until it is enabled (on its own module).
        const pin = o?.phys && { guid: o.local ? dev.guid : o.source.guid, ...o.phys }
        const role = f.label.replace(/\s*[(/].*$/, '')   // 'Headlight switch', what the pin now does
        if (pin) { pins.push(pin); if (await ensureInputEnabled(pin.guid, o.phys, role)) enabled.push(pin) }
        if (typeof s[f.k] === 'number') continue
        if (!o?.sig) throw new Error(`${f.label}: that signal is no longer on the bus — pick it again`)
        // remote: decode its broadcast here, named after the role while the pin still has its factory name
        const r = await addCanInputFromBroadcast(dev.guid, o.source, isDefaultName(o.sig.label) ? { ...o.sig, label: role } : o.sig)
        if (!r.reused) created.push({ kind: 'caninput', number: r.number })
        cans.push(r.number)
        s[f.k] = f.t === 'bool' ? (r.stateIndex ?? r.valueIndex) : (r.valueIndex ?? r.stateIndex)
        if (s[f.k] == null) throw new Error(`${f.label}: created the CAN input but couldn't resolve its signal`)
      }
      const was = (n) => old?.prev?.[n] ?? outOpts.find((o) => o.value === `${dev.guid}:${n}`)?.input ?? 0
      ctx = await liveCtx({ api, guid: dev.guid, isCanboard: isCb(dev), outName, wireOutput: (n, idx) => { prev[n] ??= was(n); return wireOut(dev, n, idx) } })
      await tpl.build(ctx, s)
      const inst = { id: editing ?? crypto.randomUUID(), key, name: name.trim() || tpl.name, guid: dev.guid, sel: { ...sel }, relays: { ...relays },
        created: [...created, ...ctx.created], wired: ctx.wired, prev, enabled, cans, pins, at: new Date().toISOString() }
      templateInstances.update((l) => [...l, inst])
      toast(`Applied “${inst.name}” on ${dev.name}${dev.connected ? ' — Burn to keep' : ' — saved to the project; Deploy to apply'}.`, 'info')
      editing = null; msg = ''
      await loadOutputs()
    } catch (e) {
      // Roll back what this run made so a failed apply leaves no half-built circuit.
      await undo({ guid: dev.guid, created: [...created, ...(ctx?.created ?? [])], wired: ctx?.wired ?? [], prev, enabled }, get(templateInstances))
      msg = 'Failed: ' + e.message + (editing ? ' — the previous version was removed; fix and Apply again.' : ''); toast(msg, 'error')
    } finally { busy = false }
  }
  async function remove(inst) {
    if (!confirm(`Remove “${inst.name}”? Its blocks are disabled and its outputs unwired.`)) return
    busy = true
    try { const others = get(templateInstances).filter((i) => i.id !== inst.id); await undo(inst, others); templateInstances.set(others); await loadOutputs(); if (editing === inst.id) choose(key) }
    catch (e) { toast('Remove failed: ' + e.message, 'error') } finally { busy = false }
  }
</script>

<div class="h-row">
  <div><h1>Templates</h1>
    <p class="sub">Ready-made circuits. Pick the <b>outputs</b> on any module (through a relay if you like), the <b>inputs</b> from anywhere on the bus — search by name, connector pin (<code>J3-3</code>), function (<code>DI3</code>) or module — and check the drawings. <b>Apply</b> builds the logic on the module that owns the outputs; then Burn (or Deploy when offline).</p></div>
</div>

{#if !mods.length}
  <p class="muted">Add a dingoPDM or CANBoard first.</p>
{:else}
<div class="tp">
  <nav class="list" aria-label="Templates">
    {#each TEMPLATES as t}
      <button class="card" class:on={t.key === key} onclick={() => choose(t.key)}><span class="ic">{t.icon}</span>{t.name}</button>
    {/each}
    {#if $templateInstances.length}
      <div class="mh">Applied</div>
      {#each $templateInstances as i (i.id)}
        <div class="inst" class:on={editing === i.id}>
          <span><b>{i.name}</b><br><span class="muted">{TEMPLATES.find((t) => t.key === i.key)?.name ?? i.key} · {devOf(i.guid)?.name ?? 'missing module'}</span></span>
          <button class="btn ghost sm" disabled={busy} onclick={() => choose(i.key, i)}>Edit</button>
          <button class="btn ghost sm" disabled={busy} aria-label={'Remove ' + i.name} onclick={() => remove(i)}>✕</button>
        </div>
      {/each}
    {/if}
  </nav>

  <section class="form" use:labelFields>
    <h2>{tpl.icon} {tpl.name}{editing ? ' — editing' : ''}</h2>
    <p class="muted">{tpl.desc}</p>
    <div class="field"><label>Name</label><input bind:value={name} /></div>

    <TemplateDrawing title={name} ins={drawIns} outs={drawOuts} {relays} {preview} logicName={logic?.name ?? ''} />

    <div class="cols"><div>
    <h3>Outputs</h3>
    {#each tpl.fields.filter((f) => f.t === 'out') as f}
      <div class="field"><label>{f.label}{#if f.opt}<span class="muted">&nbsp;(optional)</span>{/if}</label>
        <SearchSelect options={[...(f.opt ? [{ value: '', label: '— none —' }] : []), ...outOpts]} bind:value={sel[f.k]} placeholder="Search: module, J3-7, OUT1, name…" />
      </div>
      <label class="opt relay"><input type="checkbox" bind:checked={relays[f.k]} /> through a relay</label>
    {/each}
    {#if lm.error}<p class="hint"><b>{lm.error}</b></p>{/if}
    </div><div>
    <h3>Inputs <span class="muted" style="font-weight:400">— the logic runs on {logic?.name ?? '—'}</span></h3>
    {#each tpl.fields.filter(isInput) as f}
      <div class="field"><label>{f.label}{#if f.opt}<span class="muted">&nbsp;(optional)</span>{/if}</label>
        {#if logic}
          {#key logicGuid}
            <BusInputPicker device={logic} {devices} kind={f.t} optional={!!f.opt} defer bind:value={sel[f.k]} onload={(o) => (inOpts[f.k] = o)} />
          {/key}
        {/if}
      </div>
    {/each}

    </div></div>

    {#if tpl.fields.some((f) => f.t === 'number' || f.t === 'op' || f.t === 'check')}<h3>Settings</h3>{/if}
    {#each tpl.fields.filter((f) => f.t === 'number' || f.t === 'op' || f.t === 'check') as f}
      {#if f.t === 'check'}
        <label class="opt"><input type="checkbox" bind:checked={sel[f.k]} /> {f.label}</label>
      {:else}
        <div class="field"><label>{f.label}</label>
          {#if f.t === 'op'}<select bind:value={sel[f.k]}>{#each OPS as o}<option value={o.v}>{o.t}</option>{/each}</select>
          {:else}<input type="number" step={f.min != null ? 1 : 'any'} min={f.min} max={f.max} bind:value={sel[f.k]} />{/if}
        </div>
      {/if}
    {/each}

    <h3>What Apply does</h3>
    <ul class="what">
      {#each remoteIns as x}<li>Adds a CAN input on <b>{logic?.name}</b> decoding {x.opt.module}’s <b>{x.opt.sig?.label ?? x.opt.sig?.name}</b> (reuses one that already does).</li>{/each}
      {#each preview?.ops ?? [] as o}<li>Creates {o.op === 'virtual' ? 'a virtual input' : o.op === 'wiper' ? 'the wiper block' : 'a ' + o.op} <b>{o.name}</b> <span class="muted">({o.detail})</span></li>{/each}
      {#each preview?.wires ?? [] as w}{@const d = drawOuts.find((x) => x.num === w.out)}<li>Wires <b>{d?.opt ? [d.opt.module, d.opt.pin?.label, d.opt.tag, d.opt.name].filter(Boolean).join(' · ') : 'output ' + w.out}</b>{w.pwm ? ' (PWM duty)' : ''}.</li>{/each}
    </ul>
    {#if previewErr}<p class="hint"><b>{previewErr}</b></p>{/if}
    {#if short.length}<p class="hint"><b>Not enough free slots on {logic?.name}: {short.join(', ')}</b></p>{/if}
    {#if msg}<p class="hint"><b>{msg}</b></p>{/if}
    <div class="row">
      {#if editing}<button class="btn ghost" onclick={() => choose(key)}>Cancel edit</button>{/if}
      <button class="btn primary" disabled={busy} onclick={apply}>{busy ? 'Applying…' : editing ? 'Re-apply' : 'Apply'}</button>
    </div>
  </section>
</div>
{/if}

<style>
  .tp { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 16px; align-items: start; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
  @media (max-width: 900px) { .tp, .cols { grid-template-columns: 1fr; } }
  .list { display: flex; flex-direction: column; gap: 4px; }
  .card { text-align: left; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); cursor: pointer; font: inherit; color: inherit; }
  .card.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .ic { display: inline-block; width: 22px; }
  .mh { margin: 10px 0 2px; font-size: 11px; text-transform: uppercase; color: var(--muted); }
  .inst { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; font-size: 12px; }
  .inst > span { flex: 1; }
  .inst.on { border-color: var(--accent); }
  .form h2 { margin: 0 0 4px; font-size: 17px; } .form h3 { margin: 14px 0 6px; font-size: 13px; }
  .opt { display: flex; gap: 6px; align-items: center; font-size: 12px; margin: 4px 0; }
  .opt.relay { margin: -6px 0 10px; color: var(--muted); }
  .what { margin: 0; padding-left: 18px; font-size: 12px; } .what li { margin: 2px 0; }
  .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
  .sm { padding: 3px 8px; font-size: 12px; }
</style>
