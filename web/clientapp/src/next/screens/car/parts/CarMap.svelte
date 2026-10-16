<script>
  // Car-layout map: one pin per module, dragged where it sits in the car. Positions are percentages of
  // the map, stored in this browser under the same key the old UI uses ("pinpos") and saved with the
  // project file (its client section, G4), so another PC that opens the file gets the same layout.
  import { Button, StateDot } from '../../../ui/index.js'
  import { moduleState, live } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import { isTripped, isOn, fmt1, num, olderFirmware } from './summary.js'

  let { devices = [] } = $props()

  const KEY = 'pinpos'
  const defaults = [[26, 22], [74, 22], [26, 80], [74, 80], [50, 52], [50, 12], [50, 91], [50, 36], [26, 52], [74, 52]]
  const readPos = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} } }
  let pos = $state(readPos())
  let note = $state('')
  let stage
  let drag = null

  const posOf = (guid, i) => pos[guid] ?? { x: defaults[i % defaults.length][0], y: defaults[i % defaults.length][1] }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(pos)) } catch { /* private mode: keep in memory */ } }
  const clamp = (v) => Math.max(4, Math.min(96, v))

  const older = $derived(new Set(olderFirmware(devices).map((o) => o.dev.guid)))

  function pinInfo(d) {
    const st = moduleState(d)
    const tripped = (d.outputs ?? []).some(isTripped)
    const on = (d.outputs ?? []).filter(isOn).length
    let tone = st.key, shape = st.shape, word = st.word, border = 'line'
    let value
    if (!d.connected) { value = live.connected ? 'not answering' : 'no connection'; border = 'fault' }
    else if (tripped) { tone = 'fault'; shape = 'square'; border = 'fault'; value = 'output tripped' }
    else if (/pdm/i.test(d.type)) value = `${fmt1(num(d.current))} A · ${on} on`
    else value = `${Number.isFinite(d.temp) ? Math.round(d.temp) + ' °C' : 'CANBoard'}`
    if (d.connected && !tripped && st.key === 'off') value = 'asleep'
    let flag = ''
    if (d.connected && !tripped && d.configMismatch) { border = 'warn'; flag = 'differs from project' }
    else if (d.connected && !tripped && older.has(d.guid)) { border = 'warn'; flag = 'older firmware' }
    return { tone, shape, word, value, border, flag }
  }

  function down(e, g) {
    if (e.button !== 0) return
    drag = { g, x: e.clientX, y: e.clientY, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function move(e) {
    if (!drag || !stage) return
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return
    drag.moved = true
    const r = stage.getBoundingClientRect()
    pos = { ...pos, [drag.g]: { x: clamp(((e.clientX - r.left) / r.width) * 100), y: clamp(((e.clientY - r.top) / r.height) * 100) } }
  }
  function up() { if (drag?.moved) { save(); note = 'Layout saved in this browser.' } setTimeout(() => (drag = null), 0) }
  function click(e) { if (drag?.moved) e.preventDefault() }
  function key(e, g, i, name) {
    const step = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] }[e.key]
    if (!step) return
    e.preventDefault()
    const p = posOf(g, i)
    const n = { x: clamp(p.x + step[0]), y: clamp(p.y + step[1]) }
    pos = { ...pos, [g]: n }
    save()
    note = `${name} moved to ${Math.round(n.x)} across, ${Math.round(n.y)} down.`
  }
  function reset() {
    const next = { ...pos }
    for (const d of devices) delete next[d.guid]
    pos = next; save(); note = 'Layout reset to the default.'
  }
</script>

<section class="map" aria-label="Car map">
  <header>
    <h2>Where everything is</h2>
    <span class="muted hint" id="map-hint">Front is up. Drag a module, or focus it and use the arrow keys. Saved in this browser only.</span>
    <Button size="sm" variant="ghost" onclick={reset}>Reset layout</Button>
  </header>
  <div class="stage" bind:this={stage}>
    <div class="body" aria-hidden="true"></div>
    <div class="cabin" aria-hidden="true"></div>
    <div class="rear" aria-hidden="true"></div>
    {#each [[-1, 20], [1, 20], [-1, 66], [1, 66]] as w, i (i)}<div class="wheel" style="left: calc(50% + {w[0] * 190}px - 13px); top: {w[1]}%" aria-hidden="true"></div>{/each}
    {#each devices as d, i (d.guid)}
      {@const p = posOf(d.guid, i)}
      {@const info = pinInfo(d)}
      <a class="pin" data-border={info.border} data-guid={d.guid} href={href('hardware', 'module', d.guid)} style="left: {p.x}%; top: {p.y}%"
        aria-describedby="map-hint" draggable="false" ondragstart={(e) => e.preventDefault()} onpointerdown={(e) => down(e, d.guid)} onpointermove={move} onpointerup={up} onpointercancel={up} onclick={click} onkeydown={(e) => key(e, d.guid, i, d.name)}>
        <StateDot tone={info.tone} shape={info.shape} />
        <span class="t"><strong>{d.name}</strong><span class="v mono">{info.value}</span>{#if info.flag || info.word !== 'Connected'}<span class="w">{info.flag || info.word}</span>{/if}</span>
      </a>
    {/each}
  </div>
  <p class="sr-only" role="status">{note}</p>
</section>

<style>
  .map { border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); display: flex; flex-direction: column; min-width: 0; }
  header { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-4) var(--space-5) 0; flex-wrap: wrap; }
  h2 { font-size: var(--text-lg); font-weight: 700; }
  .hint { flex: 1 1 280px; font-size: var(--text-xs); text-align: right; min-width: 0; }
  .stage { position: relative; height: 680px; margin: var(--space-2) var(--space-3) var(--space-3); touch-action: none; overflow: hidden; border-radius: var(--radius-md); }
  .body { position: absolute; left: 50%; top: 4%; width: 360px; height: 92%; margin-left: -180px; border: 2px solid var(--color-line-strong); border-radius: 140px 140px 100px 100px; background: var(--color-bg); }
  .cabin { position: absolute; left: 50%; top: 22%; width: 300px; height: 18%; margin-left: -150px; border: 1px solid var(--color-line); border-radius: 40px 40px 12px 12px; }
  .rear { position: absolute; left: 50%; top: 62%; width: 300px; height: 14%; margin-left: -150px; border: 1px solid var(--color-line); border-radius: 12px 12px 30px 30px; }
  .wheel { position: absolute; width: 26px; height: 14%; border-radius: 10px; background: var(--color-line-strong); }
  .pin { position: absolute; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 10px; min-height: var(--target-min); padding: 8px 14px 8px 10px; border-radius: var(--radius-md); background: var(--color-raised); border: 1px solid var(--color-line); box-shadow: var(--shadow-1); color: var(--color-text); text-decoration: none; cursor: grab; user-select: none; max-width: 230px; }
  .pin:active { cursor: grabbing; }
  .pin[data-border='warn'] { border-color: var(--color-warn); }
  .pin[data-border='fault'] { border-color: var(--color-fault); border-width: 2px; }
  .t { display: flex; flex-direction: column; min-width: 0; }
  .t strong { font-weight: 600; }
  .v { font-size: var(--text-xs); color: var(--color-text-muted); }
  .w { font-size: 11px; color: var(--color-text-muted); }
  .pin[data-border='fault'] .w, .pin[data-border='fault'] .v { color: var(--color-fault); }
  .pin[data-border='warn'] .w { color: var(--color-warn); }
</style>
