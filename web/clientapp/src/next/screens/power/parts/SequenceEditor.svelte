<script>
  // Shut-down order: one module owns the ignition (master) and sends a shutdown frame; the others follow it
  // in the order listed, each sleeping N s after the frame. Compiled by lib/sleepSeq.js (same as the old
  // UI's designer); the edits are staged and go to the car with Apply.
  import { untrack } from 'svelte'
  import { Dialog, Button, Select, Stepper, Checkbox, Banner } from '../../../ui/index.js'
  import { api, live, hex, toast } from '../../../lib/live.svelte.js'
  import { compileSequence, sequenceShortfall, N_SLEEP, N_HOLD, N_FRAME, tIdx } from '../../../../lib/sleepSeq.js'
  import { remoteItems, resolveRemote } from '../../../lib/remote.js'
  let { open = $bindable(false), seq } = $props()

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  const isCb = (d) => /canboard/i.test(d?.type ?? '')
  let masterGuid = $state(''), ign = $state(0), sleepS = $state(30), quietOn = $state(true), quietS = $state(28), frameS = $state(3), frameId = $state(0x5AA)
  let followers = $state([])   // [{ guid, name, on, delay }] in shut-down order
  // a new follower sleeps just after the master has gone quiet (sooner, the master's traffic wakes it again)
  const firstSafe = () => Math.max(1, (quietOn ? quietS : sleepS) - frameS + 1)
  // the master's times changed: a follower that would now sleep before the bus is quiet moves up to the first safe time
  const lift = () => { const m = firstSafe(); if (followers.some((x) => x.delay < m)) followers = followers.map((x) => (x.delay < m ? { ...x, delay: m } : x)) }
  let mf = null, mv = $state([]), busy = $state(false), err = $state('')

  // seed once per open from what the modules hold (untracked: devices and seq refresh on every poll)
  $effect(() => { if (open) untrack(seed) })
  function seed() {
    const pm = seq.state.perModule
    const m = mods.find((d) => pm[d.guid]?.frame) ?? mods.find((d) => pm[d.guid]?.sleepS != null && !pm[d.guid]?.follows) ?? mods.find((d) => !isCb(d)) ?? mods[0]
    masterGuid = m?.guid ?? ''
    const s = pm[masterGuid] ?? {}
    sleepS = s.sleepS ?? 30; quietOn = s.quietS != null || s.sleepS == null; quietS = s.quietS ?? Math.max(1, sleepS - 2); frameS = s.frameS ?? 3; frameId = s.frame?.id ?? 0x5AA
    followers = mods.filter((d) => d.guid !== masterGuid)
      .map((d) => ({ guid: d.guid, name: d.name, sleeps: d.canSleep !== false, on: !s.frame || !!pm[d.guid]?.follows, delay: pm[d.guid]?.follows ? pm[d.guid].sleepS ?? firstSafe() : firstSafe() }))
      .sort((a, b) => a.delay - b.delay)
    err = ''
  }
  // a new master: it leaves the list, the old master joins it (as a follower); the others keep their place
  function changeMaster(g) {
    const prev = new Map(followers.map((x) => [x.guid, x]))
    const last = Math.max(firstSafe(), ...followers.map((x) => x.delay))
    followers = mods.filter((d) => d.guid !== g)
      .map((d) => prev.get(d.guid) ?? { guid: d.guid, name: d.name, sleeps: d.canSleep !== false, on: true, delay: last })
      .sort((a, b) => a.delay - b.delay)
  }
  // the master's signals and its current ignition (the off-delay timer's input)
  $effect(() => {
    const g = masterGuid
    if (!open || !g) return
    let alive = true
    Promise.all([api.functions(g), api.inputs(g)]).then(([f, v]) => {
      if (!alive) return
      mf = f; mv = v
      ign = String((f?.timers ?? []).find((t) => t.enabled && t.name === N_SLEEP)?.input ?? 0)
    }).catch((e) => (err = e.message))
    return () => { alive = false }
  })
  const own = (v) => v.kind === 'timer' && /^Sleep · /.test((mf?.timers ?? []).find((t) => t.number === v.number)?.name ?? '')
  // on/off signals on other modules and ECUs; Stage links the picked one to a CAN input on the master
  let remote = $state([])
  $effect(() => {
    const g = masterGuid
    if (!open || !g) return
    let alive = true
    untrack(() => remoteItems(g, 'bool')).then((r) => { if (alive) remote = r })
    return () => { alive = false }
  })
  const ignItems = $derived([...mv.filter((v) => v.kind !== 'sys' && v.type !== 'float' && !own(v)).map((v) => ({ value: String(v.index), label: v.name })), ...remote])

  function move(i, d) {
    const j = i + d
    if (j < 0 || j >= followers.length) return
    const ds = followers.map((x) => x.delay).sort((a, b) => a - b)
    const l = [...followers]; [l[i], l[j]] = [l[j], l[i]]
    l.forEach((x, k) => (x.delay = ds[k]))   // the slots keep their times; the modules swap places
    followers = l
  }
  const resort = () => (followers = [...followers].sort((a, b) => a.delay - b.delay))

  function validate() {
    if (!ign || ign === '0') return 'Pick the ignition signal of the master module.'
    if (!(sleepS >= 1 && sleepS <= 3600)) return 'The master sleep time must be 1–3600 s.'
    if (quietOn && !(quietS >= 0 && quietS < sleepS)) return 'The bus must go quiet before the master sleeps.'
    if (!(frameS >= 0 && frameS < sleepS)) return 'The shutdown frame must go out before the master sleeps.'
    if (followers.some((f) => f.on && !(f.delay >= 1 && f.delay <= 3600))) return 'Each module sleeps 1–3600 s after the frame.'
    // A module woken by CAN traffic starts again (a full reset): one that sleeps while the master still talks is woken
    // straight away, talks, and wakes the master after it slept: the car never settles. Sleep after the bus is quiet.
    const quietAt = quietOn ? quietS : sleepS
    const early = followers.filter((f) => f.on && frameS + f.delay < quietAt)
    if (early.length) return `${early.map((f) => f.name).join(', ')} would sleep while the master still talks (it goes quiet ${quietAt} s after ignition off), and that traffic wakes ${early.length === 1 ? 'it' : 'them'} again. Make each wait at least ${quietAt - frameS} s after the frame, or let the master go quiet sooner.`
    return ''
  }
  const outsOf = (d, f) => (isCb(d) ? (f.digitalOut ?? []).map((x) => ({ number: x.number, inputIdx: x.input | 0 })) : (d.outputs ?? []).map((x) => ({ number: x.number, inputIdx: x.inputVal | 0 })))

  async function apply() {
    err = validate()
    if (err) return
    busy = true
    const done = []
    try {
      const m = mods.find((d) => d.guid === masterGuid)
      let f = await api.functions(m.guid), v = await api.inputs(m.guid)
      // keep the held outputs the old designer may have set up
      const tH = (f.timers ?? []).find((t) => t.enabled && t.name === N_HOLD), o = outsOf(m, f)
      const held = tH ? o.filter((x) => x.inputIdx === tIdx(tH.number, v)).map((x) => x.number) : []
      const plan = [{ d: m, f, v, o, p: { name: m.name, role: 'master', ign: Number(ign), frameId, sleepS, quietOn, quietS, holdOn: !!tH && held.length > 0, holdS: tH ? Math.round(tH.preset / 1000) : 0, held, frameS } }]
      for (const x of followers.filter((x) => x.on && x.guid !== m.guid)) {
        const d = mods.find((y) => y.guid === x.guid)
        const ff = await api.functions(d.guid)
        plan.push({ d, f: ff, v: await api.inputs(d.guid), o: outsOf(d, ff), p: { name: d.name, role: 'follower', ign: 0, frameId, sleepS: x.delay, quietOn: true, quietS: 0, autoSleep: d.sleepEnabled !== false, holdOn: false, holdS: 0, held: [], frameS: 0 } })   // quiet at the frame: a follower never wakes the others
      }
      // every module first: nothing is changed unless all of them have the slots
      const short = plan.map((s) => [s.p.name, sequenceShortfall(s.f, isCb(s.d), s.p)]).filter(([, w]) => w)
      if (short.length) { err = `Nothing changed. ${short.map(([n, w]) => `${n} needs ${w}`).join('; ')}. Free one there, or untick ${short.length === 1 ? 'that module' : 'those modules'}: a module left out keeps its own sleep settings.`; return }
      // the ignition from another module or the ECU becomes a CAN input on the master: the first change, after the check
      ign = String(await resolveRemote(m.guid, ign, 'bool'))
      f = await api.functions(m.guid); v = await api.inputs(m.guid); mv = v
      plan[0] = { ...plan[0], f, v, o: outsOf(m, f), p: { ...plan[0].p, ign: Number(ign) } }
      const own = []
      for (const s of plan) {
        if ((await compileSequence(s.d.guid, s.f, s.v, s.o, isCb(s.d), s.p, live.devices)).autoOnly) own.push(s.p.name)
        done.push(s.p.name)
      }
      // a module left out must not keep sending the shutdown frame (a former master)
      for (const x of followers.filter((x) => !x.on && x.guid !== m.guid)) {
        const ff = await api.functions(x.guid)
        for (const c of (ff.canOutputs ?? []).filter((c) => c.enabled && c.name === N_FRAME)) await api.setFunction(x.guid, 'canoutput', c.number, { enabled: false })
        for (const t of (ff.timers ?? []).filter((t) => t.enabled && t.name === N_FRAME)) await api.setFunction(x.guid, 'timer', t.number, { enabled: false })
      }
      toast(`Shut-down order staged on ${done.join(', ')}.${own.length ? ` ${own.join(', ')} had no free timer: ${own.length === 1 ? 'it goes' : 'they go'} quiet at the frame and sleep${own.length === 1 ? 's' : ''} on ${own.length === 1 ? 'its' : 'their'} own once the bus is quiet.` : ''} Apply to car sends it.`, 'info', 9000)
      open = false
    } catch (e) { err = `${e.message}. ${done.length ? 'Done so far: ' + done.join(', ') + '.' : ''}` }
    finally { busy = false }
  }
</script>

<Dialog bind:open title="Shut-down order" description="The master owns the ignition and sends a shutdown frame; the other modules sleep in the order below, each a set time after the frame." width={680}>
  <div class="grid">
    <Select label="Master (has the ignition key)" items={mods.map((d) => ({ value: d.guid, label: d.name }))} bind:value={masterGuid} onchange={changeMaster} data-testid="seq-master" />
    <Select label="Ignition signal" items={ignItems} bind:value={ign} placeholder="Pick a switch or CAN signal…" data-testid="seq-ign" />
    <Stepper label="Shutdown frame after ignition off" min={0} max={3600} unit="s" bind:value={frameS} onchange={lift} />
    <Stepper label="Master sleeps after ignition off" min={1} max={3600} unit="s" bind:value={sleepS} onchange={lift} />
    <Checkbox label="Bus goes quiet before the master sleeps" bind:checked={quietOn} onchange={lift} />
    {#if quietOn}<Stepper label="Quiet after ignition off" min={0} max={3600} unit="s" bind:value={quietS} onchange={lift} />{/if}
  </div>
  <p class="muted">Frame <span class="mono">{hex(frameId)}</span>. Modules after the frame, first to sleep at the top:</p>
  <div class="head muted" aria-hidden="true"><span>Module</span><span>After the frame</span><span>Then</span><span>Order</span></div>
  <ol class="order" data-testid="seq-order">
    {#each followers as x, i (x.guid)}
      <li>
        <Checkbox label={x.name} bind:checked={x.on} />
        <Stepper label={'Seconds after the frame for ' + x.name} hideLabel min={1} max={3600} unit="s" bind:value={x.delay} onchange={resort} disabled={!x.on} />
        <span class="note" class:muted={!x.on}>{!x.on ? 'left out' : x.sleeps ? 'sleeps' : 'goes quiet (firmware older than 5.5.111 cannot sleep)'}</span>
        <span class="mv">
          <Button size="sm" variant="ghost" aria-label={'Move ' + x.name + ' up'} disabled={i === 0} onclick={() => move(i, -1)}>↑</Button>
          <Button size="sm" variant="ghost" aria-label={'Move ' + x.name + ' down'} disabled={i === followers.length - 1} onclick={() => move(i, 1)}>↓</Button>
        </span>
      </li>
    {/each}
  </ol>
  {#if err}<Banner tone="fault" title="Not applied">{err}</Banner>{/if}
  {#snippet footer()}<Button onclick={() => (open = false)}>Cancel</Button><Button variant="primary" busy={busy} onclick={apply} data-testid="seq-apply">Stage the order</Button>{/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  /* one row per module: name | stepper | what happens | order; the column heading replaces a label per row */
  .head, .order li { display: grid; grid-template-columns: 120px 236px minmax(0, 1fr) 76px;   /* fixed widths: the heading is its own grid */ align-items: center; gap: var(--space-3); }
  .head { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: .04em; padding: 0 var(--space-2); margin-top: var(--space-2); }
  .order { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
  .order li { padding: var(--space-2); border-top: 1px solid var(--color-line); }
  .note { font-size: var(--text-sm); }
  .mv { display: flex; gap: 2px; }
  @media (max-width: 560px) { .head { display: none; } .order li { grid-template-columns: 1fr auto; } .order li > :global(:nth-child(-n+2)) { grid-column: 1 / -1; } }   /* name, then stepper, each a full row */
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>
