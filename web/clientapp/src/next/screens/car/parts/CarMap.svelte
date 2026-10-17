<script>
  import { tick } from 'svelte'
  // Car-layout map: one pin per module, dragged where it sits in the car. The layout itself (positions as %
  // of the car outline, "pinpos", saved with the project file) is shared with every map: layout.svelte.js.
  // Modules with no position wait in the tray beside the car, drawn dashed.
  import { Button, StateDot } from '../../../ui/index.js'
  import { moduleState, live, outputsOf } from '../../../lib/live.svelte.js'
  import { href } from '../../../router.svelte.js'
  import { isTripped, isOn, fmt1, num, olderFirmware } from './summary.js'
  import { layout, refreshLayout, setPos, unplace, persistLayout, defaultSpot, placeAt } from './layout.svelte.js'

  let { devices = [] } = $props()

  let note = $state('')
  let trayHold = $state(false)   // keep the tray while a module is dragged out of it, so the car does not jump
  let car = $state(), tray = $state()
  let drag = null

  const placed = $derived(devices.filter((d) => layout.pos[d.guid]))
  const unplaced = $derived(devices.filter((d) => !layout.pos[d.guid]))
  const clamp = (v) => Math.max(4, Math.min(96, v))
  // Another screen, the old UI or opening a project may rewrite the layout: pick that up.
  $effect(() => { const t = setInterval(refreshLayout, 1000); return () => clearInterval(t) })

  const older = $derived(new Set(olderFirmware(devices).map((o) => o.dev.guid)))

  function pinInfo(d) {
    const st = moduleState(d)
    const tripped = (d.outputs ?? []).some(isTripped)
    const on = outputsOf(d).filter(isOn).length
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
  }
  const inside = (el, e) => { if (!el) return false; const r = el.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom }
  function move(e) {
    if (!drag || !car) return
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return
    if (!drag.moved) trayHold = !layout.pos[drag.g]
    drag.moved = true
    if (inside(tray, e)) { if (layout.pos[drag.g]) unplace(drag.g, false); return }   // back into the tray
    const r = car.getBoundingClientRect()
    setPos(drag.g, { x: clamp(((e.clientX - r.left) / r.width) * 100), y: clamp(((e.clientY - r.top) / r.height) * 100) }, false)
  }
  function up() {
    if (drag?.moved) { persistLayout(); note = layout.pos[drag.g] ? 'Layout saved in this browser.' : 'Moved back to the tray.' }
    trayHold = false
    setTimeout(() => (drag = null), 0)
  }
  function click(e) { if (drag?.moved) e.preventDefault() }
  function key(e, g, name) {
    const step = { ArrowLeft: [-2, 0], ArrowRight: [2, 0], ArrowUp: [0, -2], ArrowDown: [0, 2] }[e.key]
    if (!step) return
    e.preventDefault()
    const p = layout.pos[g]
    const n = p ? { x: clamp(p.x + step[0]), y: clamp(p.y + step[1]) } : defaultSpot(devices, g)   // from the tray: its default spot
    setPos(g, n)
    note = `${name} moved to ${Math.round(n.x)} across, ${Math.round(n.y)} down.`
    if (!p) tick().then(() => document.querySelector(`.pin[data-guid="${g}"]`)?.focus())   // it left the tray: a new element
  }
  function reset() { placeAt(devices, devices.map((d) => d.guid)); note = 'Layout reset to the default.' }
  function placeRest() { const n = unplaced.length; placeAt(devices, unplaced.map((d) => d.guid)); note = `${n} module${n === 1 ? '' : 's'} put on the car.` }
</script>

<svelte:window onpointermove={move} onpointerup={up} onpointercancel={up} />

{#snippet pin(d, p)}
  {@const info = pinInfo(d)}
  <a class="pin" class:loose={!p} data-border={info.border} data-guid={d.guid} href={href('hardware', 'module', d.guid)} style={p ? `left: ${p.x}%; top: ${p.y}%` : ''}
    aria-describedby="map-hint" draggable="false" ondragstart={(e) => e.preventDefault()} onpointerdown={(e) => down(e, d.guid)} onclick={click} onkeydown={(e) => key(e, d.guid, d.name)}>
    <StateDot tone={info.tone} shape={info.shape} />
    <span class="t"><strong>{d.name}</strong><span class="v mono">{info.value}</span>{#if !p}<span class="sr-only">not placed</span>{/if}{#if info.flag || info.word !== 'Connected'}<span class="w">{info.flag || info.word}</span>{/if}</span>
  </a>
{/snippet}

<section class="map" aria-label="Car map">
  <header>
    <div class="hd"><h2>Where everything is</h2><span class="muted hint" id="map-hint">Front is up. Drag a module, or focus it and use the arrow keys. Saved in this browser.</span></div>
    <Button size="sm" variant="ghost" onclick={reset}>Reset layout</Button>
  </header>
  <div class="area">
    {#if unplaced.length || trayHold}
      <div class="tray" bind:this={tray} role="group" aria-label="Not placed yet" data-testid="map-tray">
        <span class="th">Not placed yet{unplaced.length ? ` · ${unplaced.length}` : ''}</span>
        {#each unplaced as d (d.guid)}{@render pin(d, null)}{/each}
        {#if unplaced.length}<Button size="sm" variant="ghost" onclick={placeRest}>Place {unplaced.length === 1 ? 'it' : 'them'} for me</Button>{/if}
      </div>
    {/if}
    <div class="stage">
      <div class="car" bind:this={car}>
        <div class="body" aria-hidden="true"></div>
        <div class="cabin" aria-hidden="true"></div>
        <div class="rear" aria-hidden="true"></div>
        {#each [[1.7, 20], [92.1, 20], [1.7, 66], [92.1, 66]] as w, i (i)}<div class="wheel" style="left: {w[0]}%; top: {w[1]}%" aria-hidden="true"></div>{/each}
        {#each placed as d (d.guid)}{@render pin(d, layout.pos[d.guid])}{/each}
      </div>
    </div>
  </div>
  <p class="sr-only" role="status">{note}</p>
</section>

<style>
  .map { container-type: inline-size; border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); display: flex; flex-direction: column; min-width: 0; }
  header { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-4) var(--space-5) 0; }
  .hd { flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  h2 { font-size: var(--text-lg); font-weight: 700; }
  .hint { font-size: var(--text-xs); }
  .area { display: flex; flex-wrap: wrap; gap: var(--space-3); margin: var(--space-2) var(--space-3) var(--space-3); }
  .tray { flex: 0 0 190px; max-height: clamp(360px, 62vh, 560px); overflow-y: auto; display: flex; flex-wrap: wrap; align-content: flex-start; gap: var(--space-2); padding: var(--space-3); border: 1px dashed var(--color-line-strong); border-radius: var(--radius-md); touch-action: none; }
  .th { flex: 1 0 100%; font-size: var(--text-xs); font-weight: 600; color: var(--color-text-muted); }
  .stage { flex: 1 1 360px; min-width: min(360px, 100%); position: relative; height: clamp(360px, 62vh, 560px); touch-action: none; overflow: hidden; border-radius: var(--radius-md); }
  /* the car keeps its shape and fits the height; pins are placed in % of it */
  .car { position: absolute; top: 0; left: 50%; height: 100%; aspect-ratio: 420 / 680; transform: translateX(-50%); }
  .body { position: absolute; left: 7.1%; top: 4%; width: 85.8%; height: 92%; border: 2px solid var(--color-line-strong); border-radius: 39% 39% 28% 28% / 22% 22% 16% 16%; background: var(--color-bg); }
  .cabin { position: absolute; left: 14.3%; top: 22%; width: 71.4%; height: 18%; border: 1px solid var(--color-line); border-radius: 40px 40px 12px 12px; }
  .rear { position: absolute; left: 14.3%; top: 62%; width: 71.4%; height: 14%; border: 1px solid var(--color-line); border-radius: 12px 12px 30px 30px; }
  .wheel { position: absolute; width: 6.2%; height: 14%; border-radius: 10px; background: var(--color-line-strong); }
  .pin { position: absolute; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 10px; min-height: var(--target-min); padding: 8px 14px 8px 10px; border-radius: var(--radius-md); background: var(--color-raised); border: 1px solid var(--color-line); box-shadow: var(--shadow-1); color: var(--color-text); text-decoration: none; cursor: grab; user-select: none; width: max-content; max-width: 200px; touch-action: none; }
  .pin.loose { position: static; transform: none; flex: 1 1 150px; width: auto; min-height: 0; padding: 4px 10px 4px 8px; border-style: dashed; border-color: var(--color-line-strong); box-shadow: none; }
  .pin:active { cursor: grabbing; }
  .pin[data-border='warn'] { border-color: var(--color-warn); }
  .pin[data-border='fault'] { border-color: var(--color-fault); border-width: 2px; }
  .t { display: flex; flex-direction: column; min-width: 0; }
  .t strong { font-weight: 600; }
  .v { font-size: var(--text-xs); color: var(--color-text-muted); }
  .w { font-size: 11px; color: var(--color-text-muted); }
  .pin[data-border='fault'] .w, .pin[data-border='fault'] .v { color: var(--color-fault); }
  .pin[data-border='warn'] .w { color: var(--color-warn); }
  @container (max-width: 640px) { .tray { flex-basis: 100%; max-height: none; } }
  @media (max-width: 900px) { .stage { height: 440px; } .pin { max-width: 150px; padding: 6px 10px 6px 8px; } }
</style>
