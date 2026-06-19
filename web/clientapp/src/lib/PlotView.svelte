<script>
  // Global plot (#4): chart any signal from any module, live. Show/hide lines, export PNG.
  import { api } from './store.js'
  import { clickable } from './a11y.js'
  let { devices = [] } = $props()

  const PALETTE = ['#594ae2', '#2a9d8f', '#e07a5f', '#f4a300', '#d62828', '#457b9d', '#b5179e', '#06998b', '#7209b7', '#3a86ff']

  let series = $state([])        // [{ id, guid, name, label, color, show, pts:[{t,v}] }]
  let win = $state(30)           // seconds visible
  let paused = $state(false)
  let canvas
  let nextColor = 0

  // add-series picker
  let pickGuid = $state('')
  let pickSignals = $state([])
  let pickName = $state('')

  async function loadPickSignals(g) {
    pickGuid = g; pickName = ''
    try { pickSignals = (await api.signals(g)).map((s) => s.name) } catch { pickSignals = [] }
  }
  $effect(() => { if (!pickGuid && devices.length) loadPickSignals(devices[0].guid) })

  function addSeries() {
    if (!pickGuid || !pickName) return
    const dev = devices.find((d) => d.guid === pickGuid)
    const id = pickGuid + '|' + pickName
    if (series.some((s) => s.id === id)) return
    series = [...series, { id, guid: pickGuid, name: pickName, label: `${dev?.name ?? '—'} · ${pickName}`,
      color: PALETTE[nextColor++ % PALETTE.length], show: true, pts: [] }]
  }
  function removeSeries(id) { series = series.filter((s) => s.id !== id) }
  function toggle(id) { series = series.map((s) => s.id === id ? { ...s, show: !s.show } : s) }
  function clearAll() { series = series.map((s) => ({ ...s, pts: [] })) }

  // ---- live sampling: one /signals call per distinct module, fanned out to its series ----
  $effect(() => {
    if (!series.length) return
    let alive = true
    const tick = async () => {
      if (paused || !alive) return
      const guids = [...new Set(series.map((s) => s.guid))]
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      for (const g of guids) {
        try {
          const sigs = await api.signals(g)
          if (!alive) return
          const byName = {}
          for (const s of sigs) { const n = parseFloat(s.value); byName[s.name] = Number.isFinite(n) ? n : (s.on ? 1 : 0) }
          for (const s of series) {
            if (s.guid !== g || !(s.name in byName)) continue
            s.pts.push({ t: now, v: byName[s.name] })
            const w = win * 1000 * 1.3
            while (s.pts.length > 2 && now - s.pts[0].t > w) s.pts.shift()
          }
        } catch {}
      }
      draw()
    }
    tick(); const iv = setInterval(tick, 300)
    return () => { alive = false; clearInterval(iv) }
  })

  function draw() {
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    const padL = 46, padB = 18, padT = 8, padR = 8
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    const w = win * 1000
    const vis = series.filter((s) => s.show && s.pts.length)
    // y-range across all visible series
    let lo = Infinity, hi = -Infinity
    for (const s of vis) for (const p of s.pts) if (now - p.t <= w) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v) }
    if (!isFinite(lo)) { lo = 0; hi = 1 }
    if (hi - lo < 1e-6) { hi += 1; lo -= 1 }
    const pad = (hi - lo) * 0.1; lo -= pad; hi += pad
    const X = (t) => padL + ((t - (now - w)) / w) * (W - padL - padR)
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB)
    // grid + axis labels
    ctx.strokeStyle = 'rgba(120,120,140,.18)'; ctx.fillStyle = '#888'; ctx.font = '10px system-ui'; ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const v = lo + (hi - lo) * (i / 4); const y = Y(v)
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke()
      ctx.fillText(v.toFixed(Math.abs(hi - lo) < 10 ? 1 : 0), 4, y + 3)
    }
    ctx.fillText('-' + win + 's', padL, H - 5); ctx.fillText('now', W - padR - 20, H - 5)
    // lines
    for (const s of vis) {
      ctx.beginPath(); let started = false
      for (const p of s.pts) { if (now - p.t > w) continue; const x = X(p.t), y = Y(p.v); started ? ctx.lineTo(x, y) : ctx.moveTo(x, y); started = true }
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.8; ctx.stroke()
    }
  }

  function exportPng() {
    if (!canvas) return
    // composite onto a white background so the PNG isn't transparent
    const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height
    const c = out.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, out.width, out.height); c.drawImage(canvas, 0, 0)
    const a = document.createElement('a'); a.href = out.toDataURL('image/png'); a.download = 'dingo-plot.png'; a.click()
  }
</script>

<div class="h-row">
  <div><h1>Plot</h1>
    <p class="sub">Chart any signal from any module live. Add series, toggle lines, export a PNG.</p></div>
  <div style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <label class="muted" style="font-size:13px">Window
      <select bind:value={win} style="margin-left:4px">{#each [10, 30, 60, 120, 300] as s}<option value={s}>{s}s</option>{/each}</select></label>
    <button class="btn ghost" onclick={() => (paused = !paused)}>{paused ? '▶ Resume' : '⏸ Pause'}</button>
    <button class="btn ghost" onclick={clearAll}>Clear</button>
    <button class="btn ghost" onclick={exportPng} disabled={!series.length}>⬇ Export PNG</button>
  </div>
</div>

<div class="card flat" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;padding:12px;margin-bottom:12px">
  <div class="field" style="margin:0"><label for="plotmod">Module</label>
    <select id="plotmod" value={pickGuid} onchange={(e) => loadPickSignals(e.target.value)}>
      {#each devices as d}<option value={d.guid}>{d.name}</option>{/each}
    </select></div>
  <div class="field" style="margin:0;min-width:200px"><label for="plotsig">Signal</label>
    <select id="plotsig" bind:value={pickName}>
      <option value="">—</option>
      {#each pickSignals as n}<option value={n}>{n}</option>{/each}
    </select></div>
  <button class="btn primary" disabled={!pickName} onclick={addSeries}>+ Add to plot</button>
  {#if !devices.length}<span class="muted">No modules — add one in System.</span>{/if}
</div>

<div style="background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:10px;box-shadow:var(--sh)">
  <canvas bind:this={canvas} width="1100" height="380" style="width:100%;height:380px;display:block"></canvas>
</div>

{#if series.length}
  <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
    {#each series as s (s.id)}
      <div class="chip" style="display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:20px;padding:4px 10px;font-size:13px;opacity:{s.show ? 1 : .45}">
        <span style="width:12px;height:12px;border-radius:3px;background:{s.color}" aria-hidden="true"></span>
        <span style="cursor:pointer" role="button" tabindex="0" use:clickable aria-pressed={s.show} onclick={() => toggle(s.id)}>{s.label}</span>
        <button class="x" title="Remove" aria-label={"Remove " + s.label} onclick={() => removeSeries(s.id)}>✕</button>
      </div>
    {/each}
  </div>
{:else}
  <p class="hint" style="margin-top:12px">Pick a module and a signal above, then <b>+ Add to plot</b>. Add as many as you like — from different modules too.</p>
{/if}
