<script>
  // Multi-position switch on an analog input: design a resistor ladder (H19) and teach the real switch (H07).
  // The form owns `rot` = { n, tolAuto, tol, invert, rows: [{ name, mv, r }] }; the page saves it.
  import { Card, Button, Segmented, Stepper, Field, Checkbox, Banner } from '../../../ui/index.js'
  import { nodeVoltageMv, resistorForMv, nearestStandard, recommendResistors, recommendPullup, supplyCurrentMa, decodePoints, autoTolerance, NO_POS, R_IN } from '../../../../lib/ladder.js'

  let { rot = $bindable(), liveMv = null, online = false, steady = false, capture = true } = $props()

  const VSUP = 5000
  const RPU = recommendPullup({ vsupMv: VSUP })     // fixed on the board: 470 ohm
  const opts = { vsupMv: VSUP, rpu: RPU }

  const DEFAULT_NAMES = ['Off', 'Park', 'Low', 'High', 'Show']
  const PRESETS = [{ value: 'headlight', label: 'Headlight, 5 positions' }, { value: 'even', label: 'Evenly spaced, 5' }, { value: 'three', label: '3 positions' }]
  let preset = $state('')

  const mkRow = (name, r) => ({ name, r, mv: Math.round(nodeVoltageMv(r, opts)) })
  function applyPreset(id) {
    if (id === 'headlight') rot.rows = ['Off', 'Park', 'Low', 'High', 'Show'].map((nm, i) => mkRow(nm, [220, 470, 1000, 2200, 4700][i]))
    else {
      const n = id === 'three' ? 3 : 5
      const names = n === 3 ? ['Off', 'Low', 'High'] : DEFAULT_NAMES
      rot.rows = recommendResistors(n, opts).map((x, i) => ({ name: names[i], r: x.r, mv: Math.round(x.mv) }))
    }
    rot.n = rot.rows.length
    cal = 0
  }
  function setCount(n) {
    n = Math.max(2, Math.min(10, Math.round(Number(n) || 2)))
    const rows = rot.rows.slice(0, n)
    while (rows.length < n) rows.push(mkRow('Position ' + rows.length, Infinity))
    rot.rows = rows; rot.n = n
    if (cal >= n) cal = n - 1
  }
  function setR(i, text) {
    const t = String(text).trim().toLowerCase()
    const r = t === '' || t === 'open' || t === 'inf' ? Infinity : Number(t)
    if (!Number.isFinite(r) && r !== Infinity) return
    rot.rows[i] = { ...rot.rows[i], r, mv: Math.round(nodeVoltageMv(r > 0 ? r : Infinity, opts)) }
  }
  function setV(i, volts) {
    const mv = Math.round((Number(volts) || 0) * 1000)
    rot.rows[i] = { ...rot.rows[i], mv, r: nearestStandard(resistorForMv(mv, opts)) }
  }
  const rText = (r) => (r === Infinity ? 'open' : String(r))

  const mvs = $derived(rot.rows.map((r) => r.mv))
  const tol = $derived(rot.tolAuto ? autoTolerance(mvs) : Number(rot.tol) || 200)
  const checks = $derived(rot.rows.map((r, i) => {
    const gN = i < mvs.length - 1 ? mvs[i + 1] - mvs[i] : null
    const gP = i > 0 ? mvs[i] - mvs[i - 1] : null
    const worst = Math.min(gN ?? 1e9, gP ?? 1e9)
    const lvl = worst < 0 ? 'fault' : worst < 2 * tol ? 'fault' : worst < 2 * tol + 300 ? 'warn' : 'ok'
    const nb = gN !== null && gN === worst ? rot.rows[i + 1]?.name : gP !== null ? rot.rows[i - 1]?.name : ''
    return { lvl, gap: gN, text: worst < 0 ? `Out of order with ${nb}` : lvl === 'fault' ? `Overlaps ${nb}` : lvl === 'warn' ? `Too close to ${nb}` : 'Clear' }
  }))
  const ascending = $derived(mvs.every((v, i) => i === 0 || v > mvs[i - 1]))
  const tight = $derived(mvs.length > 1 ? Math.min(...mvs.slice(1).map((v, i) => v - mvs[i])) : 0)
  const worstMa = $derived(Math.max(...rot.rows.map((r) => supplyCurrentMa(r.r, opts))))
  const livePos = $derived(liveMv != null && ascending ? decodePoints(liveMv, mvs, tol) : NO_POS)

  // ---- calibrate from the real switch ----
  let cal = $state(0)
  function doCapture() {
    if (liveMv == null) return
    setV(cal, liveMv / 1000)
    rot.rows[cal] = { ...rot.rows[cal], captured: true }
    if (cal < rot.rows.length - 1) cal++
  }
</script>

<Card title="Positions" subtitle={`pull-up ${RPU} Ω to 5 V · each position switches one resistor to ground · the last one is open`} aria-label="Resistor ladder designer">
  <div class="top">
    <Stepper label="Number of positions" bind:value={rot.n} min={2} max={10} step={1} onchange={setCount} data-testid="numpos" />
    <div class="pre"><span class="nx-label">Start from</span>
      <Segmented label="Start from" items={PRESETS} bind:value={preset} onchange={applyPreset} data-testid="ladder-preset" />
    </div>
  </div>

  {#if !ascending}
    <Banner tone="fault" title="The voltages must go up with the position number">Fix the resistor of the position that is lower than the one before it. Saving is blocked until then.</Banner>
  {:else if tight < 2 * tol}
    <Banner tone="fault" title="Two positions overlap">The windows (± {tol} mV) touch, so the module cannot tell them apart. Change a resistor until the gap is at least {2 * tol + 300} mV.</Banner>
  {:else if tight < 2 * tol + 300}
    <Banner tone="warn" title="Two positions are close together">They work on paper, but real resistors and a long wire can move the voltage past the window. Aim for a gap of at least {2 * tol + 300} mV.</Banner>
  {/if}

  <div class="tbl nx-scroll">
    <table class="nx-table" data-testid="ladder-table">
      <thead><tr><th>Pos.</th><th>Name</th><th>Resistor to ground</th><th>Voltage</th><th>Gap to next</th><th>Check</th>{#if capture}<th>Teach</th>{/if}</tr></thead>
      <tbody>
        {#each rot.rows as r, i (i)}
          <tr class:now={livePos === i} class:cal={capture && cal === i}>
            <td class="mono">{i}</td>
            <td><input class="nx-input" aria-label={`Name of position ${i}`} bind:value={r.name} maxlength="16" /></td>
            <td><div class="u"><input class="nx-input mono" aria-label={`Resistor for position ${i} in ohms`} value={rText(r.r)} onchange={(e) => setR(i, e.currentTarget.value)} inputmode="numeric" /><span class="mono">Ω</span></div></td>
            <td><div class="u"><input class="nx-input mono" type="number" step="0.01" min="0" max="5" aria-label={`Voltage of position ${i} in volts`} value={(r.mv / 1000).toFixed(2)} onchange={(e) => setV(i, e.currentTarget.value)} /><span class="mono">V</span></div></td>
            <td class="mono">{checks[i].gap == null ? '—' : '+' + (checks[i].gap / 1000).toFixed(2) + ' V'}</td>
            <td class="chk" data-lvl={checks[i].lvl}><span aria-hidden="true">{checks[i].lvl === 'ok' ? '●' : checks[i].lvl === 'warn' ? '▲' : '■'}</span> {checks[i].text}{#if r.captured} · captured ✓{/if}</td>
            {#if capture}<td><Button size="sm" disabled={!online || liveMv == null} onclick={() => { cal = i; doCapture() }} data-testid={'capture-' + i} aria-label={`Capture the live voltage into position ${i}`}>Use live {liveMv != null ? (liveMv / 1000).toFixed(2) + ' V' : ''}</Button></td>{/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="win">
    <div class="bar" role="img" aria-label={`Voltage windows of ${rot.rows.length} positions on a 0 to 5 volt scale${liveMv != null ? `, live reading ${(liveMv / 1000).toFixed(2)} volts` : ''}`}>
      {#each rot.rows as r, i (i)}
        <span class="w" data-lvl={checks[i].lvl} style="left: {Math.max(0, (r.mv - tol) / 50)}%; width: {Math.min(100, (2 * tol) / 50)}%"><span>{r.name}</span></span>
      {/each}
      {#if liveMv != null}<span class="live" style="left: {Math.min(100, liveMv / 50)}%"></span>{/if}
    </div>
    <div class="ax" aria-hidden="true"><span>0 V</span><span>1 V</span><span>2 V</span><span>3 V</span><span>4 V</span><span>5 V</span></div>
  </div>

  <div class="set">
    <div><span class="nx-label">Pull-up to 5 V</span><strong class="mono">{RPU} Ω (fixed on the board)</strong></div>
    <div><span class="nx-label">Window ±</span><strong class="mono">{tol} mV{rot.tolAuto ? ' (auto)' : ''}</strong></div>
    <div><span class="nx-label">Tightest gap</span><strong class="mono" data-lvl={tight < 2 * tol ? 'fault' : tight < 2 * tol + 300 ? 'warn' : 'ok'}>{(tight / 1000).toFixed(2)} V · {tight < 2 * tol ? 'overlap' : tight < 2 * tol + 300 ? 'tight' : 'good'}</strong></div>
    <div><span class="nx-label">Worst-case draw</span><strong class="mono">{worstMa.toFixed(1)} mA</strong></div>
  </div>
  <div class="tolrow">
    <Checkbox bind:checked={rot.tolAuto} label="Choose the window automatically" hint="A fraction of the tightest gap, between 75 and 300 mV." />
    {#if !rot.tolAuto}<Stepper label="Window ±" bind:value={rot.tol} min={20} max={1000} step={10} unit="mV" />{/if}
  </div>
  <Checkbox bind:checked={rot.invert} label="Count the positions the other way round" hint="Position 0 becomes the last one." />
  <p class="muted small">Between two windows the switch reads "no position", and functions keep the last real one, so turning the knob never flicks the lights off. Real resistors are off by 1 to 5 %: design here, then teach the real switch.</p>
</Card>

{#if capture}
  <Card title="Teach it by turning the switch" subtitle="reads the real voltage from the module" aria-label="Teach the switch">
    {#if !online}
      <p class="muted" role="status">Connect to the module to read the real voltage. You can still type the voltages by hand above.</p>
    {:else}
      <div class="calrow" role="status">
        <span class="step mono">{cal + 1}</span>
        <span class="msg"><strong>Turn the switch to "{rot.rows[cal]?.name}" and press Capture</strong>
          <span class="muted">Reading {liveMv != null ? (liveMv / 1000).toFixed(2) + ' V' : '—'} · {steady ? 'steady for 1 s. Capture when it shows the new position.' : 'still moving. Wait until it settles.'}</span></span>
        <Button variant="primary" disabled={!steady} onclick={doCapture} data-testid="capture-step">Capture position {cal}</Button>
      </div>
    {/if}
  </Card>
{/if}

<style>
  .top { display: flex; gap: var(--space-4); flex-wrap: wrap; align-items: flex-end; }
  .pre { display: flex; flex-direction: column; gap: 4px; }
  .tbl { padding: 0; }
  tr.now td { background: var(--color-on-soft); }
  tr.cal td { box-shadow: inset 0 2px 0 var(--color-focus), inset 0 -2px 0 var(--color-focus); }
  .u { display: flex; align-items: center; gap: var(--space-2); }
  td .nx-input { min-height: 36px; min-width: 80px; }
  .chk[data-lvl='ok'] { color: var(--color-ok); }
  .chk[data-lvl='warn'] { color: var(--color-warn); }
  .chk[data-lvl='fault'] { color: var(--color-fault); font-weight: 600; }
  .win { display: flex; flex-direction: column; gap: 4px; }
  .bar { position: relative; height: 54px; border-radius: var(--radius-md); background: var(--color-raised); overflow: hidden; }
  .w { position: absolute; top: 6px; bottom: 6px; border: 1px solid var(--color-line-strong); background: var(--color-on-soft); border-radius: var(--radius-sm); overflow: hidden; font-size: 11px; display: flex; align-items: center; justify-content: center; }
  .w[data-lvl='warn'] { background: var(--color-warn-soft); border-color: var(--color-warn); }
  .w[data-lvl='fault'] { background: var(--color-fault-soft); border-color: var(--color-fault); }
  .w span { white-space: nowrap; }
  .live { position: absolute; top: 0; bottom: 0; width: 3px; background: var(--color-accent); }
  .ax { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 11px; color: var(--color-text-muted); }
  .set { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: var(--space-3); }
  .set > div { display: flex; flex-direction: column; gap: 2px; }
  .set [data-lvl='ok'] { color: var(--color-ok); }
  .set [data-lvl='warn'] { color: var(--color-warn); }
  .set [data-lvl='fault'] { color: var(--color-fault); }
  .tolrow { display: flex; gap: var(--space-4); flex-wrap: wrap; align-items: flex-end; }
  .calrow { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-raised); }
  .step { font-size: var(--text-xl); font-weight: 700; color: var(--color-accent); }
  .msg { flex: 1 1 260px; display: flex; flex-direction: column; }
  .small { font-size: var(--text-xs); }
</style>
