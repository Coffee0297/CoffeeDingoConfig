<script>
  // Shutdown & sleep sequence designer (System ▸ Settings). Describes the module's sleep in plain terms —
  // "sleep 30 s after ignition off, go quiet on CAN 2 s before, keep the dash on for 5 s, tell the other
  // modules at 3 s" — and compiles it onto the firmware primitives that already exist: Timers (named
  // "Sleep · …" so the designer can read its own work back), the force-sleep / mute-TX device inputs, a
  // CAN output for the shutdown frame and, on followers, a CAN input listening to it. Nothing new is
  // stored: the configuration IS the sequence, so it survives a Read from the module and shows up on the
  // Wiring canvas like any other logic.
  //
  // Roles: standalone (own ignition, nobody else cares), master (own ignition + broadcasts a shutdown
  // frame; applying it enrols every other module as a follower), follower (sleeps N s after the master's
  // frame says shutdown).
  import { api, applyGraphConnection } from './store.js'
  import { untrack } from 'svelte'
  import SearchSelect from './SearchSelect.svelte'
  import RemoteSourceAdd from './RemoteSourceAdd.svelte'
  // vars = the FULL var map (index maths: a free timer slot must resolve to its index); pickVars = configured
  // on/off signals only (what the Ignition picker offers).
  let { guid, devices = [], live = false, funcs = null, vars = [], pickVars = null, onapplied, onrefresh } = $props()

  const N_SLEEP = 'Sleep · off delay', N_QUIET = 'Sleep · quiet CAN', N_HOLD = 'Sleep · hold outputs', N_FRAME = 'Sleep · shutdown frame', N_MASTER = 'Sleep master'
  const FOLLOWER_SLEEP_S = 10, FOLLOWER_QUIET_S = 8   // defaults for enrolled followers (well inside a 30 s master)
  const hx = (n) => '0x' + Math.max(0, n | 0).toString(16).toUpperCase().padStart(3, '0')
  const ssOpts = (arr, none = false) => (none ? [{ value: 0, label: '—' }] : []).concat((arr ?? []).map((v) => ({ value: v.index, label: v.name })))

  const me = $derived(devices.find((d) => d.guid === guid))
  const isCb = $derived(!!funcs?.digitalOut)
  const timers = $derived(funcs?.timers ?? [])
  const canOuts = $derived(funcs?.canOutputs ?? [])
  const canIns = $derived(funcs?.canInputs ?? [])
  const tIdx = (n, v = vars) => v.find((x) => x.kind === 'timer' && x.number === n)?.index ?? 0
  const ciIdx = (n, v = vars) => v.find((x) => x.kind === 'caninput' && x.number === n && x.prop === 'State')?.index ?? 0
  // Ignition candidates: real on/off signals, not the module's own always-true vars and not the sequence's own timers.
  const ignOpts = $derived.by(() => {
    const own = (v) => v.kind === 'timer' && [N_SLEEP, N_QUIET, N_HOLD, N_FRAME].includes(timers.find((t) => t.number === v.number)?.name)
    const list = (pickVars ?? vars).filter((v) => v.kind !== 'sys' && !own(v))
    const cur = ign && !list.some((v) => v.index === ign) ? vars.find((v) => v.index === ign) : null   // keep the current pick visible even if its function got disabled
    return cur ? [...list, cur] : list
  })
  // Outputs, PDM (from the device record) or CANBoard (from /functions), with the var index that drives them.
  const outs = $derived(isCb
    ? (funcs?.digitalOut ?? []).map((o) => ({ number: o.number, name: o.name, inputIdx: o.input | 0, enabled: o.enabled }))
    : (me?.outputs ?? []).map((o) => ({ number: o.number, name: o.name, inputIdx: o.inputVal | 0, enabled: o.enabled })))

  let role = $state('standalone')   // 'standalone' | 'master' | 'follower'
  let ign = $state(0), sleepS = $state(30), quietOn = $state(true), quietS = $state(28)
  let holdOn = $state(false), holdS = $state(5), held = $state([])
  let frameId = $state(0x5AA), frameS = $state(3), frameHex = $state('0x5AA')
  let masterGuid = $state('')
  let busy = $state(false), msg = $state(''), err = $state(false)

  // Other modules' functions — to list masters (for a follower) and to enrol followers (for a master).
  let others = $state({})
  // Keyed on the other modules' guids, not the `devices` array itself: the app re-fetches that list every
  // poll (new array each time), and re-running here on identity would hammer /functions and starve the
  // browser's connection pool (a remote-signal pull then took 10+ s).
  const otherKey = $derived(devices.filter((d) => d.guid !== guid && /pdm|can.?board/i.test(d.type || '') && !/dbc|ecu|keypad/i.test(d.type || '')).map((d) => d.guid).sort().join(','))
  $effect(() => {
    const key = otherKey
    const list = untrack(() => devices.filter((d) => key.split(',').includes(d.guid)))
    let alive = true
    Promise.all(list.map((d) => api.functions(d.guid).then((f) => [d.guid, f]).catch(() => [d.guid, null])))
      .then((pairs) => { if (alive) others = Object.fromEntries(pairs) })
    return () => { alive = false }
  })
  const masters = $derived(Object.entries(others).flatMap(([g, f]) => {
    const co = (f?.canOutputs ?? []).find((c) => c.enabled && c.name === N_FRAME)
    return co ? [{ guid: g, name: devices.find((d) => d.guid === g)?.name ?? g, id: co.id }] : []
  }))

  // Read the sequence back from the module's own config (names are the markers) — once per module, and again
  // after an Apply. NOT on every /functions refresh: pulling a remote ignition reloads the lists, and re-seeding
  // then would wipe the edits the user hasn't applied yet.
  let seedKey = $state(''), applies = $state(0)
  $effect(() => {
    if (!funcs || !vars.length) return
    const k = guid + ':' + applies
    if (seedKey === k) return
    seedKey = k
    const byName = (arr, name) => arr.find((t) => t.enabled && t.name === name)
    const tS = byName(timers, N_SLEEP), tQ = byName(timers, N_QUIET), tH = byName(timers, N_HOLD), tF = byName(timers, N_FRAME)
    const co = byName(canOuts, N_FRAME), ci = byName(canIns, N_MASTER)
    if (!tS) { role = 'standalone'; ign = 0; held = []; return }
    sleepS = Math.round(tS.preset / 1000) || 1
    const trig = tS.input
    role = co ? 'master' : (ci && ciIdx(ci.number) === trig ? 'follower' : 'standalone')
    ign = role === 'follower' ? 0 : trig
    quietOn = !!tQ; quietS = tQ ? Math.round(tQ.preset / 1000) : Math.max(1, sleepS - 2)
    holdOn = !!tH; holdS = tH ? Math.round(tH.preset / 1000) : 5
    held = tH ? outs.filter((o) => o.inputIdx === tIdx(tH.number)).map((o) => o.number) : []
    if (co) { frameId = co.id | 0; frameS = tF ? Math.round(tF.preset / 1000) : 3 }
    if (ci) frameId = ci.id | 0
    frameHex = hx(frameId)
  })
  // A follower picks its master from the list (or types the frame ID by hand).
  $effect(() => { const m = masters.find((x) => x.guid === masterGuid); if (m) { frameId = m.id | 0; frameHex = hx(frameId) } })
  // Auto-pick a master once per switch to follower; `masters` recomputes every device poll, so an always-on
  // version kept reverting “(frame ID below)” and the hand-typed ID could never be used.
  let masterPicked = $state(false)
  $effect(() => { if (role !== 'follower') masterPicked = false })
  $effect(() => { if (role === 'follower' && !masterGuid && !masterPicked) { const m = masters.find((x) => x.id === frameId) ?? masters[0]; if (m) { masterGuid = m.guid; masterPicked = true } } })
  function setFrameHex(v) { frameHex = v; const n = parseInt(v, 16); if (Number.isFinite(n)) frameId = n }

  // Which outputs belong to the sequence: driven by the ignition signal, or already on the hold timer.
  const holdIdxNow = $derived(tIdx(timers.find((t) => t.enabled && t.name === N_HOLD)?.number ?? 0))
  const tied = (o) => (ign && o.inputIdx === ign) || (holdIdxNow && o.inputIdx === holdIdxNow)
  const roleOf = (o) => held.includes(o.number) && holdOn ? `held ${holdS} s` : (ign && o.inputIdx === ign) || (holdIdxNow && o.inputIdx === holdIdxNow) ? 'ignition' : o.enabled ? 'own rule' : '—'
  function toggleHeld(n, on) { held = on ? [...new Set([...held, n])] : held.filter((x) => x !== n) }

  // ---- timeline ----
  const trigWord = $derived(role === 'follower' ? 'master says shutdown' : 'ignition off')
  const S = $derived(Math.max(1, Number(sleepS) || 1))
  const ticks = $derived.by(() => {
    const t = [{ at: 0, label: `0 s · ${trigWord}` }]
    if (role === 'master') t.push({ at: Number(frameS) || 0, label: `${frameS} s · frame ${hx(frameId)}` })
    if (role !== 'follower' && holdOn && held.length) t.push({ at: Number(holdS) || 0, label: `${holdS} s · held outputs off` })
    if (quietOn) t.push({ at: Number(quietS) || 0, label: `${quietS} s · CAN quiet` })
    t.push({ at: S, label: `${S} s · sleep` })
    return t.filter((x) => x.at <= S && x.at >= 0).sort((a, b) => a.at - b.at)
  })
  const segs = $derived.by(() => {
    const bps = [...new Set(ticks.map((x) => x.at))]
    const out = []
    for (let i = 0; i < bps.length - 1; i++) {
      const a = bps[i], b = bps[i + 1]
      const st = role !== 'follower' && holdOn && held.length && a < (Number(holdS) || 0) ? { cls: 'hold', label: 'held outputs still on' }
        : quietOn && a >= (Number(quietS) || 0) ? { cls: 'quiet', label: 'quiet' }
        : { cls: 'awake', label: role === 'follower' ? 'awake · outputs as wired' : 'ignition outputs off · module awake' }
      const last = out[out.length - 1]
      if (last && last.cls === st.cls) last.dur += b - a; else out.push({ ...st, dur: b - a })
    }
    return out
  })

  function validate() {
    const q = Number(quietS), h = Number(holdS), f = Number(frameS)
    if (role !== 'follower' && !ign) return 'Pick the ignition signal first.'
    if (role === 'follower' && !(frameId > 0 && frameId <= 0x7FF)) return 'Pick the master module (or a shutdown frame ID 0x001–0x7FF).'
    if (!(S >= 1 && S <= 3600)) return 'Sleep delay must be 1–3600 s.'
    if (quietOn && !(q >= 0 && q < S)) return 'The quiet point must come before the sleep delay.'
    if (role !== 'follower' && holdOn && held.length && !(h > 0 && h <= S)) return 'Outputs can be held at most until the module sleeps (it switches every output off then).'
    if (role === 'master' && !(frameId > 0 && frameId <= 0x7FF)) return 'Shutdown frame ID must be 0x001–0x7FF.'
    if (role === 'master' && !(f >= 0 && f < S)) return 'The shutdown frame must go out before the module sleeps.'
    return ''
  }

  async function wireOutput(g, n, idx, cb, devs) {
    if (cb) await api.setFunction(g, 'digitaloutput', n, { enabled: true, input: idx })
    else await applyGraphConnection(g, 'output:' + n, 'input', idx, devs)
  }

  // Compile one module's sequence. `cfg` = { funcs, vars, outs, isCb, role, trig?, edge, sleepS, quietOn, quietS, hold... }
  async function compile(g, f, v, o, cb, p) {
    const T = f.timers ?? [], CO = f.canOutputs ?? [], CI = f.canInputs ?? []
    const claimed = new Set()
    const slot = (arr, name) => arr.find((t) => t.enabled && t.name === name) ?? arr.find((t) => !t.enabled && !claimed.has(t.number))
    const timer = (name) => { const t = slot(T, name); if (!t) throw new Error(`no free timer slot on ${p.name}`); claimed.add(t.number); return t.number }
    let trig = p.ign, edge = 1   // ignition: active while the input is OFF (falling edge)
    if (p.role === 'follower') {
      const c = slot(CI, N_MASTER); if (!c) throw new Error(`no free CAN input slot on ${p.name}`)
      await api.setFunction(g, 'caninput', c.number, { enabled: true, name: N_MASTER, id: p.frameId, startBit: 0, bitLength: 8, factor: 1, offset: 0, operator: 0, operand: 1, mode: 0, byteOrder: 0, signed: false, timeoutEnabled: false })   // reset a recycled slot fully
      trig = ciIdx(c.number, v); edge = 0   // active while the frame says 1
      if (!trig) throw new Error(`CAN input ${c.number} has no var-map entry on ${p.name}`)
    } else {
      const c = CI.find((x) => x.enabled && x.name === N_MASTER); if (c) await api.setFunction(g, 'caninput', c.number, { enabled: false })
    }
    // A CANBoard never sleeps (no force-sleep input): as a follower it only goes quiet on CAN when the master says so.
    const canSleep = !cb
    let nS = 0
    if (canSleep) { nS = timer(N_SLEEP); await api.setFunction(g, 'timer', nS, { enabled: true, name: N_SLEEP, input: trig, edge, mode: 0, preset: Math.round(p.sleepS * 1000) }) }
    else { const t = T.find((x) => x.enabled && x.name === N_SLEEP); if (t) await api.setFunction(g, 'timer', t.number, { enabled: false }) }
    let mute = 0
    const tQ = T.find((t) => t.enabled && t.name === N_QUIET)
    if (p.quietOn) { const nQ = timer(N_QUIET); await api.setFunction(g, 'timer', nQ, { enabled: true, name: N_QUIET, input: trig, edge, mode: 0, preset: Math.round(p.quietS * 1000) }); mute = tIdx(nQ, v) }
    else if (tQ) await api.setFunction(g, 'timer', tQ.number, { enabled: false })
    // Hold = off-delay on the ignition itself; the held outputs are re-pointed at the timer (and back when un-held).
    const tH = T.find((t) => t.enabled && t.name === N_HOLD); const hOld = tH ? tIdx(tH.number, v) : 0
    if (p.role !== 'follower' && p.holdOn && p.held.length) {
      const nH = timer(N_HOLD)
      await api.setFunction(g, 'timer', nH, { enabled: true, name: N_HOLD, input: trig, edge: 0, mode: 1, preset: Math.round(p.holdS * 1000) })
      const hi = tIdx(nH, v)
      for (const x of o) {
        const want = p.held.includes(x.number) ? hi : (hOld && x.inputIdx === hOld ? trig : null)
        if (want != null && want !== x.inputIdx) await wireOutput(g, x.number, want, cb, devices)
      }
    } else if (tH) {
      for (const x of o) if (hOld && x.inputIdx === hOld) await wireOutput(g, x.number, trig, cb, devices)
      await api.setFunction(g, 'timer', tH.number, { enabled: false })
    }
    // Shutdown frame: master only. Byte 0 = 1 once the ignition has been off for the grace time.
    const co = CO.find((c) => c.enabled && c.name === N_FRAME), tF = T.find((t) => t.enabled && t.name === N_FRAME)
    if (p.role === 'master') {
      const nF = timer(N_FRAME)
      await api.setFunction(g, 'timer', nF, { enabled: true, name: N_FRAME, input: trig, edge, mode: 0, preset: Math.round(p.frameS * 1000) })
      const c = co ?? CO.find((x) => !x.enabled); if (!c) throw new Error(`no free CAN output slot on ${p.name}`)
      await api.setFunction(g, 'canoutput', c.number, { enabled: true, name: N_FRAME, id: p.frameId, input: tIdx(nF, v), startBit: 0, bitLength: 8, factor: 1, offset: 0, byteOrder: 0, signed: false, interval: 100 })
    } else {
      if (co) await api.setFunction(g, 'canoutput', co.number, { enabled: false })
      if (tF) await api.setFunction(g, 'timer', tF.number, { enabled: false })
    }
    await api.deviceInputs(g, canSleep ? { forceSleepInput: tIdx(nS, v), muteTxInput: mute } : { muteTxInput: mute })
    return { forceSleep: canSleep ? tIdx(nS, v) : 0, muteTx: mute }
  }

  async function apply() {
    const bad = validate(); if (bad) { msg = bad; err = true; return }
    const followers = role === 'master' ? devices.filter((d) => d.guid !== guid && d.guid in others && others[d.guid]) : []
    if (role === 'master' && followers.length &&
        !confirm(`${me?.name ?? 'This module'} becomes the sleep master: it broadcasts frame ${hx(frameId)} (byte 0 = 1) ${frameS} s after ignition off.\n\nThese modules will follow it — their sleep trigger becomes that frame, sleeping ${FOLLOWER_SLEEP_S} s after it (quiet on CAN at ${FOLLOWER_QUIET_S} s; a CANBoard only goes quiet — it never sleeps):\n  • ${followers.map((d) => d.name).join('\n  • ')}\n\nContinue?`)) return
    busy = true; msg = ''; err = false
    try {
      const r = await compile(guid, funcs, vars, outs, isCb, { name: me?.name, role, ign, frameId, sleepS: S, quietOn, quietS: Number(quietS), holdOn, holdS: Number(holdS), held, frameS: Number(frameS) })
      if (live) await api.action(guid, 'burn')
      const done = [me?.name ?? 'module']
      for (const d of followers) {
        const f = others[d.guid]; const v = await api.inputs(d.guid).catch(() => [])   // full map — slot → index maths
        const cb = !!f?.digitalOut
        const o = cb ? (f.digitalOut ?? []).map((x) => ({ number: x.number, name: x.name, inputIdx: x.input | 0 })) : (d.outputs ?? []).map((x) => ({ number: x.number, name: x.name, inputIdx: x.inputVal | 0 }))
        await compile(d.guid, f, v, o, cb, { name: d.name, role: 'follower', ign: 0, frameId, sleepS: FOLLOWER_SLEEP_S, quietOn: true, quietS: FOLLOWER_QUIET_S, holdOn: false, holdS: 0, held: [], frameS: 0 })
        if (d.connected) await api.action(d.guid, 'burn')
        done.push(d.name + ' (follower)')
      }
      msg = (live ? 'Applied, burn queued: ' : 'Saved to the project: ') + done.join(', ') + (live ? ' — the Logs toast shows what each module acknowledged.' : ' — connect + Deploy to put it on the module(s).')
      await onapplied?.({ ...r, needCanWake: role === 'follower' })   // parent reloads /functions + vars first…
      applies++                                                        // …then we re-read the sequence from them
    } catch (e) { msg = 'Failed: ' + e.message + ' — the sequence may be half-applied; reopen Settings to see what landed.'; err = true }
    finally { busy = false }
  }
</script>

<div class="seq">
  <div class="seq-hd">
    <b>Shutdown &amp; sleep sequence</b>
    <div class="pills" role="radiogroup" aria-label="Sleep role">
      {#each [['standalone', 'Standalone'], ['master', 'Master'], ['follower', 'Follower']] as [v, l]}
        <button type="button" class:on={role === v} role="radio" aria-checked={role === v} onclick={() => (role = v)}>{l}</button>
      {/each}
    </div>
    <span class="hint">{role === 'master' ? 'owns the ignition and tells every other module when to shut down' : role === 'follower' ? 'sleeps when the master\'s shutdown frame says so' : 'sleeps on its own ignition signal; other modules are not involved'}</span>
  </div>

  {#if role === 'follower'}
    <div class="row">
      <div class="field"><label>Follows</label>
        <select bind:value={masterGuid}>
          {#each masters as m}<option value={m.guid}>{m.name} · frame {hx(m.id)}</option>{/each}
          <option value="">(frame ID below)</option>
        </select></div>
      <div class="field"><label>Shutdown frame ID</label><input value={frameHex} oninput={(e) => setFrameHex(e.target.value)} disabled={!!masterGuid} style="width:90px" /></div>
    </div>
    {#if !masters.length}<p class="hint">No module is a master yet — open the module with the ignition key, pick <b>Master</b> there and Apply; the others are enrolled automatically.</p>{/if}
  {:else}
    <div class="field"><label>Ignition signal <span class="muted">— on while the key is on; the sequence starts when it drops</span></label>
      <SearchSelect options={ssOpts(ignOpts, true)} bind:value={ign} placeholder="Search a digital input, CAN input…" />
      <!-- the key may sit on another module (a CANBoard by the column): pull its broadcast bit in as a local CAN input -->
      <RemoteSourceAdd {guid} {devices} kind="bool" label="＋ ignition from another module" onadded={(idx) => { ign = idx; onrefresh?.() }} /></div>
  {/if}

  <div class="row">
    <div class="field num"><label>Sleep after {trigWord}</label><span><input type="number" min="1" max="3600" bind:value={sleepS} /> s</span></div>
    <div class="field num"><label><input type="checkbox" bind:checked={quietOn} /> Quiet on CAN at</label><span><input type="number" min="0" max="3600" bind:value={quietS} disabled={!quietOn} /> s</span></div>
    {#if role !== 'follower'}
      <div class="field num"><label><input type="checkbox" bind:checked={holdOn} /> Hold outputs for</label><span><input type="number" min="1" max="3600" bind:value={holdS} disabled={!holdOn} /> s</span></div>
    {/if}
    {#if role === 'master'}
      <div class="field num"><label>Shutdown frame</label><span><input value={frameHex} oninput={(e) => setFrameHex(e.target.value)} style="width:72px" /> at <input type="number" min="0" max="3600" bind:value={frameS} /> s</span></div>
    {/if}
  </div>

  {#if role !== 'follower' && holdOn}
    <div class="outs">
      {#each outs as o (o.number)}
        <label class:dim={!tied(o)} title={tied(o) ? 'Tick to keep this output on after ignition off' : 'Not driven by the ignition signal — wire it to the ignition first'}>
          <input type="checkbox" checked={held.includes(o.number)} disabled={!tied(o)} onchange={(e) => toggleHeld(o.number, e.target.checked)} />
          <span class="n">{isCb ? 'DO' : 'O'}{o.number}</span> {o.name || 'output ' + o.number}
          <span class="chip {roleOf(o).startsWith('held') ? 'hold' : roleOf(o) === 'ignition' ? 'ign' : ''}">{roleOf(o)}</span>
        </label>
      {/each}
      {#if !outs.some(tied)}<p class="hint">None of the outputs is driven by the ignition signal yet — wire them to it (Outputs or Wiring) and they can be held here.</p>{/if}
    </div>
  {/if}

  <div class="tl" aria-hidden="true">{#each segs as s}<div class="seg {s.cls}" style="flex:{Math.max(s.dur, S * 0.08)}">{s.label}</div>{/each}</div>
  <!-- ticks in order, evenly spaced (proportional placement piles 0 s / 3 s / 5 s on top of each other) -->
  <div class="ticks" aria-label="Sequence">{#each ticks as t}<span>{t.label}</span>{/each}</div>

  <div class="row" style="align-items:center;margin-top:8px">
    <button class="btn primary" disabled={busy} onclick={apply}>{busy ? 'Applying…' : live ? 'Apply + burn' : 'Apply to project'}</button>
    {#if msg}<span class="msg" class:err>{msg}</span>{:else}<span class="hint">Compiles to Timers named “Sleep · …”{role === 'master' ? ', a CAN output for the frame' : role === 'follower' ? ', a CAN input “Sleep master”' : ''} and the force-sleep / mute-TX inputs below. At sleep the module switches every output off itself.</span>{/if}
  </div>
</div>

<style>
  .seq { border: 1px solid var(--line-2, #3a3a4c); border-radius: 10px; padding: 12px 14px; margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
  .seq-hd { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .seq-hd .hint { margin: 0; }
  .pills { display: inline-flex; border: 1px solid var(--line-2, #3a3a4c); border-radius: 8px; overflow: hidden; }
  .pills button { background: transparent; color: var(--muted); border: 0; padding: 4px 12px; font: inherit; font-size: 12px; cursor: pointer; }
  .pills button.on { background: color-mix(in srgb, var(--accent, #594ae2) 22%, transparent); color: var(--ink); font-weight: 600; }
  .row { display: flex; gap: 14px; flex-wrap: wrap; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 0; }
  .field label { font-size: 12px; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; text-transform: none; letter-spacing: 0; }
  .field.num input[type=number] { width: 72px; }
  .field.num span { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .muted { color: var(--muted); font-weight: 400; }
  .outs { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 4px 14px; font-size: 12px; }
  .outs label { display: flex; align-items: center; gap: 6px; color: var(--ink); }
  .outs label.dim { color: var(--muted); opacity: .7; }
  .outs .n { font-family: var(--mono, monospace); color: var(--muted); min-width: 28px; }
  .chip { margin-left: auto; font-size: 10px; padding: 1px 7px; border-radius: 10px; background: var(--surface-2, #2a2a36); color: var(--muted); }
  .chip.ign { background: #1f4d36; color: #7fe0a8; } .chip.hold { background: #243a6b; color: #9cc3ff; }
  .tl { display: flex; height: 30px; border-radius: 7px; overflow: hidden; margin-top: 4px; }
  .seg { display: flex; align-items: center; padding: 0 10px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .seg.hold { background: #243a6b; color: #c9dcff; } .seg.awake { background: var(--surface-2, #2a2a36); color: var(--ink); } .seg.quiet { background: #5a1f24; color: #ffb3b8; }
  .ticks { display: flex; justify-content: space-between; gap: 8px; font-size: 10.5px; color: var(--muted); flex-wrap: wrap; }
  .ticks span { white-space: nowrap; }
  .msg { font-size: 12px; color: var(--ok, #2fbf71); } .msg.err { color: var(--err, #e5484d); }
  .hint { font-size: 12px; color: var(--muted); margin: 0; }
</style>
