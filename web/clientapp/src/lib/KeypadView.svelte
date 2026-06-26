<script>
  import { api } from './store.js'
  import { toast } from './toast.js'
  import { dialog, labelFields, clickable } from './a11y.js'
  let { device, devices = [] } = $props()

  const hex = (n) => '0x' + (n ?? 0).toString(16).toUpperCase().padStart(3, '0')
  const COLORS = ['Off', 'Red', 'Green', 'Orange', 'Blue', 'Violet', 'Cyan', 'White']
  const swatch = ['#37474f', '#d32f2f', '#2e7d32', '#ff9800', '#1565c0', '#7e57c2', '#26c6da', '#eceff1']
  // button count per keypad model id (from the original GetDimensionsForModel)
  const MODEL_BTNS = { 0: 2, 1: 4, 2: 5, 3: 6, 4: 8, 5: 10, 6: 12, 7: 15, 8: 13, 9: 18, 10: 1, 20: 6, 21: 8, 22: 12, 23: 15, 24: 20 }

  // Candidate controlling PDMs (a keypad's button config lives on a PDM keypad master).
  let pdms = $derived(devices.filter((d) => !/keypad|dbc|canboard|can.?board/i.test(d.type)))

  let ctrl = $state(null)   // { guid, name, masterIndex, master }
  let inputsBool = $state([])
  let msg = $state('')
  // The button map lives on the controlling PDM; writes reach hardware only when that PDM is live.
  let live = $derived(!!devices.find((d) => d.guid === ctrl?.guid)?.connected)

  async function resolve() {
    if (!pdms.length) { ctrl = null; msg = 'No dingoPDM in the project. Add the PDM that controls this keypad, then enable a keypad on it.'; return }
    // Prefer a PDM whose keypad master id matches this keypad's node id; else first PDM's keypad 1.
    for (const p of pdms) {
      try {
        const fns = await api.functions(p.guid)
        const masters = fns.keypads ?? []
        let idx = masters.findIndex((m) => m.enabled && m.id === device.baseId)
        if (idx < 0 && p === pdms[0]) idx = 0   // fallback: first PDM, keypad 1
        if (idx >= 0) {
          inputsBool = await api.inputs(p.guid, 'bool')
          ctrl = { guid: p.guid, name: p.name, masterIndex: idx, master: masters[idx] }   // assign once, no transient null
          msg = masters[idx].enabled ? '' : `Using ${p.name} · keypad ${idx + 1} — enable it and set its node ID to ${hex(device.baseId)} to bind this keypad.`
          return
        }
      } catch {}
    }
    ctrl = null; msg = 'Could not read keypad config from a PDM yet.'
  }
  // Re-resolve only on stable changes (not every telemetry tick); skip while editing.
  $effect(() => { device?.guid; pdms.length; if (!editing) resolve() })

  let btnCount = $derived(ctrl ? (MODEL_BTNS[ctrl.master.model] ?? 12) : 0)
  let buttons = $derived(ctrl ? ctrl.master.buttons.slice(0, btnCount) : [])

  // editor
  let editing = $state(null), f = $state({}), saving = $state(false)
  // Normalise a per-state array to exactly 4 entries so the 4 LED-state rows always bind cleanly.
  const pad4 = (a, fill) => { const out = Array.isArray(a) ? a.slice(0, 4) : []; while (out.length < 4) out.push(fill); return out }
  function edit(b) {
    editing = b
    f = JSON.parse(JSON.stringify(b))
    f.valColors = pad4(f.valColors, 0); f.valVars = pad4(f.valVars, 0)
    f.valBlink = pad4(f.valBlink, false); f.blinkColors = pad4(f.blinkColors, 0)
  }
  const varName = (idx) => inputsBool.find((v) => v.index === idx)?.name ?? (idx ? `#${idx}` : '—')
  async function save() {
    if (!ctrl || !editing) return
    saving = true
    try {
      const number = ctrl.masterIndex * 32 + editing.number
      const r = await api.setFunction(ctrl.guid, 'keypadbutton', number, { ...f, enabled: true })
      await resolve()
      toast(r?.written
        ? `Saved button ${editing.number} to ${ctrl.name}`
        : `Saved button ${editing.number} to the project — ${ctrl.name} offline; Deploy when connected`, r?.written ? 'ok' : 'info')
      editing = null
    } catch (e) { toast('Save failed: ' + e.message, 'error') } finally { saving = false }
  }

  // ---- CANopen SDO: the keypad's own persistent settings (separate from the PDM-driven
  // runtime LED/button traffic). Node id = this keypad's base id. ----
  let node = $derived(device?.baseId ?? 0)
  let sdoBusy = $state(false), sdoMsg = $state('')
  let identity = $state(null)   // { vendor, product, revision, serial, deviceType }
  // expert read/write
  let exIdx = $state('0x2200'), exSub = $state(0), exSize = $state(4), exVal = $state(0), exRead = $state('')

  async function readIdentity() {
    sdoBusy = true; sdoMsg = ''
    try {
      const rd = async (i, s) => { const r = await api.sdoRead(node, i, s); if (!r.ok) throw new Error(r.error || ('abort 0x' + (r.abort >>> 0).toString(16))); return r.value >>> 0 }
      const deviceType = await rd(0x1000, 0)
      const vendor = await rd(0x1018, 1), product = await rd(0x1018, 2), revision = await rd(0x1018, 3), serial = await rd(0x1018, 4)
      identity = { deviceType, vendor, product, revision, serial }
      sdoMsg = 'Read OK'
    } catch (e) { sdoMsg = 'Read failed: ' + e.message; identity = null }
    finally { sdoBusy = false }
  }
  async function expertRead() {
    sdoBusy = true; sdoMsg = ''; exRead = ''
    try {
      const r = await api.sdoRead(node, parseInt(String(exIdx).replace(/^0x/i, ''), 16), Number(exSub))
      exRead = r.ok ? ('0x' + (r.value >>> 0).toString(16) + ' (' + (r.value >>> 0) + ')') : ('✗ ' + (r.error || 'abort 0x' + (r.abort >>> 0).toString(16)))
    } catch (e) { exRead = '✗ ' + e.message }
    finally { sdoBusy = false }
  }
  async function expertWrite() {
    // Validate the value fits the chosen byte size BEFORE writing — silently truncating an
    // out-of-range value to a keypad's node id / baud rate is high-consequence.
    const v = Number(exVal), size = Number(exSize)
    if (!Number.isInteger(v) || v < 0) { sdoMsg = 'Value must be a non-negative integer.'; return }
    const max = size >= 4 ? 0xFFFFFFFF : (2 ** (size * 8) - 1)
    if (v > max) { sdoMsg = `${v} doesn't fit in ${size} byte${size > 1 ? 's' : ''} (max ${max}). Pick a larger size or a smaller value.`; return }
    if (!confirm(`Write ${v} (0x${v.toString(16).toUpperCase()}, ${size} byte${size > 1 ? 's' : ''}) to ${exIdx}:${exSub} on node ${node}? Wrong object-dictionary writes can change the keypad's node id or baud rate.`)) return
    const idx = parseInt(String(exIdx).replace(/^0x/i, ''), 16)
    // Blink Marine PKP node-id (0x2110) / bitrate (0x2111) — changing these re-homes the keypad on
    // the bus, so `node` (derived from device.baseId) goes stale and later SDOs target the old node.
    const reHomes = idx === 0x2110 || idx === 0x2111
    sdoBusy = true; sdoMsg = ''
    try {
      const r = await api.sdoWrite(node, idx, Number(exSub), v >>> 0, size)
      sdoMsg = r.ok ? 'Write OK' : ('Write failed: ' + (r.error || 'abort 0x' + (r.abort >>> 0).toString(16)))
      if (r.ok && reHomes) toast('Node ID / baud changed — rediscover the keypad so later writes target the new node.', 'info', 8000)
    } catch (e) { sdoMsg = 'Write failed: ' + e.message }
    finally { sdoBusy = false }
  }
  async function sdoStore() {
    if (!confirm(`Save the keypad's parameters to non-volatile memory (node ${node})?`)) return
    sdoBusy = true; sdoMsg = ''
    try { const r = await api.sdoStore(node); sdoMsg = r.ok ? 'Stored to NV ✓' : ('Store failed: ' + (r.error || 'abort 0x' + (r.abort >>> 0).toString(16))) }
    catch (e) { sdoMsg = 'Store failed: ' + e.message }
    finally { sdoBusy = false }
  }
</script>

<div class="h-row">
  <div><h1>{device.name} · {device.type}</h1>
    <p class="sub">Each button is an input you can use anywhere; its LED is an output that can mirror any signal. Click a button to edit it.</p></div>
</div>

{#if msg}<div class="sys-alert" style="margin-bottom:14px">⚠ {msg}</div>{/if}

{#if ctrl}
  <div class="cat-grp">Buttons <span style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted)">— on {ctrl.name} · keypad {ctrl.masterIndex + 1}</span><span class="ct"></span></div>
  <div class="kpad">
    {#each buttons as b}
      {@const col = b.valColors?.[0] ?? 0}
      <div class="kbtn" style="cursor:pointer" use:clickable aria-label={"Edit button " + b.number} onclick={() => edit(b)}>
        <span class="kn">{b.number}</span>
        <span class="led" style="background:{swatch[col]}{col ? `;box-shadow:0 0 9px ${swatch[col]}` : ''}"></span>
        <span class="kl">{b.enabled ? b.name : 'button' + b.number}</span>
      </div>
    {/each}
  </div>

  <div class="cat-grp">Button map <span class="ct"></span></div>
  <table class="logtable" style="font-family:inherit">
    <thead><tr><th>#</th><th>Name</th><th>Action</th><th>Enabled</th><th>LED colour</th><th>LED shows</th></tr></thead>
    <tbody>
      {#each buttons as b}
        <tr style="cursor:pointer" use:clickable onclick={() => edit(b)}>
          <td>{b.number}</td><td>{b.name}</td><td>{b.mode === 1 ? 'Toggle' : 'Momentary'}</td>
          <td>{b.enabled ? 'yes' : '—'}</td>
          <td><span class="ledcell"><span class="ledswatch" style="background:{swatch[b.valColors?.[0] ?? 0]}"></span>{COLORS[b.valColors?.[0] ?? 0]}</span></td>
          <td>{varName(b.valVars?.[0])}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<div class="cat-grp">Keypad device settings (CANopen SDO)
  <span style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted)">— node {hex(node)} · the keypad's own persistent config</span><span class="ct"></span></div>
<div class="card flat" style="padding:14px">
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <button class="btn" disabled={sdoBusy || !node} onclick={readIdentity}>Read identity</button>
    <button class="btn ghost" disabled={sdoBusy || !node} onclick={sdoStore}>Save to keypad NV</button>
    {#if sdoMsg}<span class="muted">{sdoMsg}</span>{/if}
  </div>
  {#if identity}
    <table class="logtable" style="font-family:inherit;margin-top:10px;max-width:420px">
      <tbody>
        <tr><td>Device type</td><td>0x{(identity.deviceType >>> 0).toString(16)}</td></tr>
        <tr><td>Vendor ID</td><td>0x{(identity.vendor >>> 0).toString(16)}</td></tr>
        <tr><td>Product code</td><td>0x{(identity.product >>> 0).toString(16)}</td></tr>
        <tr><td>Revision</td><td>0x{(identity.revision >>> 0).toString(16)}</td></tr>
        <tr><td>Serial</td><td>0x{(identity.serial >>> 0).toString(16)}</td></tr>
      </tbody>
    </table>
  {/if}

  <p class="lbl" style="margin-top:16px">Expert: read / write any object</p>
  <div class="f3" style="align-items:end">
    <div class="field"><label>Index (hex)</label><input bind:value={exIdx} placeholder="0x2200" /></div>
    <div class="field"><label>Sub</label><input type="number" min="0" max="255" bind:value={exSub} /></div>
    <div class="field"><label>Size (write)</label><select bind:value={exSize}><option value={1}>1</option><option value={2}>2</option><option value={4}>4</option></select></div>
  </div>
  <div class="f3" style="align-items:end">
    <div class="field"><label>Value (write)</label><input type="number" bind:value={exVal} /></div>
    <button class="btn ghost" disabled={sdoBusy || !node} onclick={expertRead}>Read</button>
    <button class="btn" disabled={sdoBusy || !node} onclick={expertWrite}>Write</button>
  </div>
  {#if exRead}<p style="font-family:var(--mono);margin-top:6px">= {exRead}</p>{/if}
  <p class="hint" style="margin-top:8px">Expedited SDO (≤4 bytes). Use your keypad's CANopen object-dictionary reference for manufacturer-specific
    indices (brightness, startup behaviour, etc.). After changing settings, press <b>Save to keypad NV</b> so they survive a power cycle.
    Identity (0x1018) and device type (0x1000) are universal and a good connectivity check.</p>
</div>

{#if editing}
  <div class="scrim show" onclick={() => (editing = null)}></div>
  <aside class="drawer show" use:dialog={{ onclose: () => (editing = null) }}>
    <div class="dh"><div><div class="nm">Button {editing.number}</div>
      <div class="meta">{device.name} · drives a signal, LED mirrors one</div></div>
      <button class="x" aria-label="Close" onclick={() => (editing = null)}>✕</button></div>
    <div class="dbody" use:labelFields>
      <label class="opt" style="border:0;padding-top:0"><input type="checkbox" bind:checked={f.enabled} /> Button enabled <span class="desc">usable as an input under its name</span></label>
      <div class="field"><label>Name</label><input bind:value={f.name} /></div>
      <div class="field"><label>Action</label><select bind:value={f.mode}><option value={0}>Momentary</option><option value={1}>Toggle</option></select></div>
      <p class="lbl" style="margin-top:14px">LED states <span style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted)">— up to 4 prioritised states; the first whose signal is true wins</span></p>
      {#each [0, 1, 2, 3] as i}
        <div class="f3" style="align-items:end;margin-bottom:6px">
          <div class="field" style="margin:0"><label>State {i} colour</label>
            <select bind:value={f.valColors[i]}>{#each COLORS as c, ci}<option value={ci}>{c}</option>{/each}</select></div>
          <div class="field" style="margin:0"><label>Shows</label>
            <select bind:value={f.valVars[i]}><option value={0}>—</option>{#each inputsBool as v}<option value={v.index}>{v.name}</option>{/each}</select></div>
          <div class="field" style="margin:0"><label>Blink</label>
            <div style="display:flex;align-items:center;gap:8px">
              <input type="checkbox" bind:checked={f.valBlink[i]} aria-label={`State ${i} blink`} />
              <select bind:value={f.blinkColors[i]} disabled={!f.valBlink[i]} title={f.valBlink[i] ? 'Alternate (blink) colour' : 'Enable blink first'} style="flex:1;min-width:0">{#each COLORS as c, ci}<option value={ci}>{c}</option>{/each}</select>
            </div></div>
        </div>
      {/each}
      <p class="hint" style="margin-top:0">When blink is on, the LED alternates between the state colour and the blink colour. State 0 is the default; states 1–3 take priority in order when their signals are true.</p>

      <p class="lbl" style="margin-top:14px">Fault LED</p>
      <div class="f3" style="align-items:end">
        <div class="field" style="margin:0"><label>Fault colour</label><select bind:value={f.faultColor}>{#each COLORS as c, i}<option value={i}>{c}</option>{/each}</select></div>
        <div class="field" style="margin:0"><label>Fault blink</label>
          <div style="display:flex;align-items:center;gap:8px;padding-top:8px"><input type="checkbox" bind:checked={f.faultBlink} aria-label="Fault blink" /></div></div>
        <div class="field" style="margin:0"><label>Fault blink colour</label><select bind:value={f.faultBlinkColor} disabled={!f.faultBlink} title={f.faultBlink ? '' : 'Enable fault blink first'}>{#each COLORS as c, i}<option value={i}>{c}</option>{/each}</select></div>
      </div>
      <p class="hint">Saved to {ctrl?.name}'s keypad map. Press <b>Burn</b> on the PDM to persist.</p>
    </div>
    <div class="dfoot"><span class="res">button {editing.number}</span><span style="margin-left:auto"></span>
      <button class="btn ghost" onclick={() => (editing = null)}>Cancel</button>
      <button class="btn primary" disabled={saving} onclick={save}>{saving ? 'Saving…' : (live ? 'Save to device' : 'Save to project')}</button></div>
  </aside>
{/if}
