<script>
  // Sleep setup: one master keeps the car awake while its keep-awake signals are on and for a set time after,
  // raises a pre-sleep signal before the end, then tells every other module to sleep (lib/sleepPlan.js). Separate
  // from the ignition: the ignition is just one of the signals it can watch. Staged; Apply to car sends it.
  import { untrack } from 'svelte'
  import { Dialog, Button, Select, Stepper, Checkbox, Banner } from '../../../ui/index.js'
  import { api, live, toast } from '../../../lib/live.svelte.js'
  import { shortfall, clearSleep, compileMaster, compileFollower, sleepSignals, repointSleep } from '../../../../lib/sleepPlan.js'
  import { remoteItems, resolveRemote } from '../../../lib/remote.js'
  import { SUB } from './sleepLogic.js'
  let { open = $bindable(false), seq } = $props()

  const mods = $derived(live.devices.filter((d) => /pdm|canboard/i.test(d.type ?? '')))
  let masterGuid = $state(''), ins = $state(['0', '0', '0']), keepS = $state(60), preS = $state(20), pulseS = $state(0), wakeS = $state(0)
  let others = $state({})   // guid -> follows
  let mv = $state([]), remote = $state([]), busy = $state(false), err = $state('')

  // seed once per open from what the modules hold (untracked: devices and seq refresh on every poll)
  $effect(() => { if (open) untrack(seed) })
  function seed() {
    const pm = seq.state.perModule
    const m = mods.find((d) => pm[d.guid]?.master) ?? mods[0]
    masterGuid = m?.guid ?? ''
    const s = pm[masterGuid] ?? {}
    keepS = s.keepS ?? 60; preS = s.preS ?? 20; pulseS = s.pulseS ?? 0; wakeS = s.wakeS ?? 0
    ins = [...(s.inputs ?? []).map(String), '0', '0', '0'].slice(0, 3)
    // a module left out stays out; with no follower yet (a first setup, or an older design), every module follows
    const any = mods.some((d) => pm[d.guid]?.follows)
    others = Object.fromEntries(mods.map((d) => [d.guid, !any || !!pm[d.guid]?.follows || !!pm[d.guid]?.master]))   // an old master follows a new one
    err = ''
  }
  // the master's own signals, and signals on other modules or ECUs (Stage links those to a CAN input on the master)
  $effect(() => {
    const g = masterGuid
    if (!open || !g) return
    let alive = true
    api.inputs(g).then((v) => { if (alive) mv = v }).catch((e) => (err = e.message))
    untrack(() => remoteItems(g, 'bool')).then((r) => { if (alive) remote = r })
    return () => { alive = false }
  })
  const sigItems = $derived([{ value: '0', label: '— none —' }, ...mv.filter((v) => v.kind !== 'sys' && v.type !== 'float' && !/^Sleep · /.test(v.name)).map((v) => ({ value: String(v.index), label: v.name })), ...remote])
  const picked = $derived(ins.filter((x) => x && x !== '0'))
  const followers = $derived(mods.filter((d) => d.guid !== masterGuid))

  function validate() {
    if (!picked.length) return 'Pick at least one signal that keeps the car awake (the ignition, a door…).'
    if (!(keepS >= 2 && keepS <= 3600)) return 'Stay awake for 2–3600 s.'
    if (!(preS >= 0 && preS < keepS)) return 'The pre-sleep signal starts before the end: 0 up to the stay-awake time.'
    if (pulseS && !(pulseS > 0 && pulseS <= preS)) return 'The pulse must fit before the end: no longer than its start before sleep.'
    if (wakeS && !(wakeS > 0 && wakeS <= 60)) return 'The wake pulse is 0 (none) up to 60 s.'
    // each module sleeps on its own auto-sleep once the bus is quiet (nothing forces it: see lib/sleepPlan.js)
    const off = mods.filter((d) => (d.guid === masterGuid || others[d.guid]) && d.canSleep !== false && d.sleepEnabled === false)
    if (off.length) return `Automatic sleep is off on ${off.map((d) => d.name).join(', ')}: turn it on in Sleep settings, or leave ${off.length === 1 ? 'it' : 'them'} out. Each module sleeps on its own once the bus is quiet.`
    return ''
  }

  async function stage() {
    err = validate()
    if (err) return
    busy = true
    try {
      const m = mods.find((d) => d.guid === masterGuid)
      const plan = { inputs: picked, keepS, preS, pulseS, wakeS }
      const all = await Promise.all(mods.map(async (d) => ({ d, f: await api.functions(d.guid), v: await api.inputs(d.guid) })))
      // every module first: nothing changes unless all of them have the slots
      const short = all.filter((x) => x.d.guid === m.guid || others[x.d.guid])
        .map((x) => [x.d.name, shortfall(x.f, plan, x.d.guid === m.guid)]).filter(([, w]) => w)
      if (short.length) { err = `Nothing changed. ${short.map(([n, w]) => `${n} needs ${w}`).join('; ')}. Free them there, pick another master (a PDM has 8 timers, a CANBoard 4), or leave a module out.`; return }
      // another module's signal becomes a CAN input on the master: one at a time (in parallel both took the same free slot)
      plan.inputs = []
      for (const k of picked) plan.inputs.push(await resolveRemote(m.guid, k, 'bool'))
      for (const x of all) {
        x.before = sleepSignals(x.v)
        await clearSleep(x.d.guid, x.f, x.v)
        const f = await api.functions(x.d.guid)
        if (x.d.guid === m.guid) await compileMaster(x.d.guid, f, await api.inputs(x.d.guid), plan)
        else if (others[x.d.guid]) await compileFollower(x.d.guid, f, x.v, m)
      }
      for (const x of all) await repointSleep(x.d.guid, x.before, live.devices)   // outputs that used a Sleep signal
      // a keep-awake signal that is one of the master's digital inputs also wakes it
      const dis = plan.inputs.map((i) => mv.find((v) => v.index === i)).filter((v) => v?.kind === 'input' && v.prop === 'State')
      const mask = dis.reduce((a, v) => a | (1 << (v.number - 1)), m.wakeDigInputMask ?? 0)
      if (mask !== (m.wakeDigInputMask ?? 0)) await api.writeParam(m.guid, 0, SUB.wakeMask, mask)
      toast(`Sleep staged: ${m.name} is the master. Apply to car, then Store on modules: a module wakes from what it has stored.`, 'info', 9000)
      open = false
    } catch (e) { err = `${e.message}. Some modules may be half changed: open this again and stage once more.` }
    finally { busy = false }
  }
</script>

<Dialog bind:open title="Sleep" description="The master keeps the car awake while any of its signals is on and for a set time after, gives a pre-sleep signal before the end, then goes quiet. The others go quiet with it, and each module sleeps once the bus has been quiet for its sleep delay." width={640}>
  <div class="grid">
    <Select label="Master" items={mods.map((d) => ({ value: d.guid, label: d.name }))} bind:value={masterGuid} data-testid="sleep-master" />
    <span></span>
    {#each [0, 1, 2] as i (i)}
      <Select label={i === 0 ? 'Keep the car awake while…' : '…or while'} items={sigItems} bind:value={ins[i]} placeholder="Pick a switch or CAN signal…" data-testid={'sleep-in-' + i} />
    {/each}
    <Stepper label="Stay awake after they go off" min={2} max={3600} unit="s" bind:value={keepS} />
    <Stepper label="Pre-sleep signal starts before sleep" min={0} max={3600} unit="s" bind:value={preS} />
    <Stepper label="Pre-sleep pulse length (0 = on until sleep; a Pi halt line needs a pulse)" min={0} max={60} step={0.5} decimals={1} unit="s" bind:value={pulseS} />
    <Stepper label="Wake pulse if used again after it (0 = none)" min={0} max={60} step={0.5} decimals={1} unit="s" bind:value={wakeS} />
  </div>
  <p class="muted">Use <strong>Sleep · awake</strong> (on while the car is awake) and <strong>Sleep · pre-sleep</strong> (with the wake pulse in it) as the input of any output: the Pi and radio, the Pi's halt line. At the end the master goes quiet:</p>
  <fieldset class="fol" data-testid="sleep-followers">
    <legend>These go quiet with it, then sleep once the bus is quiet</legend>
    {#each followers as d (d.guid)}<Checkbox label={d.name} bind:checked={() => others[d.guid] ?? true, (v) => (others[d.guid] = v)} />{/each}
  </fieldset>
  {#if err}<Banner tone="fault" title="Not staged">{err}</Banner>{/if}
  {#snippet footer()}<Button onclick={() => (open = false)}>Cancel</Button><Button variant="primary" busy={busy} onclick={stage} data-testid="sleep-stage">Stage the sleep</Button>{/snippet}
</Dialog>

<style>
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  .fol { border: 1px solid var(--color-line); border-radius: var(--radius-md); padding: var(--space-3); display: flex; flex-wrap: wrap; gap: var(--space-3) var(--space-5); margin: 0; }
  .fol legend { padding: 0 var(--space-2); font-size: var(--text-sm); }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
</style>
