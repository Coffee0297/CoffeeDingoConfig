<script>
  import { untrack } from 'svelte'
  import { Card, Segmented, Switch, Stepper, Select, Field, Button } from '../../../ui/index.js'
  import { api, toast } from '../../../lib/live.svelte.js'
  import { remoteItems, resolveRemote, isRemoteKey } from '../../../lib/remote.js'
  import { href } from '../../../router.svelte.js'
  import { pickDutyCurve, DUTY_CURVE } from '../../functions/flow/curve.js'

  // upstream: 16-400 Hz, 0 = keep (its timers cannot make 1-15 Hz); varFreq: the firmware has "frequency follows a signal" (output subs 21-23; upstream by its param list)
  // rampDuty: the firmware has "ramp every duty change" (output sub 24)
  // ssTimeout: the firmware has the current-limited soft start (upstream output sub 30)
  // softStop: the firmware has the soft stop (upstream output sub 31)
  let { guid, f = $bindable(), upstream = false, varFreq = true, rampDuty = true, ssTimeout = false, softStop = false } = $props()
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
    if (!isRemoteKey(v)) {
      f[key] = Number(v)
      // a PID output is the duty in % already (duty % = signal ÷ denominator)
      if (key === 'dutyCycleInput' && nums.find((x) => x.index === Number(v))?.kind === 'pid') f.dutyCycleDenom = 1
      return
    }
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

  // Duty curve (upstream dingoFW with the curve block, PDMs): a curve on this module drives the duty, 0–100 % (denominator 1)
  let curves = $state(null)
  $effect(() => { const g = guid; untrack(() => api.functions(g)).then((x) => { if (g === guid) curves = x?.curves ?? null }).catch(() => (curves = null)) })
  async function useCurve() {
    linking = true
    try {
      const vars = await api.inputs(guid)
      const c = pickDutyCurve(curves, vars, f.dutyCycleInput)
      if (!c) { toast('Every curve on this module is in use. Free one in the flow builder.', 'error', 8000); return }
      if (c.fresh) await api.setFunction(guid, 'curve', c.number, { ...DUTY_CURVE, enabled: true, name: `${f.name || 'Output'} duty` }); curves = (await api.functions(guid))?.curves ?? curves
      f.dutyCycleInput = c.index; f.dutyCycleDenom = 1; dutySrc = String(c.index)
      const [a, b] = await Promise.all([api.inputs(guid, 'float'), api.inputs(guid, 'int')]); nums = [...(a ?? []), ...(b ?? [])]
      toast(`Curve ${c.number} drives the duty (Y = duty %). Save, then set its input and points in the flow builder.`, 'info', 6000)
    } catch (e) { toast(e?.message ?? String(e), 'error', 8000) } finally { linking = false }
  }

  const MODES = [{ value: 'onoff', label: 'On / off' }, { value: 'fixed', label: 'PWM, fixed duty' }, { value: 'signal', label: 'PWM, duty from a signal' }]
</script>

<Card title="Drive" aria-label="Drive">
  <Segmented label="How the output is driven" items={MODES} bind:value={modeVal} onchange={setMode} />
  {#if f.pwmEnabled}
    <div class="grid">
      {#if f.variableDutyCycle}
        <Select label="Duty comes from" items={items} bind:value={dutySrc} onchange={(v) => pickSrc('dutyCycleInput', v)} disabled={linking} data-testid="duty-source" />
        {@const fromPid = nums.find((x) => x.index === Number(f.dutyCycleInput))?.kind === 'pid'}
        <Field label="Signal value at 100 % duty" type="number" bind:value={dutyFull} min={100} step={100} onchange={setDutyFull}
          hint={fromPid && (f.dutyCycleDenom || 1) !== 1 ? '▲ A PID output is the duty in %: set this to 100.' : 'duty % = signal ÷ ' + (f.dutyCycleDenom || 1)} />
        {#if curves}
          <div class="curve"><Button size="sm" onclick={useCurve} disabled={linking} data-testid="duty-curve">Use a duty curve</Button>
            <span class="muted note">Duty from up to 12 points against any signal (e.g. a fan against coolant temperature). <a href={href('functions', 'flow')}>Flow builder</a></span></div>
        {/if}
      {:else}
        <Stepper label="Duty" bind:value={f.fixedDuty} min={0} max={100} step={5} unit="%" data-testid="duty" />
      {/if}
      <Stepper label="Lowest duty" bind:value={f.minDuty} min={0} max={100} step={5} unit="%" />
      {#if vf}
        <Select label="Frequency comes from" items={items} bind:value={freqSrc} onchange={(v) => pickSrc('freqInput', v)} disabled={linking} />
        <Field label="Signal value at 400 Hz" type="number" bind:value={freqFull} min={400} step={400} onchange={setFreqFull} hint={'frequency = signal ÷ ' + (f.freqInputDenom || 1)} />
      {:else}
        <div>
          <Stepper label="Frequency" bind:value={f.freq} min={upstream ? 0 : 15} max={400} step={upstream ? 1 : 5} unit="Hz" data-testid="freq" />
          {#if upstream}<span class="hint">16 to 400 Hz; 0 = keep the current period</span>{/if}
        </div>
      {/if}
    </div>
    {#if varFreq}<Switch bind:checked={f.variableFreq} label="Frequency follows a signal" hint={upstream ? 'Advanced. 16 to 400 Hz.' : 'Advanced. 15 to 400 Hz.'} />{/if}
    {#if softStop}
      <Stepper label="Soft stop" bind:value={f.softStopTime} min={0} max={10000} step={100} unit="ms" data-testid="soft-stop" />
      <span class="muted note">{Number(f.softStopTime) > 0 ? `When its input turns off, the duty ramps down to 0 over ${f.softStopTime} ms, then it switches off. A trip, starter disable, load shedding or sleep still cuts it at once.` : '0 = off: it switches off at once.'}</span>
    {/if}
  {/if}
  <div class="soft">
    <Switch bind:checked={f.softStart} label="Soft start" hint="Ramps up when it turns on." />
    {#if f.softStart}
      <Stepper label="Ramp time" bind:value={f.softStartRamp} min={0} max={10000} step={100} unit="ms" data-testid="ramp" />
      {#if ssTimeout && f.pwmEnabled}
        <Stepper label="Must reach full duty within" bind:value={f.softStartTimeout} min={0} max={60000} step={500} unit="ms" data-testid="ss-timeout" />
        <span class="muted note" data-testid="ss-timeout-hint">{#if Number(f.softStartTimeout) > 0}Current-limited start: the ramp waits while the current is above the inrush limit ({f.inrushLimit} A) instead of tripping, and trips if it has not finished after {f.softStartTimeout} ms (a stalled motor).{#if Number(f.minDuty) === 0} Set a lowest duty the motor turns at: at 0 % a motor reads near stall current and the ramp never gets going.{/if}{#if Number(f.inrushTime) < Number(f.softStartTimeout)} The inrush time ({f.inrushTime} ms) is shorter: after it the normal trip current applies to the held ramp.{/if}{:else}0 = off: the inrush limit trips as usual during the ramp.{/if}</span>
      {/if}
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
  .hint { display: block; font-size: var(--text-xs); color: var(--color-text-muted); margin-top: 4px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3); }
  .soft { display: flex; flex-direction: column; gap: var(--space-2); max-width: 520px; }
  .crank { display: flex; flex-direction: column; gap: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--color-line); }
  .note { font-size: var(--text-xs); }
  .curve { display: flex; flex-direction: column; gap: var(--space-1); }
</style>
