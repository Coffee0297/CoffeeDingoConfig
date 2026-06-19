<script>
  import { api, luaGet, luaSet, luaAssemble } from './store.js'
  import { toast } from './toast.js'
  import { dialog, labelFields, clickable } from './a11y.js'
  import LuaEditor from './LuaEditor.svelte'
  let { output, guid, onclose } = $props()
  let tab = $state('rule')

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
  $effect(() => {
    if (!guid) { inputs = []; return }
    api.inputs(guid).then((r) => (inputs = r)).catch(() => (inputs = []))
  })

  // Editable form, seeded from the device's read values once per opened output
  // (so live telemetry ticks don't clobber edits in progress).
  let seededFor = $state(null)
  let f = $state({})
  $effect(() => {
    if (output && output.number !== seededFor) {
      f = {
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
        warnLimit: output.warnLimit ?? 0,
        openLoadLimit: output.openLoadLimit ?? 0,
        openLoadTime: output.openLoadTime ?? 1000,
      }
      seededFor = output.number
    }
  })

  let saving = $state(false), saved = $state(false)
  async function save() {
    saving = true; saved = false
    try {
      await api.outputConfig(guid, {
        Number: output.number,
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
        WarnLimit: Number(f.warnLimit),
        OpenLoadLimit: Number(f.openLoadLimit),
        OpenLoadTime: Number(f.openLoadTime),
      })
      saved = true
      toast(`Saved output ${output.number} to device`, 'ok')
    } catch (e) { toast('Write failed: ' + e.message, 'error') }
    finally { saving = false }
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
    <span class="t" role="tab" tabindex="0" aria-selected={tab === 'lua'} use:clickable class:active={tab === 'lua'} onclick={() => (tab = 'lua')}>Lua</span>
  </div>

  {#if tab === 'rule'}
    <div class="dbody" use:labelFields>
      <label class="opt" style="border:0;padding-top:0"><input type="checkbox" bind:checked={f.enabled} /> Output enabled <span class="desc">master on/off for this channel</span></label>
      <p class="lbl">Turn ON when this source is true</p>
      <div class="field"><label>Driving input</label>
        <select bind:value={f.input}>
          {#each inputs as i}<option value={i.index}>{i.name}</option>{/each}
          {#if inputs.length === 0}<option value={output.inputVal}>{output.input}</option>{/if}
        </select></div>
      <div class="preview">⚡ Right now this output is <b class="big">{output.state}</b></div>
      <p class="hint">The dingoPDM drives each output from one source (a digital input, CAN signal, virtual
        input, condition, flasher, …). Pick a virtual input or condition to combine several signals —
        build those in <b>Signals &amp; logic</b>. Save writes to the device; <b>Burn</b> persists to flash.</p>
    </div>
  {:else if tab === 'prot'}
    <div class="dbody" use:labelFields>
      <p class="lbl">Current protection</p>
      <div class="f2">
        <div class="field"><label>Current limit (A)</label><input type="number" step="0.1" bind:value={f.currentLimit} /></div>
        <div class="field"><label>Inrush allow (A)</label><input type="number" step="0.1" bind:value={f.inrushLimit} /></div>
      </div>
      <div class="field" style="max-width:230px"><label>Inrush time (ms)</label><input type="number" bind:value={f.inrushTime} /></div>

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
        <div class="field"><label>Retry count</label><input type="number" bind:value={f.resetCountLimit} /></div>
        <div class="field"><label>Retry interval (ms)</label><input type="number" bind:value={f.resetTime} /></div>
      </div>
      <p class="lbl" style="margin-top:18px">PWM / dimming</p>
      <label class="opt" style="border:0;padding-top:0"><input type="checkbox" bind:checked={f.pwmEnabled} /> PWM enabled <span class="desc">duty instead of on/off</span></label>
      <div class="f3">
        <div class="field"><label>Freq (Hz)</label><input type="number" bind:value={f.freq} /></div>
        <div class="field"><label>Duty (%)</label><input type="number" bind:value={f.fixedDuty} /></div>
        <div class="field"><label>Min duty (%)</label><input type="number" bind:value={f.minDuty} /></div>
      </div>
      <label class="opt"><input type="checkbox" bind:checked={f.softStart} /> Soft start <span class="desc">ramp up on turn-on</span></label>
      <div class="field" style="max-width:230px"><label>Soft-start ramp (ms)</label><input type="number" bind:value={f.softStartRamp} /></div>
      <p class="hint">Live current now: <b>{output.current.toFixed(1)} A</b>. Save writes to the device; click <b>Burn</b> to persist to flash.</p>
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
      {#if luaMsg}<p class="hint"><b>{luaMsg}</b></p>{/if}
    </div>
  {/if}

  <div class="dfoot">
    <span class="res">{saved ? 'written ✓' : 'output ' + output.number}</span><span style="margin-left:auto"></span>
    <button class="btn ghost" onclick={onclose}>Close</button>
    {#if tab === 'lua'}
      <button class="btn primary" disabled={luaBusy} onclick={luaUpload}>{luaBusy ? 'Uploading…' : 'Upload program'}</button>
    {:else}
      <button class="btn primary" disabled={saving} onclick={save}>{saving ? 'Writing…' : 'Save to device'}</button>
    {/if}
  </div>
</aside>
