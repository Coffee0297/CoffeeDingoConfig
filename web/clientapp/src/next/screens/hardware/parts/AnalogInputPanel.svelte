<script>
  // Analog input on a CANBoard (H19 + H07): on / off threshold, linear sensor, or multi-position switch.
  import { untrack } from 'svelte'
  import { Page, PageHeader, Card, Button, StateDot, Banner, Segmented, Switch, Stepper, Field, Checkbox, LineChart, Empty } from '../../../ui/index.js'
  import { live, isCanboard } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import { pinFor, ioTag } from '../../../../lib/pinmap.js'
  import { autoTolerance, decodePoints, NO_POS, nodeVoltageMv, recommendPullup, resistorForMv, nearestStandard } from '../../../../lib/ladder.js'
  import { inputModel } from './input.svelte.js'
  import { signalFeed, ring } from './feeds.svelte.js'
  import { resample, isUpstream } from './util.js'
  import SaveBar from './SaveBar.svelte'
  import UsedBy from './UsedBy.svelte'
  import LadderDesigner from './LadderDesigner.svelte'

  let { guid, n } = $props()
  const M = inputModel(() => guid, () => 'analoginput', () => n)
  const dev = $derived(M.dev)
  const row = $derived(M.row)
  const feed = signalFeed(() => guid, 200)
  // upstream dingoFW: no sensor scaling and a uniform rotary (position = (mV - offset) / step, at most max)
  const up = $derived(isUpstream(dev))

  // ---- form ----
  const VSUP = 5000, OPTS = { vsupMv: VSUP, rpu: recommendPullup({ vsupMv: VSUP }) }
  let f = $state(null), snap = $state('')
  function seed(r) {
    const mode = r.rotary?.enabled ? (isUpstream(M.dev) ? 'uniform' : 'ladder') : r.scale?.enabled ? 'linear' : 'threshold'
    const sc = r.scale ?? {}, sw = r.switch ?? {}, ro = r.rotary ?? {}
    const np = ro.enabled && ro.numPos >= 2 ? ro.numPos : 5
    const names = ro.positionNames ?? []
    const rows = Array.from({ length: np }, (_, i) => {
      const mv = ro.enabled ? (ro.points?.[i] ?? 0) : null
      const DEF = ['Off', 'Park', 'Low', 'High', 'Show']
      const base = { name: names[i] || DEF[i] || 'Position ' + i }
      if (mv == null) { const rr = [220, 470, 1000, 2200, 4700][i]; return { ...base, r: rr, mv: Math.round(nodeVoltageMv(rr, OPTS)) } }
      return { ...base, mv, r: nearestStandard(resistorForMv(mv, OPTS)) }
    })
    return {
      name: r.name ?? '', enabled: !!r.enabled, mode,
      thr: (sw.threshold ?? 2000) / 1000, swMode: sw.mode ?? 0, swInvert: !!sw.invert,
      sp: 'custom', unit: sc.units ?? '', lowV: (sc.inLowMv ?? 500) / 1000, lowX: sc.outLow ?? 0, highV: (sc.inHighMv ?? 4500) / 1000, highX: sc.outHigh ?? 100,
      uni: { offsetMv: ro.offsetMv ?? 0, stepMv: ro.stepMv ?? 100, maxPos: ro.maxPos ?? 10, invert: !!ro.invert },
      rot: { n: np, tolAuto: !ro.enabled, tol: ro.tolerance > 0 ? ro.tolerance : 200, invert: !!ro.invert, rows },
    }
  }
  $effect(() => { if (!f && row) { f = seed(row); snap = JSON.stringify(f) } })
  const dirty = $derived(!!f && JSON.stringify(f) !== snap)
  function revert() { if (row) { f = seed(row); snap = JSON.stringify(f); M.state.saveErr = '' } }

  const gain = $derived(f ? (Number(f.highX) - Number(f.lowX)) / ((Number(f.highV) - Number(f.lowV)) * 1000 || 1) : 0)
  const offs = $derived(f ? Number(f.lowX) - gain * Number(f.lowV) * 1000 : 0)
  const mvs = $derived(f ? f.rot.rows.map((r) => r.mv) : [])
  const tol = $derived(f ? (f.rot.tolAuto ? autoTolerance(mvs) : Number(f.rot.tol) || 200) : 200)
  const ascending = $derived(mvs.every((v, i) => i === 0 || v > mvs[i - 1]))
  const problem = $derived.by(() => {
    if (!f || !dirty) return ''
    if (!String(f.name).trim()) return 'Give the input a name.'
    if (f.mode === 'linear' && Number(f.highV) === Number(f.lowV)) return 'The two voltages must be different.'
    if (f.mode === 'ladder' && !ascending) return 'The position voltages must go up with the position number.'
    if (f.mode === 'uniform' && !(Number(f.uni.stepMv) > 0)) return 'The step must be above 0 mV.'
    return ''
  })
  async function save() {
    const pts = Array.from({ length: 10 }, (_, i) => (i < f.rot.rows.length ? Math.round(f.rot.rows[i].mv) : 0))
    const names = Array.from({ length: 10 }, (_, i) => (i < f.rot.rows.length ? String(f.rot.rows[i].name || '').slice(0, 16) : null))
    const body = {
      name: String(f.name).trim(), enabled: f.enabled,
      switch: { enabled: f.mode === 'threshold', mode: Number(f.swMode), invert: f.swInvert, threshold: Math.round(Number(f.thr) * 1000) },
      scale: { enabled: f.mode === 'linear', units: f.unit, gain, offset: offs, inLowMv: Math.round(Number(f.lowV) * 1000), outLow: Number(f.lowX), inHighMv: Math.round(Number(f.highV) * 1000), outHigh: Number(f.highX) },
      rotary: { enabled: f.mode === 'ladder', invert: f.rot.invert, numPos: f.rot.rows.length, tolerance: Math.round(tol), points: pts, positionNames: names },
    }
    if (up) {
      delete body.scale
      body.rotary = { enabled: f.mode === 'uniform', invert: f.uni.invert, offsetMv: Number(f.uni.offsetMv), stepMv: Number(f.uni.stepMv), maxPos: Number(f.uni.maxPos) }
    }
    if (await M.save(body)) snap = JSON.stringify(f)
  }

  // ---- live reading ----
  const aSig = $derived(row ? feed.get('Analog input', row.name) : undefined)
  const swSig = $derived(row ? feed.get('Analog switch', row.name + ' Switch') : undefined)
  const mv = $derived(aSig && M.connected ? Number(aSig.value) : null)
  const hist = ring(10_000)
  let tick = $state(0), mvTick = $state(0), recent = []
  $effect(() => {
    feed.ts
    const s = untrack(() => aSig)
    if (!s || !untrack(() => M.connected)) return
    untrack(() => {
      const v = Number(s.value) / 1000
      hist.push(v); tick++
      recent.push({ t: Date.now(), v: Number(s.value) }); const cut = Date.now() - 1000; while (recent.length && recent[0].t < cut) recent.shift()
      mvTick++
    })
  })
  const series = $derived.by(() => { tick; return resample(hist.samples(), 10_000, 100) })
  const steady = $derived.by(() => { mvTick; return recent.length >= 4 && Math.max(...recent.map((x) => x.v)) - Math.min(...recent.map((x) => x.v)) <= 20 })
  const online = $derived(M.connected)

  const ioText = $derived(dev ? ioTag(dev, 'analoginput', n) : '')
  const pin = $derived(dev ? pinFor(dev, 'analoginput', n) : null)
  const live2 = $derived.by(() => {
    if (!f || mv == null) return null
    const V = mv / 1000
    if (f.mode === 'threshold') { const on = f.swInvert ? !swSig?.on : !!swSig?.on; return { kind: swSig ? (swSig.on ? 'on' : 'off') : 'off', text: (swSig?.on ? 'ON' : 'OFF') + ' · ' + V.toFixed(2) + ' V', v: V } }
    if (f.mode === 'linear') {
      const out = V < Math.min(f.lowV, f.highV) - 0.2 || V > Math.max(f.lowV, f.highV) + 0.2
      const x = gain * mv + offs
      const dp = Math.abs(f.highX - f.lowX) >= 20 ? 0 : 1
      return out ? { kind: 'fault', text: 'Out of range · ' + V.toFixed(2) + ' V', v: V, out: true } : { kind: 'on', text: x.toFixed(dp) + ' ' + f.unit + ' · ' + V.toFixed(2) + ' V', v: V, val: x.toFixed(dp) }
    }
    if (f.mode === 'uniform') return { kind: 'on', text: V.toFixed(2) + ' V', v: V }   // the module works the position out
    const pts = f.rot.rows.map((r) => r.mv)
    const p = ascending ? decodePoints(mv, pts, tol) : NO_POS
    const pos = p === NO_POS ? null : (f.rot.invert ? pts.length - 1 - p : p)
    return pos == null ? { kind: 'off', text: 'No position · ' + V.toFixed(2) + ' V', v: V } : { kind: 'on', text: `Position ${pos} · ${f.rot.rows[p]?.name} · ${V.toFixed(2)} V`, v: V }
  })
  const pillTone = $derived(!live.connected ? 'stale' : !dev?.connected ? 'stale' : !row?.enabled ? 'off' : live2 ? live2.kind : 'stale')
  const pillText = $derived(!live.connected ? 'No connection' : !dev?.connected ? 'Module offline' : !row?.enabled ? 'Not in use' : live2 ? live2.text : 'Reading…')

  const SENS = [{ value: 'fuel', label: 'Fuel level 0–100 %' }, { value: 'oil', label: 'Oil pressure 0–10 bar' }, { value: 'custom', label: 'Custom' }]
  const PRE = { fuel: [0.5, 0, 4.5, 100, '%'], oil: [0.5, 0, 4.5, 10, 'bar'] }
  function applySensor(id) { const p = PRE[id]; if (p) { f.lowV = p[0]; f.lowX = p[1]; f.highV = p[2]; f.highX = p[3]; f.unit = p[4] } f.sp = id }
  let useVal = $state('threshold'), swVal = $state('0'), spVal = $state('custom')
  $effect(() => { if (f) { useVal = f.mode; swVal = String(f.swMode); spVal = f.sp } })
  const title = $derived(f?.name?.trim() || `Analog input ${n}`)
  const outRange = $derived(!!live2?.out)
</script>

<Page>
  {#if !M.state.loaded}
    <p class="muted" role="status">Reading the input…</p>
  {:else if dev && !isCanboard(dev)}
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: dev.name, href: href('hardware', 'module', guid) }, { label: 'Inputs' }]} title="No analog inputs here" />
    <Empty title={`${dev.name} has no analog inputs`} text="Analog inputs are on the CANBoard." />
  {:else if M.state.err && !row}
    <Banner tone="fault" title="Could not read this module">{M.state.err}</Banner>
  {:else if !row}
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: dev.name, href: href('hardware', 'module', guid) }, { label: `Analog ${n}` }]} title={`${dev.name} has no analog input ${n}`} />
    <Empty title="No such input" text="Check the number in the address." />
  {:else if f}
    <PageHeader crumbs={[{ label: 'Hardware', href: href('hardware') }, { label: dev.name, href: href('hardware', 'module', guid) }, { label: 'Inputs' }, { label: `Analog ${n}` }]} title={title}>
      {#snippet tag()}
        <span class="pin mono">{ioText}{#if pin} · {pin.label}{/if}</span>
        <span class="pill" data-tone={pillTone} role="status" data-testid="in-state"><StateDot tone={pillTone === 'fault' ? 'fault' : pillTone} shape={pillTone === 'on' ? 'dot' : pillTone === 'fault' ? 'square' : pillTone === 'stale' ? 'square' : 'ring'} label={pillText} /></span>
      {/snippet}
      {#snippet actions()}
        <Switch bind:checked={f.enabled} label="Input in use" />
      {/snippet}
    </PageHeader>

    {#if !live.connected}
      <Banner tone="warn" title="Not connected to the car">Design work still works. Changes are kept in the project and sent when you apply them.</Banner>
    {:else if !dev.connected}
      <Banner tone="warn" title={`${dev.name} is not answering`}>Values here are the last ones it sent. Design work still works; saving waits until it is back.</Banner>
    {/if}
    {#if outRange}
      <Banner tone="fault" title="The reading is outside the sensor range">An open sender wire usually reads close to 5 V; a short to ground reads close to 0 V. Check the wire before you trust the value.</Banner>
    {/if}

    <Segmented label="Use this input as" items={up ? [{ value: 'threshold', label: 'On / off threshold' }, { value: 'uniform', label: 'Multi-position switch' }]
      : [{ value: 'threshold', label: 'On / off threshold' }, { value: 'linear', label: 'Linear sensor' }, { value: 'ladder', label: 'Multi-position switch' }]} bind:value={useVal}
      onchange={(v) => { f.mode = v; if (!f.enabled) f.enabled = true }} data-testid="use-as" />

    <Field label="Name" bind:value={f.name} data-testid="name" />

    {#if f.mode === 'uniform'}
      <Card title="Evenly spaced positions" subtitle="upstream dingoFW: position = (voltage − offset) ÷ step" aria-label="Rotary switch">
        <Field label="Offset" type="number" step="1" unit="mV" bind:value={f.uni.offsetMv} data-testid="uni-offset" />
        <Field label="Step per position" type="number" step="1" min={1} unit="mV" bind:value={f.uni.stepMv} data-testid="uni-step" />
        <Field label="Highest position" type="number" step="1" min={0} bind:value={f.uni.maxPos} data-testid="uni-max" />
        <Checkbox bind:checked={f.uni.invert} label="Invert" hint="Count the positions the other way." />
      </Card>
    {:else if f.mode === 'ladder'}
      <div class="cols one">
        <div class="col">
          <LadderDesigner bind:rot={f.rot} liveMv={mv} {online} {steady} />
          <UsedBy {guid} items={M.usedBy} hint={'Each position is also its own on / off signal, for example "' + (f.name || 'Switch') + ' is ' + (f.rot.rows[2]?.name ?? 'Low') + '".'} />
        </div>
      </div>
    {:else}
      <div class="cols">
        <div class="col">
          {#if f.mode === 'linear'}
            <Card title="Two points tell it what the voltage means" subtitle="everything between them is a straight line" aria-label="Sensor curve">
              <div class="grp"><span class="nx-label">Start from</span><Segmented label="Start from" items={SENS} bind:value={spVal} onchange={applySensor} data-testid="sensor-preset" /></div>
              <Field label="Unit" bind:value={f.unit} data-testid="unit" onchange={() => (f.sp = 'custom')} />
              {#each [['Low point', 'lowV', 'lowX'], ['High point', 'highV', 'highX']] as [lab, kv, kx] (kv)}
                <div class="pt">
                  <strong>{lab}</strong>
                  <Field label={`${lab} voltage`} type="number" step="0.01" min={0} max={5} unit="V" bind:value={f[kv]} onchange={() => (f.sp = 'custom')} data-testid={kv} />
                  <Field label={`${lab} value${f.unit ? ' in ' + f.unit : ''}`} type="number" step="any" unit={f.unit} bind:value={f[kx]} onchange={() => (f.sp = 'custom')} data-testid={kx} />
                  <Button disabled={!online || mv == null} onclick={() => { f[kv] = Math.round(mv) / 1000; f.sp = 'custom' }} data-testid={'take-' + kv}>Use live {mv != null ? (mv / 1000).toFixed(2) + ' V' : ''}</Button>
                </div>
              {/each}
            </Card>
          {:else}
            <Card title="Switch on high, off low" subtitle="the module has one switching voltage" aria-label="Thresholds">
              <Stepper label="Switches at" bind:value={f.thr} min={0} max={5} step={0.1} decimals={1} unit="V" data-testid="thr" />
              <div class="grp"><span class="nx-label">Switch type</span>
                <Segmented label="Switch type" items={[{ value: '0', label: 'Momentary' }, { value: '1', label: 'Latching (toggle)' }]} bind:value={swVal} onchange={(v) => (f.swMode = Number(v))} /></div>
              <Checkbox bind:checked={f.swInvert} label="Invert" hint="On when the voltage is below the level." data-testid="sw-invert" />
              <Banner tone="info" title="No separate off level yet">The module switches at one voltage, so there is no gap to stop chatter. Not available yet: a separate "off at" level needs a firmware change. Put a Compare block with a turn-off value after it if the signal is noisy.</Banner>
            </Card>
          {/if}

          <Card title={f.mode === 'linear' ? 'Voltage from the sender' : 'Voltage and the switching level'} subtitle={'last 10 s · ' + (online ? 'live' : 'stopped')} aria-label="Live reading">
            <LineChart series={[{ label: 'Voltage', values: series.length ? series : [0, 0], color: 'var(--color-on)' }]} min={0} max={5} height={180} xLabels={['−10 s', '−7.5 s', '−5 s', '−2.5 s', 'now']}
              lines={f.mode === 'threshold' ? [{ value: Number(f.thr), label: `switches at ${Number(f.thr).toFixed(2)} V`, tone: 'warn' }]
                : [{ value: Number(f.highV), label: `high point ${Number(f.highV).toFixed(2)} V`, tone: 'warn' }, { value: Number(f.lowV), label: `low point ${Number(f.lowV).toFixed(2)} V`, tone: 'warn' }]}
              label={`Line graph of the input voltage over the last 10 seconds. Now ${mv != null ? (mv / 1000).toFixed(2) : 'unknown'} volts.`} />
            <p class="muted small">The scale runs from 0 V at the bottom to 5 V at the top.</p>
          </Card>
        </div>

        <div class="col">
          <Card title={f.mode === 'linear' ? 'Value now' : 'Pin voltage now'} aria-label="Live value">
            <div class="big" data-tone={pillTone} data-testid="big-value"><StateDot tone={pillTone} shape={pillTone === 'on' ? 'dot' : pillTone === 'fault' ? 'square' : 'ring'} label={mv == null ? '—' : f.mode === 'linear' && live2?.val != null ? live2.val + ' ' + f.unit : outRange ? 'Out of range' : (mv / 1000).toFixed(2) + ' V'} /></div>
            <p class="muted small">{mv == null ? 'No live reading.' : f.mode === 'linear' ? `at ${(mv / 1000).toFixed(2)} V, a straight line between your two points` : `Switch is ${swSig?.on ? 'ON' : 'OFF'}. Level ${Number(f.thr).toFixed(2)} V.`}</p>
          </Card>
          <Card title="How it reads" aria-label="How it reads">
            {#if f.mode === 'linear'}
              <div class="kv"><span>Formula</span><strong class="mono" data-testid="formula">value = {gain * 1000 >= 0.01 || gain * 1000 <= -0.01 ? (gain * 1000).toFixed(2) : (gain * 1000).toExponential(1)} × (V − {Number(f.lowV).toFixed(2)}) + {f.lowX}</strong></div>
              <div class="kv"><span>Sensor range</span><strong class="mono">{Math.min(f.lowV, f.highV).toFixed(2)} to {Math.max(f.lowV, f.highV).toFixed(2)} V</strong></div>
              <div class="kv"><span>Valid reading</span><strong class="mono">{(Math.min(f.lowV, f.highV) - 0.2).toFixed(2)} to {(Math.max(f.lowV, f.highV) + 0.2).toFixed(2)} V</strong></div>
              <p class="muted small">This page flags readings outside the range so a broken sender wire is easy to spot. The module itself only knows the two points.</p>
            {:else}
              <div class="kv"><span>Turns ON {f.swInvert ? 'below' : 'above'}</span><strong class="mono">{Number(f.thr).toFixed(2)} V</strong></div>
              <div class="kv"><span>Switch type</span><strong>{f.swMode === 1 ? 'Latching' : 'Momentary'}</strong></div>
            {/if}
          </Card>
          <UsedBy {guid} items={M.usedBy} />
        </div>
      </div>
    {/if}

    <SaveBar {dirty} saving={M.state.saving} {problem} err={M.state.saveErr} note={M.state.note} connected={online} onsave={save} onrevert={revert} />
  {/if}
</Page>

<style>
  .cols { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: var(--space-4); align-items: start; }
  .cols.one { grid-template-columns: minmax(0, 1fr); }
  .col { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
  @media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  .pin { font-size: var(--text-md); padding: 4px 10px; border-radius: var(--radius-sm); background: var(--color-raised); }
  .pill { display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 999px; background: var(--color-raised); font-weight: 600; }
  .pill[data-tone='on'] { background: var(--color-on-soft); }
  .pill[data-tone='fault'] { background: var(--color-fault-soft); }
  .grp { display: flex; flex-direction: column; gap: var(--space-2); align-items: flex-start; }
  .pt { display: grid; grid-template-columns: 100px 1fr 1fr auto; gap: var(--space-3); align-items: end; }
  .big { font-size: var(--text-2xl); font-weight: 700; }
  .kv { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) 0; border-bottom: 1px solid var(--color-line); }
  .small { font-size: var(--text-xs); }
  @media (max-width: 700px) { .pt { grid-template-columns: 1fr 1fr; } }
</style>
