<script>
  import { api, luaGet, luaSet, luaAssemble, awgFor, vDrop, WIRE_GAUGES, awgForMm2, outputRatingA, deviceDefs, _binBody } from './store.js'
  import { toast } from './toast.js'
  import { dialog, labelFields, clickable } from './a11y.js'
  import LuaEditor from './LuaEditor.svelte'
  import SearchSelect from './SearchSelect.svelte'
  let { output, outputs = [], guid, connected = false, deviceType = '', onclose } = $props()
  // Other outputs on this module, for the "Paired output" picker (-1 = none).
  let otherOutputs = $derived((outputs ?? []).filter((o) => o.number !== output.number))
  // Outputs that follow THIS one (the link is stored on the follower as a 0-based index).
  let followers = $derived((outputs ?? []).filter((o) => o.primaryOutput === output.number - 1))
  let tab = $state('rule')

  // Unpair a follower from here (the primary's side) — the link lives on the follower, so we
  // rewrite the follower's config with PrimaryOutput = -1, preserving its other settings.
  let unpairing = $state(0)
  async function unpairFollower(fl) {
    unpairing = fl.number
    try {
      const r = await api.outputConfig(guid, { ..._binBody(fl, fl.inputVal), Enabled: fl.enabled, PrimaryOutput: -1 })
      toast(r?.written ? `Unpaired O${fl.number}` : `Unpaired O${fl.number} — saved to project; Deploy when online`, r?.written ? 'ok' : 'info')
    } catch (e) { toast('Unpair failed: ' + e.message, 'error') }
    finally { unpairing = 0 }
  }

  // Pairing is primary-centric: from THIS output you pick which output(s) it drives. The link is
  // stored on the follower (its primaryOutput = this output's 0-based index) — that's the firmware's
  // model — but the UI reads "this output drives O3", not "O3 follows this". Both must be enabled.
  let driving = $state(0)
  // This output is itself a follower (it's driven by another that exists).
  let amFollower = $derived(output.primaryOutput >= 0 && (outputs ?? []).some((p) => p.number === output.primaryOutput + 1))
  // Outputs this one can drive: not itself, not already following someone, and not a primary already (no chains).
  let driveCandidates = $derived(otherOutputs.filter((o) => o.primaryOutput < 0 && !(outputs ?? []).some((x) => x.primaryOutput === o.number - 1)))
  async function driveOutput(secNum) {
    const sec = (outputs ?? []).find((o) => o.number === secNum); if (!sec) return
    driving = secNum
    autoEnableOutput()   // this output (the primary) must be enabled to drive
    try {
      const r = await api.outputConfig(guid, { ..._binBody(sec, sec.inputVal), Enabled: true, PrimaryOutput: output.number - 1 })
      toast(r?.written ? `O${secNum} now follows this output` : `O${secNum} set to follow — saved to project; Deploy when online`, r?.written ? 'ok' : 'info')
    } catch (e) { toast('Could not pair: ' + e.message, 'error') }
    finally { driving = 0 }
  }
  function unpairSelf() { f.primaryOutput = -1; toast('Made independent — Save to apply', 'info') }

  // Per-output Lua snippet (tick-body code). Stored client-side; assembled with
  // the other snippets into the one program on upload.
  let luaKey = $derived('out' + output.number)
  let luaText = $state('')
  let luaSeededFor = $state(null)
  $effect(() => {
    if (output && output.number !== luaSeededFor) { luaText = luaGet(guid, 'out' + output.number); luaSeededFor = output.number }
  })
  let luaBusy = $state(false), luaMsg = $state('')
  // Persist edits to the snippet store as they happen (once seeded for this output).
  $effect(() => { if (luaSeededFor === output.number) luaSet(guid, luaKey, luaText) })
  async function luaUpload() {
    luaSet(guid, luaKey, luaText)
    luaBusy = true; luaMsg = ''
    try {
      await api.luaUpload(guid, luaAssemble(guid))
      // A per-output snippet drives the output by writing its Lua slot (setLuaOut).
      // For that to actually turn the output on, its Rule input must point at that slot.
      // Auto-bind it here — but only if no rule is set yet, so we never clobber a real one.
      const slot = inputs.find((i) => i.name === 'Lua Out ' + output.number)
      if (slot && Number(f.input) === 0) {
        f.input = slot.index
        await save()
        luaMsg = `Uploaded ✓ — output ${output.number} is now driven by "${slot.name}". Burn to keep.`
      } else if (slot && Number(f.input) === slot.index) {
        luaMsg = 'Uploaded ✓ — Burn to keep'
      } else {
        luaMsg = `Uploaded ✓ — set this output's Rule to "Lua Out ${output.number}" to drive it from Lua. Burn to keep.`
      }
    } catch (e) { luaMsg = 'Failed: ' + e.message }
    finally { luaBusy = false }
  }

  // Selectable input sources (VarMap) for the Rule tab — loaded once per device.
  let inputs = $state([])
  // Numeric value sources (analog/CAN/scaled/counter) for variable PWM duty/freq — same set
  // SignalsView uses for a CANBoard digital output.
  let inputsNum = $state([])
  $effect(() => {
    if (!guid) { inputs = []; inputsNum = []; return }
    api.inputs(guid).then((r) => (inputs = r)).catch(() => (inputs = []))
    Promise.all([api.inputs(guid, 'float').catch(() => []), api.inputs(guid, 'int').catch(() => [])])
      .then(([f, i]) => (inputsNum = [...f, ...i])).catch(() => (inputsNum = []))
  })
  // Build SearchSelect options from a VarMap list; `none` prepends a "— (0)" entry.
  const ssOpts = (arr, none = false) => (none ? [{ value: 0, label: '—' }] : []).concat((arr ?? []).map((v) => ({ value: v.index, label: v.name })))
  // "Signal value at full" fields for the variable duty/freq denominators (free-typing local state,
  // seeded on open; the firmware denominators are derived one-way to avoid snapping while typing).
  let dutyFull = $state(100), freqFull = $state(400)
  $effect(() => {
    f.dutyCycleDenom = Math.max(1, Math.round((+dutyFull || 0) / 100))
    f.freqInputDenom = Math.max(1, Math.round((+freqFull || 0) / 400))
  })

  // Editable form, seeded from the device's read values once per opened output
  // (so live telemetry ticks don't clobber edits in progress).
  let seededFor = $state(null)
  let f = $state({})
  $effect(() => {
    if (output && output.number !== seededFor) {
      f = {
        name: output.name ?? '',
        wireColor: output.wireColor || '#e0413a',
        wireSet: !!output.wireColor,
        wireStripe: output.wireStripe || '#ffffff',
        stripeSet: !!output.wireStripe,
        wireLength: output.wireLength ?? 0,
        wireGaugeMm2: output.wireGaugeMm2 ?? 0,
        input: output.inputVal,
        enabled: output.enabled,
        currentLimit: output.currentLimit,
        inrushLimit: output.inrushLimit,
        inrushTime: output.inrushTime,
        resetMode: output.resetMode,
        resetTime: output.resetTime,
        resetCountLimit: output.resetCountLimit,
        pwmEnabled: output.pwmEnabled,
        freq: output.freq,
        fixedDuty: output.fixedDuty,
        minDuty: output.minDuty,
        softStart: output.softStart,
        softStartRamp: output.softStartRamp,
        // variable PWM (duty/freq follow a signal)
        variableDutyCycle: output.variableDutyCycle ?? false,
        dutyCycleInput: output.dutyCycleInput ?? 0,
        dutyCycleDenom: output.dutyCycleDenom ?? 100,
        variableFreq: output.variableFreq ?? false,
        freqInput: output.freqInput ?? 0,
        freqInputDenom: output.freqInputDenom ?? 1,
        rampDutyChanges: output.rampDutyChanges ?? false,
        primaryOutput: output.primaryOutput ?? -1,
        warnLimit: output.warnLimit ?? 0,
        openLoadLimit: output.openLoadLimit ?? 0,
        openLoadTime: output.openLoadTime ?? 1000,
      }
      // seed the "value at full" fields from the stored denominators (mirrors SignalsView)
      dutyFull = (output.dutyCycleDenom || 1) * 100
      freqFull = (output.freqInputDenom || 1) * 400
      seededFor = output.number
    }
  })

  let saving = $state(false), saved = $state(false), savedToDevice = $state(false)
  async function save() {
    // PWM bounds. When a source drives freq/duty the fixed numeric inputs are hidden, so only
    // validate the fixed value that's actually in use. Min-duty (0–100, ≤ fixed duty) always applies.
    if (f.pwmEnabled) {
      const minD = Math.round(+f.minDuty || 0)
      if (minD < 0 || minD > 100) { toast('Min duty must be 0–100%.', 'error'); return }
      if (!f.variableFreq) {
        const fr = Math.round(+f.freq || 0)
        if (fr < 15 || fr > 400) { toast('PWM frequency must be 15–400 Hz.', 'error'); return }
        f.freq = fr
      }
      if (!f.variableDutyCycle) {
        const duty = Math.round(+f.fixedDuty || 0)
        if (duty < 0 || duty > 100) { toast('Duty must be 0–100%.', 'error'); return }
        if (minD > duty) { toast(`Min duty (${minD}%) can't exceed duty (${duty}%).`, 'error'); return }
        f.fixedDuty = duty
      }
      f.minDuty = minD
    }
    saving = true; saved = false
    try {
      const r = await api.outputConfig(guid, {
        Number: output.number,
        Name: f.name,
        WireColor: f.wireSet ? f.wireColor : '',
        WireStripe: f.stripeSet ? f.wireStripe : '',
        WireLength: Number(f.wireLength) || 0,
        WireGaugeMm2: Number(f.wireGaugeMm2) || 0,
        Enabled: f.enabled,
        Input: Number(f.input),
        CurrentLimit: Number(f.currentLimit),
        InrushLimit: Number(f.inrushLimit),
        InrushTime: Number(f.inrushTime),
        ResetMode: Number(f.resetMode),
        ResetTime: Number(f.resetTime),
        ResetCountLimit: Number(f.resetCountLimit),
        PwmEnabled: f.pwmEnabled,
        Freq: Number(f.freq),
        FixedDuty: Number(f.fixedDuty),
        MinDuty: Number(f.minDuty),
        SoftStart: f.softStart,
        SoftStartRamp: Number(f.softStartRamp),
        VariableDutyCycle: !!f.variableDutyCycle,
        DutyCycleInput: Number(f.dutyCycleInput) || 0,
        DutyCycleDenom: Math.max(1, Number(f.dutyCycleDenom) || 1),
        VariableFreq: !!f.variableFreq,
        FreqInput: Number(f.freqInput) || 0,
        FreqInputDenom: Math.max(1, Number(f.freqInputDenom) || 1),
        RampDutyChanges: !!f.rampDutyChanges,
        PrimaryOutput: Number(f.primaryOutput ?? -1),
        WarnLimit: Number(f.warnLimit),
        OpenLoadLimit: Number(f.openLoadLimit),
        OpenLoadTime: Number(f.openLoadTime),
      })
      // The backend always saves the config to the project, but only writes it to the module
      // over CAN when it's live (r.written). Report which actually happened — don't claim a
      // device write that never left the host.
      saved = true; savedToDevice = !!r?.written
      toast(r?.written
        ? `Saved output ${output.number} to device`
        : `Saved output ${output.number} to the project — module offline; Deploy when it's on the bus`, r?.written ? 'ok' : 'info')
    } catch (e) { toast('Save failed: ' + e.message, 'error') }
    finally { saving = false }
  }

  // When the operator configures an output that's still disabled, flip it on — a configured-but-off
  // channel is almost always a mistake. Toast so it's not silent.
  function autoEnableOutput() {
    if (f.enabled === false) { f.enabled = true; toast(`Output ${output.number} enabled — you configured it`, 'ok') }
  }

  // Picking a source that points at a disabled function won't drive anything — enable that source too.
  let _funcs = $state(null)
  const SRC_ARRS = [['inputs','input'],['canInputs','caninput'],['virtualInputs','virtualinput'],['conditions','condition'],['counters','counter'],['flashers','flasher']]
  async function enableSourceVar(idx) {
    idx = Number(idx); if (!idx) return
    const label = inputs.find((v) => v.index === idx)?.name; if (!label) return
    if (!_funcs) { try { _funcs = await api.functions(guid) } catch { return } }
    for (const [arr, kind] of SRC_ARRS) {
      const fn = (_funcs?.[arr] ?? []).find((x) => label === x.name || label.startsWith(x.name + ' '))
      if (fn) { if (fn.enabled === false) { try { await api.setFunction(guid, kind, fn.number, { enabled: true }); fn.enabled = true; toast(`Enabled "${fn.name}" — it was off`, 'ok') } catch (e) { toast('Could not enable source: ' + e.message, 'error') } } return }
    }
  }
</script>

<div class="scrim show" onclick={onclose}></div>
<aside class="drawer show" use:dialog={{ onclose }}>
  <div class="dh">
    <div>
      <div class="nm">{output.name?.trim() ? output.name : 'Output ' + output.number}</div>
      <div class="meta">Output {output.number}
        <span class="state {output.state === 'On' ? 'on' : output.state === 'Fault' ? 'fault' : output.state === 'Overcurrent' || output.state === 'Warning' || output.state === 'OpenLoad' ? 'oc' : 'off'}" style="transform:scale(.9)"><span class="ic"></span>{output.state} · {(output.current ?? 0).toFixed(1)} A</span></div>
    </div>
    <button class="x" aria-label="Close" onclick={onclose}>✕</button>
  </div>

  <div class="tabs" role="tablist">
    <span class="t" role="tab" tabindex="0" aria-selected={tab === 'rule'} use:clickable class:active={tab === 'rule'} onclick={() => (tab = 'rule')}>Rule</span>
    <span class="t" role="tab" tabindex="0" aria-selected={tab === 'prot'} use:clickable class:active={tab === 'prot'} onclick={() => (tab = 'prot')}>Protection</span>
    <span class="t" role="tab" tabindex="0" aria-selected={tab === 'wiring'} use:clickable class:active={tab === 'wiring'} onclick={() => (tab = 'wiring')}>Wiring</span>
    <span class="t" role="tab" tabindex="0" aria-selected={tab === 'lua'} use:clickable class:active={tab === 'lua'} onclick={() => (tab = 'lua')}>Lua</span>
  </div>

  {#if tab === 'rule'}
    <div class="dbody" use:labelFields>
      <div class="field"><label>Name</label><input type="text" maxlength="32" placeholder={'Output ' + output.number} bind:value={f.name} /></div>
      <label class="opt" style="border:0;padding-top:0"><input type="checkbox" bind:checked={f.enabled} /> Output enabled <span class="desc">master on/off for this channel</span></label>
      <p class="lbl">Turn ON when this source is true</p>
      <div class="field"><label>Driving input</label>
        <SearchSelect placeholder="Search input…"
          options={inputs.length ? inputs.map((i) => ({ value: i.index, label: i.name })) : [{ value: output.inputVal, label: output.input }]}
          bind:value={f.input} onpick={(v) => { autoEnableOutput(); enableSourceVar(v) }} /></div>
      <div class="preview">⚡ Right now this output is <b class="big">{output.state}</b></div>
      <p class="hint">The dingoPDM drives each output from one source (a digital input, CAN signal, virtual
        input, condition, flasher, …). Pick a virtual input or condition to combine several signals —
        build those in <b>Signals &amp; logic</b>. Save writes to the device; <b>Burn</b> persists to flash.</p>

      <p class="lbl" style="margin-top:18px">PWM / dimming</p>
      <label class="opt" style="border:0;padding-top:0"><input type="checkbox" bind:checked={f.pwmEnabled} onchange={autoEnableOutput} /> PWM enabled <span class="desc">duty instead of on/off</span></label>
      {#if f.pwmEnabled}
        <label class="chk"><input type="checkbox" bind:checked={f.variableDutyCycle} onchange={autoEnableOutput} /> Duty follows a signal <span class="desc">analog dimming — from a CAN value or an analog input</span></label>
        <label class="chk"><input type="checkbox" bind:checked={f.variableFreq} onchange={autoEnableOutput} /> Freq follows a signal <span class="desc">PWM frequency from an analog/CAN value</span></label>
        <div class="f3">
          {#if f.variableFreq}
            <div class="field"><label>Freq source</label>
              <SearchSelect options={ssOpts(inputsNum, true)} bind:value={f.freqInput} placeholder="Search value…" onpick={(v) => { autoEnableOutput(); enableSourceVar(v) }} /></div>
          {:else}
            <div class="field"><label>Freq (Hz)</label><input type="number" min="15" max="400" bind:value={f.freq} title="PWM frequency, 15–400 Hz. For dimming lights, 100–500 Hz is flicker-free (200 Hz is a good all-rounder for LED and incandescent). Below 15 Hz the output stops; above 400 Hz the firmware ignores the change." /></div>
          {/if}
          {#if f.variableDutyCycle}
            <div class="field"><label>Duty source</label>
              <SearchSelect options={ssOpts(inputsNum, true)} bind:value={f.dutyCycleInput} placeholder="Search value…" onpick={(v) => { autoEnableOutput(); enableSourceVar(v) }} /></div>
          {:else}
            <div class="field"><label>Duty (%)</label><input type="number" min="0" max="100" bind:value={f.fixedDuty} /></div>
          {/if}
          <div class="field"><label>Min duty (%)</label><input type="number" min="0" max="100" bind:value={f.minDuty} /></div>
        </div>
        {#if f.variableDutyCycle}
          <div class="field" style="max-width:260px"><label>Signal value at 100% duty</label>
            <input type="number" min="1" bind:value={dutyFull} /></div>
          <p class="hint">Duty tracks the source: <b>duty% = signal ÷ {f.dutyCycleDenom || 1}</b>, clamped 0–100 then held at the min-duty floor.
            Set the value above to whatever the signal reads at full brightness (e.g. a 0–5000&nbsp;mV analog → 5000). Any numeric signal works — CAN or analog.</p>
        {/if}
        {#if f.variableFreq}
          <div class="field" style="max-width:260px"><label>Signal value at 400 Hz</label>
            <input type="number" min="1" bind:value={freqFull} /></div>
          <p class="hint"><b>Freq = signal ÷ {f.freqInputDenom || 1}</b>, clamped to 15–400 Hz. Set the value above to the signal reading that should give full 400 Hz.</p>
        {/if}
      {/if}
      <label class="opt"><input type="checkbox" bind:checked={f.softStart} /> Soft start <span class="desc">ramp up on turn-on</span></label>
      <div class="field" style="max-width:230px"><label>Soft-start ramp (ms)</label><input type="number" min="0" bind:value={f.softStartRamp} /></div>
      {#if f.softStart && f.variableDutyCycle}
        <label class="opt"><input type="checkbox" bind:checked={f.rampDutyChanges} /> Ramp duty changes <span class="desc">slew on every change, not just turn-on — a full 0–100% takes the soft-start ramp time</span></label>
      {/if}
    </div>
  {:else if tab === 'prot'}
    {@const rating = outputRatingA($deviceDefs, deviceType, output.number)}
    <div class="dbody" use:labelFields>
      <p class="lbl">Current protection</p>
      <div class="f2">
        <div class="field"><label>Current limit (A)</label><input type="number" step="0.1" bind:value={f.currentLimit} /></div>
        <div class="field"><label>Inrush allow (A)</label><input type="number" step="0.1" bind:value={f.inrushLimit} /></div>
      </div>
      {#if rating}<p class="hint" style="margin-top:6px">OUT{output.number} hardware channel rating: <b>{rating} A</b> max continuous.
        {#if Number(f.currentLimit) > rating}<b style="color:var(--err)"> Your {f.currentLimit} A trip is above the channel rating — allowed, but size the wiring and load to suit.</b>{/if}</p>{/if}
      <div class="field" style="max-width:230px"><label>Inrush time (ms)</label><input type="number" min="0" bind:value={f.inrushTime} /></div>

      <p class="lbl" style="margin-top:18px">Warning &amp; open-load (report only — output keeps running)</p>
      <div class="f2">
        <div class="field"><label>Warn above (A)</label><input type="number" step="0.1" bind:value={f.warnLimit} /></div>
        <div class="field"><label>Open-load below (A)</label><input type="number" step="0.1" bind:value={f.openLoadLimit} /></div>
      </div>
      <div class="field" style="max-width:230px"><label>Open-load debounce (ms)</label><input type="number" bind:value={f.openLoadTime} /></div>
      <p class="hint" style="margin-top:6px">0 disables. <b>Warn</b> flags when current exceeds this but is below the trip limit.
        <b>Open-load</b> flags a broken bulb / missing load: on, past inrush, but current stays below this floor. Both just
        report (state + CAN message) — they don't switch the output off.</p>

      <p class="lbl" style="margin-top:18px">Retry after a fault</p>
      <div class="field"><label>Reset mode</label>
        <select bind:value={f.resetMode}>
          <option value={0}>None — latch off</option>
          <option value={1}>Retry, limited count</option>
          <option value={2}>Retry, endless</option>
        </select></div>
      <div class="f2">
        <div class="field"><label>Retry count</label><input type="number" min="0" bind:value={f.resetCountLimit} /></div>
        <div class="field"><label>Retry interval (ms)</label><input type="number" min="0" bind:value={f.resetTime} /></div>
      </div>

      <p class="lbl" style="margin-top:18px">Output pairing</p>
      {#if amFollower}
        <p class="hint" style="margin-top:0">This output is a <b>follower</b> of <b>output{output.primaryOutput + 1}</b> — it mirrors that output's on/off + PWM and <b>ignores its own rule</b>.
          <button type="button" class="linkbtn" style="margin-left:6px" onclick={unpairSelf}>make independent</button></p>
      {:else}
        <div class="field" style="max-width:300px"><label>Also drive another output</label>
          <select value="-1" disabled={driving > 0} onchange={(e) => { const n = Number(e.target.value); e.target.value = '-1'; if (n > 0) driveOutput(n) }}>
            <option value="-1">— pick an output to drive —</option>
            {#each driveCandidates as o}<option value={o.number}>O{o.number}{o.name?.trim() ? ' · ' + o.name : ''}</option>{/each}
          </select></div>
        <p class="hint" style="margin-top:6px">Make another output a <b>follower</b> of this one — it mirrors this output's on/off + PWM and <b>ignores its own rule</b> (e.g. two channels feeding one high-current load). Both outputs are enabled automatically.</p>
        {#if followers.length}
          <p class="hint" style="margin-top:8px"><b>This output drives:</b>
            {#each followers as fl}<span class="tag pair" style="margin-left:4px">O{fl.number}{fl.name?.trim() ? ' · ' + fl.name : ''} <button type="button" class="linkbtn" style="margin-left:5px" disabled={unpairing === fl.number} onclick={() => unpairFollower(fl)}>{unpairing === fl.number ? 'removing…' : 'remove'}</button></span>{/each}</p>
        {/if}
      {/if}

      <p class="hint">Live current now: <b>{(output.current ?? 0).toFixed(1)} A</b>. Save writes to the device; click <b>Burn</b> to persist to flash.</p>
    </div>
  {:else if tab === 'wiring'}
    {@const wire = awgFor(f.currentLimit)}
    {@const effMm2 = Number(f.wireGaugeMm2) > 0 ? Number(f.wireGaugeMm2) : wire?.mm2}
    {@const effAwg = Number(f.wireGaugeMm2) > 0 ? awgForMm2(f.wireGaugeMm2) : wire?.awg}
    {@const vd = vDrop(f.wireLength, f.currentLimit, effMm2)}
    <div class="dbody" use:labelFields>
      <p class="lbl">Gauge</p>
      {#if wire}
        <div class="wire-box">
          <div class="wire-row"><span class="wk">Recommended ({f.currentLimit} A trip)</span><span class="wv">≥ {wire.awg} AWG · {wire.mm2} mm²</span></div>
        </div>
        <div class="field" style="max-width:300px;margin-top:10px"><label>Gauge used (override)</label>
          <select bind:value={f.wireGaugeMm2}>
            <option value={0}>Auto — use recommended ({wire.mm2} mm²)</option>
            {#each WIRE_GAUGES as g}<option value={g.mm2}>{g.mm2} mm² ({g.awg} AWG){g.mm2 < wire.mm2 ? ' — under recommended ⚠' : ''}</option>{/each}
          </select></div>
        <p class="hint" style="margin-top:6px">Recommendation is sized to the current limit so the wire is never the weak link. Override to the gauge you actually run — voltage drop below uses it.</p>
        <p class="hint muted" style="margin-top:2px;font-size:11px">Sizing is a lookup table mapping trip current → gauge, not a thermal model. It ignores ambient temperature, bundling, run length and insulation rating — verify against your wiring standard for long runs or hot environments.</p>
      {:else}<p class="muted">Set a current limit on the Protection tab first.</p>{/if}

      <p class="lbl" style="margin-top:18px">Wire colour</p>
      <div class="f2">
        <div class="field"><label>Base</label>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="color" style="width:42px;height:34px;padding:2px;border:1px solid var(--line-2);border-radius:8px;background:none" bind:value={f.wireColor} oninput={() => (f.wireSet = true)} />
            <span class="muted" style="font-family:var(--mono);font-size:12px">{f.wireSet ? f.wireColor : 'none'}</span>
            {#if f.wireSet}<button type="button" class="linkbtn" onclick={() => (f.wireSet = false)}>clear</button>{/if}
          </div></div>
        <div class="field"><label>Stripe</label>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="color" style="width:42px;height:34px;padding:2px;border:1px solid var(--line-2);border-radius:8px;background:none" bind:value={f.wireStripe} oninput={() => (f.stripeSet = true)} disabled={!f.wireSet} title={f.wireSet ? '' : 'Set a base colour first'} />
            <span class="muted" style="font-family:var(--mono);font-size:12px">{f.stripeSet ? f.wireStripe : 'none'}</span>
            {#if f.stripeSet}<button type="button" class="linkbtn" onclick={() => (f.stripeSet = false)}>clear</button>{/if}
          </div></div>
      </div>
      {#if f.wireSet}
        <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
          <span class="swatch-lg" style="background:{f.stripeSet ? `repeating-linear-gradient(135deg, ${f.wireColor} 0 8px, ${f.wireStripe} 8px 12px)` : f.wireColor}"></span>
          <span class="muted">preview</span>
        </div>
      {/if}

      <p class="lbl" style="margin-top:18px">Run length &amp; voltage drop</p>
      <div class="field" style="max-width:230px"><label>Wire length one-way (m)</label><input type="number" step="0.1" min="0" bind:value={f.wireLength} /></div>
      {#if vd}
        <div class="wire-box">
          <div class="wire-row"><span class="wk">Voltage drop at {f.currentLimit} A</span><span class="wv {vd.pct > 3 ? 'warn' : ''}">{vd.volts.toFixed(2)} V · {vd.pct.toFixed(1)}%</span></div>
          <div class="wire-row sub"><span class="wk">{f.wireLength} m run · {effMm2} mm² / {effAwg} AWG · feed + return</span><span class="wv">of 13.8 V</span></div>
        </div>
        <p class="hint" style="margin-top:6px">Rule of thumb: keep drop under <b>3%</b> (~0.4 V) for lighting/sensitive loads, under 10% for motors/heaters.
          {#if vd.pct > 3}<b style="color:var(--err)"> Over 3% — consider a heavier gauge or shorter run.</b>{/if}</p>
        <p class="hint muted" style="margin-top:2px;font-size:11px">Estimate only: assumes copper (ρ≈0.0175 Ω·mm²/m) at a 13.8 V system, feed + return (2× the one-way length), and ignores connector/terminal resistance and temperature.</p>
      {:else}<p class="hint">Enter a length to estimate voltage drop at the current limit.</p>{/if}
    </div>
  {:else}
    <div class="dbody" use:labelFields>
      <p class="lbl">Lua for output {output.number} — runs every tick</p>
      <LuaEditor bind:value={luaText} minHeight={200}
        placeholder={`-- drive output ${output.number} via its Lua slot\nsetLuaOut(${output.number - 1}, readVar(1))`} />
      <p class="hint">This snippet is merged into the device's single Lua program (with every other
        output's snippet and the global section under <b>Signals &amp; logic ▸ Lua program</b>). To
        drive this output, write its Lua slot with <code>setLuaOut({output.number - 1}, v)</code> and
        set this output's <b>Rule</b> input to that Lua slot.</p>
      {#if !connected}<p class="hint" style="color:var(--muted)">Module offline — this snippet is saved locally; connect the module to upload it.</p>{/if}
      {#if luaMsg}<p class="hint"><b>{luaMsg}</b></p>{/if}
    </div>
  {/if}

  <div class="dfoot">
    <span class="res">{saved ? (savedToDevice ? 'written ✓' : 'saved to project ✓') : 'output ' + output.number}</span><span style="margin-left:auto"></span>
    <button class="btn ghost" onclick={onclose}>Close</button>
    {#if tab === 'lua'}
      <button class="btn primary" disabled={luaBusy || !connected} title={connected ? '' : 'Connect the module to upload Lua'} onclick={luaUpload}>{luaBusy ? 'Uploading…' : 'Upload program'}</button>
    {:else}
      <button class="btn primary" disabled={saving} onclick={save}>{saving ? 'Saving…' : (connected ? 'Save to device' : 'Save to project')}</button>
    {/if}
  </div>
</aside>
