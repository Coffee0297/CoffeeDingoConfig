<script>
  import { Card, Segmented, Switch, Stepper, Select, Field, FwBadge } from '../../../ui/index.js'
  import { api } from '../../../lib/live.svelte.js'

  let { guid, f = $bindable() } = $props()

  let nums = $state([])
  $effect(() => {
    guid
    Promise.all([api.inputs(guid, 'float'), api.inputs(guid, 'int')]).then(([a, b]) => (nums = [...(a ?? []), ...(b ?? [])])).catch(() => (nums = []))
  })
  const items = $derived([{ value: '0', label: 'Choose a value' }, ...nums.filter((v) => v.index !== 0).map((v) => ({ value: String(v.index), label: v.name }))])

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
        <Select label="Duty comes from" items={items} bind:value={dutySrc} onchange={(v) => (f.dutyCycleInput = Number(v))} data-testid="duty-source" />
        <Field label="Signal value at 100 % duty" type="number" bind:value={dutyFull} min={100} step={100} onchange={setDutyFull} hint={'duty % = signal ÷ ' + (f.dutyCycleDenom || 1)} />
      {:else}
        <Stepper label="Duty" bind:value={f.fixedDuty} min={0} max={100} step={5} unit="%" data-testid="duty" />
      {/if}
      <Stepper label="Lowest duty" bind:value={f.minDuty} min={0} max={100} step={5} unit="%" />
      {#if f.variableFreq}
        <Select label="Frequency comes from" items={items} bind:value={freqSrc} onchange={(v) => (f.freqInput = Number(v))} />
        <Field label="Signal value at 400 Hz" type="number" bind:value={freqFull} min={400} step={400} onchange={setFreqFull} hint={'frequency = signal ÷ ' + (f.freqInputDenom || 1)} />
      {:else}
        <Stepper label="Frequency" bind:value={f.freq} min={15} max={400} step={5} unit="Hz" data-testid="freq" />
      {/if}
    </div>
    <Switch bind:checked={f.variableFreq} label="Frequency follows a signal" hint="Advanced. 15 to 400 Hz." />
  {/if}
  <div class="soft">
    <Switch bind:checked={f.softStart} label="Soft start" hint="Ramps up when it turns on." />
    {#if f.softStart}
      <Stepper label="Ramp time" bind:value={f.softStartRamp} min={0} max={10000} step={100} unit="ms" data-testid="ramp" />
      {#if f.pwmEnabled && f.variableDutyCycle}
        <Switch bind:checked={f.rampDutyChanges} label="Ramp every duty change" hint="Slews on each change, not only at turn-on." />
      {/if}
    {/if}
  </div>
  <div class="crank">
    <strong>While the engine is cranking</strong>
    <Segmented label="While cranking" items={[{ value: 'keep', label: 'Keep running' }, { value: 'off', label: 'Switch off while cranking' }]} value="keep" disabled />
    <span class="muted note"><FwBadge /> Frees current and battery voltage for the starter. Needs the Ignition block (firmware 5.6), so it cannot be set yet.</span>
  </div>
</Card>

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3); }
  .soft { display: flex; flex-direction: column; gap: var(--space-2); max-width: 520px; }
  .crank { display: flex; flex-direction: column; gap: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--color-line); }
  .note { font-size: var(--text-xs); }
</style>
