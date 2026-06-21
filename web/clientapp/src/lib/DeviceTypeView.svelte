<script>
  import { api } from './store.js'
  import { clickable, labelFields } from './a11y.js'
  let { device } = $props()
  let kind = $derived(
    /keypad/i.test(device?.type ?? '') ? 'keypad'
      : /dbc/i.test(device?.type ?? '') ? 'dbc'
      : /canboard|can.?board/i.test(device?.type ?? '') ? 'canboard'
      : 'other'
  )
  const btns = [1, 2, 3, 4, 5, 6, 7, 8]
  const hex = (n) => '0x' + (n ?? 0).toString(16).toUpperCase()

  // ---- DBC signals (live decoded) ----
  let sigs = $state([])
  $effect(() => {
    if (kind !== 'dbc' || !device?.guid) { sigs = []; return }
    const g = device.guid
    let alive = true
    const load = async () => { try { if (alive) sigs = await api.dbcSignals(g) } catch {} }
    load(); const id = setInterval(load, 500)
    return () => { alive = false; clearInterval(id) }
  })

  // ---- Live CAN sniffer: poll the bus, list IDs, show live bytes for the picked one ----
  let canRows = $state([])
  $effect(() => {
    if (kind !== 'dbc') return
    let alive = true
    const load = async () => { try { if (alive) canRows = await api.canlog() } catch {} }
    load(); const id = setInterval(load, 400)
    return () => { alive = false; clearInterval(id) }
  })
  let sniffId = $state(null)          // CAN id currently inspected in the grid
  let sniffSearch = $state('')
  let ids = $derived(
    [...canRows].filter((r) => r.dir !== 'Tx')
      .filter((r) => !sniffSearch || hex(r.id).toLowerCase().includes(sniffSearch.toLowerCase()))
      .sort((a, b) => a.id - b.id))
  // live data bytes for the inspected id ("AA BB .." hex string -> [..])
  let liveBytes = $derived((() => {
    const row = canRows.find((r) => r.id === sniffId)
    const b = (row?.data ?? '').split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16) & 0xFF)
    while (b.length < 8) b.push(0)
    return b.slice(0, 8)
  })())

  // ---- Custom-signal form (filled by clicking the grid) ----
  let cs = $state({ name: '', unit: '', id: '0x100', startBit: 7, length: 8, byteOrder: 1, isSigned: false, factor: 1, offset: 0, min: 0, max: 0 })
  let busy = $state(false), msg = $state('')

  // Which absolute DBC bits (byte*8 + bitInByte) the current selection covers.
  let covered = $derived((() => {
    const set = new Set()
    let len = +cs.length, sb = +cs.startBit
    if (cs.byteOrder == 0) {                         // little-endian: contiguous bit numbers
      for (let i = 0; i < len; i++) set.add(sb + i)
    } else {                                         // big-endian sawtooth
      let byte = sb >> 3, bib = sb & 7
      for (let i = 0; i < len && byte < 8; i++) { set.add(byte * 8 + bib); if (bib === 0) { byte++; bib = 7 } else bib-- }
    }
    return set
  })())

  // Mirror of the (fixed) firmware/back-end codec, for a live preview value.
  function decode(bytes, startBit, length, bigEndian, signed) {
    let raw = 0n
    if (!bigEndian) {
      let sb = startBit & 7, byte = startBit >> 3, rem = length, pos = 0
      for (let i = byte; i < 8 && rem > 0; i++) {
        const take = Math.min(8 - (i === byte ? sb : 0), rem), shift = i === byte ? sb : 0
        const bits = BigInt((bytes[i] >> shift) & ((1 << take) - 1))
        raw |= bits << BigInt(pos); pos += take; rem -= take
      }
    } else {
      let byte = startBit >> 3, bib = startBit & 7, rem = length, dest = length - 1
      while (rem > 0 && byte < 8) {
        const take = Math.min(bib + 1, rem), shift = bib - take + 1
        const bits = BigInt((bytes[byte] >> shift) & ((1 << take) - 1))
        raw |= bits << BigInt(dest - take + 1); dest -= take; rem -= take; byte++; bib = 7
      }
    }
    if (signed) { const s = 1n << BigInt(length - 1); if (raw & s) raw -= 1n << BigInt(length) }
    return Number(raw)
  }
  let preview = $derived(decode(liveBytes, +cs.startBit, +cs.length, cs.byteOrder == 1, cs.isSigned) * (+cs.factor) + (+cs.offset))

  function pickId(id) { sniffId = id; cs.id = hex(id) }
  function clickBit(byte, bib) { cs = { ...cs, startBit: byte * 8 + bib, id: sniffId != null ? hex(sniffId) : cs.id } }

  async function openFile(e) {
    const file = e.target.files?.[0]; if (!file) return
    busy = true; msg = ''
    try { const r = await api.dbcOpen(device.guid, await file.text()); msg = `Loaded ${r.count} signals from ${file.name}` }
    catch (err) { msg = 'Parse failed: ' + err.message }
    finally { busy = false; e.target.value = '' }
  }
  async function addSignal() {
    busy = true; msg = ''
    try {
      await api.dbcAddSignal(device.guid, {
        name: cs.name || 'signal', id: parseInt(String(cs.id).replace(/^0x/i, ''), 16) || 0,
        startBit: +cs.startBit, length: +cs.length, byteOrder: +cs.byteOrder, isSigned: cs.isSigned,
        factor: +cs.factor, offset: +cs.offset, unit: cs.unit, min: +cs.min, max: +cs.max,
      })
      msg = `Added signal "${cs.name || 'signal'}" — it appears in the table below once it decodes.`
      cs = { ...cs, name: '' }
    } catch (err) { msg = 'Add failed: ' + err.message }
    finally { busy = false }
  }
</script>

<div class="h-row">
  <div><h1>{device.name} · {device.type}</h1>
    <p class="sub">{device.connected ? 'Live · device on the bus.' : 'Not seen on the bus yet.'}</p></div>
</div>

{#if kind === 'keypad'}
  <div class="cat-grp">Buttons &amp; LEDs <span class="ct"></span></div>
  <div class="kpad">
    {#each btns as b}
      <div class="kbtn"><span class="kn">{b}</span><span class="led" style="background:#37474f"></span><span class="kl">button{b}</span></div>
    {/each}
  </div>
  <p class="hint">This is the physical keypad's live button/LED state. The keypad's <b>configuration</b> (names,
    LED colours, what each button drives) lives on the controlling dingoPDM — open that module's
    <b>Signals &amp; logic</b> ▸ Keypad section.</p>
{:else if kind === 'dbc'}
  <div class="devbar">
    <label class="btn primary" style="cursor:pointer">📂 Open DBC file…
      <input type="file" accept=".dbc" style="display:none" onchange={openFile} disabled={busy} /></label>
    <span class="sep"></span>
    {#if msg}<span class="muted">{msg}</span>{/if}
  </div>

  <div class="cat-grp">Live CAN sniffer
    <span style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted)">— click an ID, then click a bit to define a signal off the live bus</span><span class="ct"></span></div>
  <div class="card" style="padding:14px;cursor:default;display:flex;gap:16px;flex-wrap:wrap">
    <div style="min-width:180px">
      <input placeholder="filter ID…" aria-label="Filter CAN IDs" bind:value={sniffSearch} style="width:100%;margin-bottom:6px" />
      <div style="max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px">
        {#each ids as r}
          <div use:clickable aria-label={"Inspect " + hex(r.id)} onclick={() => pickId(r.id)} style="display:flex;justify-content:space-between;gap:10px;padding:4px 8px;cursor:pointer;font-family:var(--mono);font-size:12px;{r.id === sniffId ? 'background:var(--accent);color:#fff' : ''}">
            <b>{hex(r.id)}</b><span style="opacity:.7">{r.count}</span>
          </div>
        {/each}
        {#if ids.length === 0}<div class="muted" style="padding:8px;font-size:12px">No CAN traffic seen.</div>{/if}
      </div>
    </div>
    <div style="flex:1;min-width:300px">
      {#if sniffId != null}
        <div style="font-family:var(--mono);font-size:12px;margin-bottom:6px">{hex(sniffId)} · live bytes — bit 7 (MSB) → 0, left to right</div>
        <table style="border-collapse:collapse;font-family:var(--mono);font-size:11px">
          <tbody>
            {#each [0,1,2,3,4,5,6,7] as byte}
              <tr>
                <td style="padding:2px 6px;color:var(--muted)">B{byte}</td>
                {#each [7,6,5,4,3,2,1,0] as bib}
                  {@const abs = byte * 8 + bib}
                  {@const on = (liveBytes[byte] >> bib) & 1}
                  <td use:clickable aria-label={"Bit " + abs} onclick={() => clickBit(byte, bib)}
                    title="bit {abs}"
                    style="width:22px;height:22px;text-align:center;cursor:pointer;border:1px solid var(--line);
                      {covered.has(abs) ? 'background:var(--accent);color:#fff;' : (on ? 'background:var(--line-2);' : '')}
                      {abs === +cs.startBit ? 'outline:2px solid var(--err);outline-offset:-2px;' : ''}">{on}</td>
                {/each}
                <td style="padding:2px 6px;color:var(--muted)">0x{liveBytes[byte].toString(16).toUpperCase().padStart(2,'0')}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <div style="margin-top:8px;font-size:13px">selection: start bit <b>{cs.startBit}</b> · {cs.length} bits · {cs.byteOrder == 1 ? 'big-endian' : 'little-endian'} →
          live value <b style="color:var(--accent)">{Number.isFinite(preview) ? preview.toFixed(cs.factor == 1 ? 0 : 2) : '—'}</b> {cs.unit}</div>
      {:else}
        <p class="muted">Pick a CAN ID on the left to inspect its bits.</p>
      {/if}
    </div>
  </div>

  <div class="cat-grp">Add / define a signal <span class="ct"></span></div>
  <div class="card" style="padding:16px;cursor:default" use:labelFields>
    <div class="f3">
      <div class="field"><label>Name</label><input bind:value={cs.name} placeholder="e.g. Oil Pressure" /></div>
      <div class="field"><label>Unit</label><input bind:value={cs.unit} placeholder="optional, e.g. kPa" /></div>
      <div class="field"><label>CAN ID</label><input bind:value={cs.id} /></div>
    </div>
    <div class="f3">
      <div class="field"><label>Start bit</label><input type="number" bind:value={cs.startBit} /></div>
      <div class="field"><label>Length (bits)</label><input type="number" bind:value={cs.length} /></div>
      <div class="field"><label>Byte order</label><select bind:value={cs.byteOrder}><option value={0}>Little-endian</option><option value={1}>Big-endian</option></select></div>
    </div>
    <div class="f3">
      <div class="field"><label>Factor</label><input type="number" step="any" bind:value={cs.factor} /></div>
      <div class="field"><label>Offset</label><input type="number" step="any" bind:value={cs.offset} /></div>
      <div class="field"><label>Signed</label><select bind:value={cs.isSigned}><option value={false}>No</option><option value={true}>Yes</option></select></div>
    </div>
    <div class="f2">
      <div class="field"><label>Min value</label><input type="number" step="any" bind:value={cs.min} /></div>
      <div class="field"><label>Max value</label><input type="number" step="any" bind:value={cs.max} /></div>
    </div>
    <button class="btn primary" style="margin-top:4px" disabled={busy} onclick={addSignal}>+ Add signal</button>
  </div>

  <div class="cat-grp">Signals <span style="text-transform:none;letter-spacing:0;font-weight:500;color:var(--muted)">— live decoded values</span><span class="ct"></span></div>
  <div class="tscroll"><table class="logtable" style="font-family:inherit">
    <thead><tr><th>Name</th><th>Message</th><th>Value</th><th>ID</th><th>Start</th><th>Len</th><th>Order</th><th>Signed</th><th>Factor</th><th>Unit</th></tr></thead>
    <tbody>
      {#each sigs as s}
        <tr><td>{s.name}</td><td class="muted">{s.messageName}</td><td><b>{s.value}</b></td><td>{hex(s.id)}{s.isExtended ? ' (x)' : ''}</td><td>{s.startBit}</td><td>{s.length}</td>
          <td>{s.byteOrder === 1 ? 'BE' : 'LE'}</td><td>{s.isSigned ? 'Yes' : 'No'}</td><td>{s.factor}</td><td>{s.unit}</td></tr>
      {/each}
      {#if sigs.length === 0}<tr><td colspan="10" class="muted">No signals yet — open a .dbc file or define one from the sniffer above.</td></tr>{/if}
    </tbody>
  </table></div>
{:else if kind === 'canboard'}
  <div class="cat-grp">CANBoard I/O <span class="ct"></span></div>
  <div class="card flat"><p class="muted">8 digital inputs · 5 analog inputs · 4 outputs. Live values populate when a CANBoard is on the bus.</p></div>
{:else}
  <div class="card flat"><p class="muted">No dedicated view for "{device.type}" yet.</p></div>
{/if}
