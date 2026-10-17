<script>
  // Shut-down order: one module owns the ignition (master) and sends a shutdown frame; the others follow it
  // in the order listed, each sleeping N s after the frame. Compiled by lib/sleepSeq.js (same as the old
  // UI's designer); the edits are staged and go to the car with Apply.
  import { untrack } from 'svelte'
  import { Dialog, Button, Select, Stepper, Checkbox, Banner } from '../../../ui/index.js'
  import { api, live, hex, toast } from '../../../lib/live.svelte.js'
  import { compileSequence, N_SLEEP, N_HOLD, N_FRAME, tIdx } from '../../../../lib/sleepSeq.js'
  import { remoteItems, resolveRemote } from '../../../lib/remote.js'
  let { open = $bindable(false), seq } = $props()

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  const isCb = (d) => /canboard/i.test(d?.type ?? '')
  let masterGuid = $state(''), ign = $state(0), sleepS = $state(30), quietOn = $state(true), quietS = $state(28), frameS = $state(3), frameId = $state(0x5AA)
  let followers = $state([])   // [{ guid, name, on, delay }] in shut-down order
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
      .map((d) => ({ guid: d.guid, name: d.name, cb: isCb(d), on: !s.frame || !!pm[d.guid]?.follows, delay: pm[d.guid]?.follows ? pm[d.guid].sleepS ?? 10 : 10 }))
      .sort((a, b) => a.delay - b.delay)
    err = ''
  }
  // a new master: it leaves the list, the old master joins it (as a follower); the others keep their place
  function changeMaster(g) {
    const prev = new Map(followers.map((x) => [x.guid, x]))
    const last = Math.max(10, ...followers.map((x) => x.delay))
    followers = mods.filter((d) => d.guid !== g)
      .map((d) => prev.get(d.guid) ?? { guid: d.guid, name: d.name, cb: isCb(d), on: true, delay: last })
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
      ign = String(await resolveRemote(m.guid, ign, 'bool'))
      const f = await api.functions(m.guid), v = await api.inputs(m.guid)
      mv = v
      // keep the held outputs the old designer may have set up
      const tH = (f.timers ?? []).find((t) => t.enabled && t.name === N_HOLD), o = outsOf(m, f)
      const held = tH ? o.filter((x) => x.inputIdx === tIdx(tH.number, v)).map((x) => x.number) : []
      await compileSequence(m.guid, f, v, o, isCb(m), { name: m.name, role: 'master', ign: Number(ign), frameId, sleepS, quietOn, quietS, holdOn: !!tH && held.length > 0, holdS: tH ? Math.round(tH.preset / 1000) : 0, held, frameS }, live.devices)
      done.push(m.name)
      for (const x of followers.filter((x) => x.on && x.guid !== m.guid)) {
        const d = mods.find((y) => y.guid === x.guid)
        const ff = await api.functions(d.guid), vv = await api.inputs(d.guid)
        await compileSequence(d.guid, ff, vv, outsOf(d, ff), isCb(d), { name: d.name, role: 'follower', ign: 0, frameId, sleepS: x.delay, quietOn: true, quietS: Math.max(0, x.delay - 2), holdOn: false, holdS: 0, held: [], frameS: 0 }, live.devices)
        done.push(d.name)
      }
      // a module left out must not keep sending the shutdown frame (a former master)
      for (const x of followers.filter((x) => !x.on && x.guid !== m.guid)) {
        const ff = await api.functions(x.guid)
        for (const c of (ff.canOutputs ?? []).filter((c) => c.enabled && c.name === N_FRAME)) await api.setFunction(x.guid, 'canoutput', c.number, { enabled: false })
        for (const t of (ff.timers ?? []).filter((t) => t.enabled && t.name === N_FRAME)) await api.setFunction(x.guid, 'timer', t.number, { enabled: false })
      }
      toast(`Shut-down order staged on ${done.join(', ')}. Apply to car sends it.`, 'info', 6000)
      open = false
    } catch (e) { err = `${e.message}. ${done.length ? 'Done so far: ' + done.join(', ') + '.' : ''}` }
    finally { busy = false }
  }
</script>

<Dialog bind:open title="Shut-down order" description="The master owns the ignition and sends a shutdown frame; the other modules sleep in the order below, each a set time after the frame." width={680}>
  <div class="grid">
    <Select label="Master (has the ignition key)" items={mods.map((d) => ({ value: d.guid, label: d.name }))} bind:value={masterGuid} onchange={changeMaster} data-testid="seq-master" />
    <Select label="Ignition signal" items={ignItems} bind:value={ign} placeholder="Pick a switch or CAN signal…" data-testid="seq-ign" />
    <Stepper label="Shutdown frame after ignition off" min={0} max={3600} unit="s" bind:value={frameS} />
    <Stepper label="Master sleeps after ignition off" min={1} max={3600} unit="s" bind:value={sleepS} />
    <Checkbox label="Bus goes quiet before the master sleeps" bind:checked={quietOn} />
    {#if quietOn}<Stepper label="Quiet after ignition off" min={0} max={3600} unit="s" bind:value={quietS} />{/if}
  </div>
  <p class="muted">Frame <span class="mono">{hex(frameId)}</span>. Modules after the frame, first to sleep at the top:</p>
  <ol class="order" data-testid="seq-order">
    {#each followers as x, i (x.guid)}
      <li>
        <Checkbox label={x.name} bind:checked={x.on} />
        <span class="stp"><Stepper label={'Seconds after the frame for ' + x.name} min={1} max={3600} unit="s" bind:value={x.delay} onchange={resort} disabled={!x.on} /></span>
        <span class="muted note">{x.cb ? 'goes quiet (a CANBoard never sleeps)' : 'sleeps'}</span>
        <Button size="sm" variant="ghost" aria-label={'Move ' + x.name + ' up'} disabled={i === 0} onclick={() => move(i, -1)}>↑</Button>
        <Button size="sm" variant="ghost" aria-label={'Move ' + x.name + ' down'} disabled={i === followers.length - 1} onclick={() => move(i, 1)}>↓</Button>
      </li>
    {/each}
  </ol>
  {#if err}<Banner tone="fault" title="Not applied">{err}</Banner>{/if}
  {#snippet footer()}<Button onclick={() => (open = false)}>Cancel</Button><Button variant="primary" busy={busy} onclick={apply} data-testid="seq-apply">Stage the order</Button>{/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  .order { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 6px; }
  .order li { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .stp { width: 150px; }
  .note { flex: 1 1 auto; font-size: var(--text-xs); }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>
