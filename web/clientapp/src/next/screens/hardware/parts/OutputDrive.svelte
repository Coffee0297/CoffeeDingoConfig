<script>
  import { untrack } from 'svelte'
  import { Card, Segmented, Switch, Stepper, Select, Field } from '../../../ui/index.js'
  import { api, toast } from '../../../lib/live.svelte.js'
  import { remoteItems, resolveRemote, isRemoteKey } from '../../../lib/remote.js'
  import { href } from '../../../router.svelte.js'

  // varFreq: the firmware has "frequency follows a signal" (output subs 21-23; upstream by its param list); upstream clamps it to 16-400 Hz
  // rampDuty: the firmware has "ramp every duty change" (output sub 24)
  let { guid, f = $bindable(), varFreq = true, freqMin = 15, rampDuty = true } = $props()
  const vf = $derived(varFreq && !!f.variableFreq)

  let nums = $state([])
  $effect(() => {
    guid
    Promise.all([api.inputs(guid, 'float'), api.inputs(guid, 'int')]).then(([a, b]) => (nums = [...(a ?? []), ...(b ?? [])])).catch(() => (nums = []))
  })
  // numbers on other modules and ECUs; a pick claims a CAN input on this module (staged like any edit)
  let remote = $state([]), linking = $state(false)
  $effect(() => {
    const g = guid
    let alive = true
    untrack(() => remoteItems(g, 'num')).then((r) => { if (alive) remote = r }).catch(() => {})   // untracked: reads the polled device list
    return () => { alive = false }
  })
  const items = $derived([{ value: '0', label: 'Choose a value' }, ...nums.filter((v) => v.index !== 0).map((v) => ({ value: String(v.index), label: v.name })), ...remote])
  async function pickSrc(key, v) {
    if (!isRemoteKey(v)) { f[key] = Number(v); return }
    linking = true
    try {
      f[key] = await resolveRemote(guid, v, 'num')
      const [a, b] = await Promise.all([api.inputs(guid, 'float'), api.inputs(guid, 'int')]); nums = [...(a ?? []), ...(b ?? [])]
    } catch (e) { toast(e?.message ?? String(e), 'error', 8000) } finally { linking = false; dutySrc = String(f.dutyCycleInput ?? 0); freqSrc = String(f.freqInput ?? 0) }
  }

  const mode = $derived(!f.pwmEnabled ? 'onoff' : f.variableDutyCycle ? 'signal' : 'fixed')
  let modeVal = $state('onoff')
  $effect(() => { modeVal = mode })
  function setMode(v) {
    f.pwmEnabled = v !== 'onoff'
    f.variableDutyCycle = v === 'signal'
    if (v === 'onoff') f.variableFreq = false
    if (v !== 'onoff' && !f.enabled) f.enabled = true
  }
  let dutySrc = $state('0'), freqSrc = $state('0')
  $effect(() => { dutySrc = String(f.dutyCycleInput ?? 0); freqSrc = String(f.freqInput ?? 0) })

  // Whole-number denominators: signal value at 100 % duty is a multiple of 100, at 400 Hz a multiple of 400.
  let dutyFull = $state(100), freqFull = $state(400)
  $effect(() => { dutyFull = (f.dutyCycleDenom || 1) * 100; freqFull = (f.freqInputDenom || 1) * 400 })
  const setDutyFull = (v) => { f.dutyCycleDenom = Math.max(1, Math.round((Number(v) || 0) / 100)) }
  const setFreqFull = (v) => { f.freqInputDenom = Math.max(1, Math.round((Number(v) || 0) / 400)) }

  const MODES = [{ value: 'onoff', label: 'On / off' }, { value: 'fixed', label: 'PWM, fixed duty' }, { value: 'signal', label: 'PWM, duty from a signal' }]
</script>

<Card title="Drive" aria-label="Drive">
  <Segmented label="How the output is driven" items={MODES} bind:value={modeVal} onchange={setMode} />
  {#if f.pwmEnabled}
    <div class="grid">
      {#if f.variableDutyCycle}
        <Select label="Duty comes from" items={items} bind:value={dutySrc} onchange={(v) => pickSrc('dutyCycleInput', v)} disabled={linking} data-testid="duty-source" />
        <Field label="Signal value at 100 % duty" type="number" bind:value={dutyFull} min={100} step={100} onchange={setDutyFull} hint={'duty % = signal ÷ ' + (f.dutyCycleDenom || 1)} />
      {:else}
        <Stepper label="Duty" bind:value={f.fixedDuty} min={0} max={100} step={5} unit="%" data-testid="duty" />
      {/if}
      <Stepper label="Lowest duty" bind:value={f.minDuty} min={0} max={100} step={5} unit="%" />
      {#if vf}
        <Select label="Frequency comes from" items={items} bind:value={freqSrc} onchange={(v) => pickSrc('freqInput', v)} disabled={linking} />
        <Field label="Signal value at 400 Hz" type="number" bind:value={freqFull} min={400} step={400} onchange={setFreqFull} hint={'frequency = signal ÷ ' + (f.freqInputDenom || 1)} />
      {:else}
        <Stepper label="Frequency" bind:value={f.freq} min={15} max={400} step={5} unit="Hz" data-testid="freq" />
      {/if}
    </div>
    {#if varFreq}<Switch bind:checked={f.variableFreq} label="Frequency follows a signal" hint={`Advanced. ${freqMin} to 400 Hz.`} />{/if}
  {/if}
  <div class="soft">
    <Switch bind:checked={f.softStart} label="Soft start" hint="Ramps up when it turns on." />
    {#if f.softStart}
      <Stepper label="Ramp time" bind:value={f.softStartRamp} min={0} max={10000} step={100} unit="ms" data-testid="ramp" />
      {#if rampDuty && f.pwmEnabled && f.variableDutyCycle}
        <Switch bind:checked={f.rampDutyChanges} label="Ramp every duty change" hint={`Slews on each change too, at up to 100 % per ${Number(f.softStartRamp) || 0} ms (the ramp time), not only at turn-on.`} />
      {/if}
    {/if}
  </div>
  <div class="crank">
    <strong>While the engine is cranking</strong>
    <span class="muted note">To switch it off while cranking (frees current and battery voltage for the starter), give it the Accessory role: it then follows the ignition and is off while the starter turns. Needs firmware 5.6. <a href={href('power', 'roles')}>Output roles</a></span>
  </div>
</Card>

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3); }
  .soft { display: flex; flex-direction: column; gap: var(--space-2); max-width: 520px; }
  .crank { display: flex; flex-direction: column; gap: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--color-line); }
  .note { font-size: var(--text-xs); }
</style>
