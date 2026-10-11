<script>
  // Two drawings for a template: the WIRING (switches to their connector pins; each output with its load,
  // through a relay when asked, laid out for how that output switches — high side supplies +12 V, low side
  // pulls to ground) and the LINKS (signal path: input pin → over CAN → logic blocks → output pin).
  // ins/outs: [{k, label, opt (picker option: label, pin, side, …)}]; relays: {k: bool}; preview from
  // previewTemplate(). Pure SVG, downloadable.
  import { outputCircuit } from './templates.js'
  let { title = '', ins = [], outs = [], relays = {}, preview = null, logicName = '' } = $props()

  const LOAD = { lamp: 'lamp', motor: 'M', pump: 'P', fan: 'F', horn: 'H', load: 'L' }
  let wiringEl = $state(), linksEl = $state()

  // ---- wiring layout: inputs first, then one strip per output
  const IN_H = 54, OUT_H = 74, RELAY_H = 112
  const outH = (o) => (relays[o.k] ? RELAY_H : OUT_H)
  let wiringH = $derived(40 + ins.length * IN_H + 30 + outs.reduce((a, o) => a + outH(o), 0) + 20)
  const outY = (i) => 40 + ins.length * IN_H + 30 + outs.slice(0, i).reduce((a, o) => a + outH(o), 0)

  // ---- links layout: columns by depth
  let links = $derived.by(() => {
    if (!preview) return null
    const depth = new Map(), nodes = []
    ins.forEach((x) => depth.set('in:' + x.k, 0))
    depth.set('on', 0)
    for (const o of preview.ops) depth.set(o.id, 1 + Math.max(0, ...o.ins.map((i) => depth.get(i) ?? 0)))
    const last = 1 + Math.max(0, ...preview.ops.map((o) => depth.get(o.id)))
    const usedOn = preview.ops.some((o) => o.ins.includes('on'))
    const col = []
    const put = (id, d, label, sub, kind) => { (col[d] ??= []).push(id); nodes.push({ id, d, label, sub, kind }) }
    for (const x of ins) put('in:' + x.k, 0, x.label, x.opt ? shortIn(x.opt) : '', x.opt?.local === false ? 'remote' : 'in')
    if (usedOn) put('on', 0, 'Always on', '', 'in')
    for (const o of preview.ops) put(o.id, depth.get(o.id), o.name, o.detail, o.op)
    for (const w of preview.wires) { const x = outs.find((q) => q.num === w.out); put('out:' + w.out, last, x?.label ?? 'output ' + w.out, x?.opt ? shortOut(x.opt) : '', 'out') }
    const pos = new Map()
    nodes.forEach((n) => pos.set(n.id, { x: 10 + n.d * 230, y: 34 + col[n.d].indexOf(n.id) * 62 }))
    const edges = []
    for (const o of preview.ops) for (const i of o.ins) if (pos.has(i)) edges.push([i, o.id])
    for (const w of preview.wires) if (w.src && pos.has(w.src)) edges.push([w.src, 'out:' + w.out])
    const h = 50 + Math.max(...col.filter(Boolean).map((c) => c.length)) * 62
    return { nodes, edges, pos, w: 20 + (last + 1) * 230, h }
  })
  const shortIn = (o) => o.label.replace(/\s+\(over CAN\)$/, '') + (o.local === false ? ' · over CAN' : '')
  const shortOut = (o) => o.label.split(' · ').slice(0, 2).join(' · ')
  const KIND_COL = { in: '#2a9d8f', remote: '#e07a5f', condition: '#f77f00', flasher: '#caa600', timer: '#e36414', virtual: '#7209b7', wiper: '#457b9d', out: '#594ae2' }

  function download(el, name) {
    const src = new XMLSerializer().serializeToString(el)
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([src], { type: 'image/svg+xml' }))
    a.download = name.replace(/[^\w-]+/g, '_') + '.svg'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
</script>

{#snippet term(x, y, opt, fallback)}
  <rect x={x} y={y - 15} width="150" height="30" rx="5" class="g-mod" />
  <text x={x + 8} y={y - 2} class="g-t g-b">{opt?.module ?? fallback}</text>
  <text x={x + 8} y={y + 10} class="g-t g-s">{[opt?.pin?.label, opt?.tag].filter(Boolean).join(' · ') || 'no pin map'}</text>
{/snippet}
{#snippet ground(x, y)}
  <path d="M{x} {y} v8 M{x - 9} {y + 8} h18 M{x - 6} {y + 12} h12 M{x - 3} {y + 16} h6" class="g-w" />
{/snippet}
{#snippet fuse(x, y)}
  <rect x={x} y={y - 5} width="26" height="10" rx="2" class="g-sym" /><path d="M{x} {y} h26" class="g-w g-thin" />
{/snippet}
{#snippet plus12(x, y, fused)}
  <text x={x} y={y + 4} class="g-t g-b" text-anchor="end">+12 V</text>
  {#if fused}{@render fuse(x + 8, y)}<path d="M{x + 34} {y} h16" class="g-w" />{:else}<path d="M{x + 4} {y} h46" class="g-w" />{/if}
{/snippet}
{#snippet load(x, y, kind)}
  <circle cx={x} cy={y} r="14" class="g-sym" />
  {#if kind === 'lamp'}<path d="M{x - 10} {y - 10} l20 20 M{x + 10} {y - 10} l-20 20" class="g-w g-thin" />
  {:else}<text x={x} y={y + 4} text-anchor="middle" class="g-t g-b">{LOAD[kind] ?? ''}</text>{/if}
{/snippet}
{#snippet relay(x, y)}
  <rect x={x} y={y} width="84" height="76" rx="4" class="g-relay" />
  <rect x={x + 10} y={y + 26} width="16" height="24" class="g-sym" /><path d="M{x + 18} {y + 18} v8 M{x + 18} {y + 50} v8" class="g-w g-thin" />
  <path d="M{x + 66} {y + 58} l-12 -30 M{x + 66} {y + 18} v8" class="g-w g-thin" />
  <text x={x - 4} y={y + 16} class="g-t g-s" text-anchor="end">86</text><text x={x - 4} y={y + 64} class="g-t g-s" text-anchor="end">85</text>
  <text x={x + 88} y={y + 16} class="g-t g-s">87</text><text x={x + 88} y={y + 64} class="g-t g-s">30</text>
  <text x={x + 42} y={y + 72} class="g-t g-s" text-anchor="middle">relay</text>
{/snippet}

<div class="drw">
  <div class="dh"><b>Wiring</b><span class="muted">{logicName ? `logic runs on ${logicName}` : ''}</span>
    <button class="btn ghost sm" onclick={() => download(wiringEl, (title || 'template') + ' wiring')}>⬇ SVG</button></div>
  <svg bind:this={wiringEl} viewBox="0 0 720 {wiringH}" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Wiring diagram">
    {@html `<style>.g-t{font:11px system-ui,sans-serif;fill:currentColor}.g-b{font-weight:700}.g-s{font-size:10px;opacity:.75}.g-w{stroke:currentColor;stroke-width:1.6;fill:none}.g-thin{stroke-width:1.1}.g-sym{stroke:currentColor;stroke-width:1.4;fill:none}.g-mod{fill:rgba(89,74,226,.12);stroke:#594ae2}.g-relay{fill:none;stroke:currentColor;stroke-dasharray:4 3}.g-h{font:600 12px system-ui,sans-serif;fill:currentColor;opacity:.6}</style>`}
    <text x="10" y="22" class="g-h">INPUTS</text>
    {#each ins as x, i}
      {@const y = 40 + i * IN_H + 16}
      {#if !x.opt}
        <text x="20" y={y + 4} class="g-t g-s">{x.label}: not picked</text>
      {:else if !x.opt.pin}
        <text x="20" y={y} class="g-t g-b">{x.label}</text><text x="20" y={y + 14} class="g-t g-s">{shortIn(x.opt)} — a signal, no wire to run</text>
      {:else if x.opt.pin.conn === 'J2'}
        <!-- analog / rotary: sensor between the board's +5 V and ground, wiper to the pin -->
        <text x="20" y={y - 8} class="g-t g-b">{x.label}</text>
        <rect x="40" y={y + 2} width="40" height="12" class="g-sym" /><path d="M60 {y - 6} l0 8 M56 {y - 2} l4 4 4 -4" class="g-w g-thin" />
        <text x="20" y={y + 12} class="g-t g-s" text-anchor="end">+5V</text><path d="M24 {y + 8} h16 M80 {y + 8} h14" class="g-w" />{@render ground(94, y + 8)}
        <path d="M60 {y - 6} v-8 h330" class="g-w" />{@render term(390, y - 14, x.opt)}
        <text x="550" y={y - 10} class="g-t g-s">{x.opt.local === false ? 'sent over CAN to ' + logicName : ''}</text>
      {:else}
        <!-- switch: pin to ground (input pull-up) — or to +12 V with the input set to pull-down -->
        <text x="20" y={y - 8} class="g-t g-b">{x.label}</text>
        {@render ground(40, y + 6)}<path d="M40 {y + 6} v-6 l26 -10 M70 {y} h320" class="g-w" /><circle cx="70" cy={y} r="2.5" class="g-sym" />
        <text x="80" y={y + 14} class="g-t g-s">switch to ground (pull-up) — or to +12 V with pull-down</text>
        {@render term(390, y, x.opt)}
        <text x="550" y={y + 4} class="g-t g-s">{x.opt.local === false ? 'sent over CAN to ' + logicName : ''}</text>
      {/if}
    {/each}

    <text x="10" y={40 + ins.length * IN_H + 18} class="g-h">OUTPUTS</text>
    {#each outs as o, i}
      {@const y0 = outY(i)}
      {@const side = o.opt?.side ?? 'high'}
      {@const c = outputCircuit(side, !!relays[o.k])}
      <text x="10" y={y0 + 14} class="g-t g-b">{o.label}{o.opt ? '' : ': not picked'}</text>
      {#if o.opt}
        <text x="710" y={y0 + 14} class="g-t g-s" text-anchor="end">{side}-side output{relays[o.k] ? ' · through a relay' : ''}</text>
        {#if !relays[o.k] && side === 'high'}
          {@const y = y0 + 44}
          {@render term(20, y, o.opt)}<path d="M170 {y} h196" class="g-w" />{@render load(380, y, o.load)}<path d="M394 {y} h80" class="g-w" />{@render ground(474, y)}
        {:else if !relays[o.k]}
          {@const y = y0 + 44}
          {@render plus12(60, y, true)}<path d="M110 {y} h106" class="g-w" />{@render load(230, y, o.load)}<path d="M244 {y} h146" class="g-w" />{@render term(390, y, o.opt)}
          <text x="550" y={y + 4} class="g-t g-s">switches the load to ground</text>
        {:else}
          {@const y = y0 + 24}
          <!-- coil side: 86 top, 85 bottom -->
          {#if c.coil[0] === 'OUT'}
            {@render term(20, y + 12, o.opt)}<path d="M170 {y + 12} h130" class="g-w" />
            <path d="M260 {y + 60} h40" class="g-w" />{@render ground(260, y + 60)}
          {:else}
            {@render plus12(200, y + 12, true)}<path d="M250 {y + 12} h50" class="g-w" />
            {@render term(20, y + 60, o.opt)}<path d="M170 {y + 60} h130" class="g-w" />
          {/if}
          {@render relay(300, y - 4)}
          <!-- switched side: 30 from fused +12 V, 87 to the load -->
          <path d="M384 {y + 60} h86" class="g-w" />{@render fuse(470, y + 60)}<path d="M496 {y + 60} h14" class="g-w" /><text x="514" y={y + 64} class="g-t g-b">+12 V</text>
          <path d="M384 {y + 12} h176" class="g-w" />{@render load(574, y + 12, o.load)}<path d="M588 {y + 12} h40" class="g-w" />{@render ground(628, y + 12)}
        {/if}
      {/if}
    {/each}
  </svg>

  {#if links}
    <div class="dh"><b>Links</b><span class="muted">how the signals flow</span>
      <button class="btn ghost sm" onclick={() => download(linksEl, (title || 'template') + ' links')}>⬇ SVG</button></div>
    <svg bind:this={linksEl} viewBox="0 0 {links.w} {links.h}" width="100%" style="max-width:{links.w}px" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Signal links">
      {@html `<style>.g-t{font:11px system-ui,sans-serif;fill:currentColor}.g-b{font-weight:700}.g-s{font-size:10px;opacity:.75}.g-e{stroke:currentColor;stroke-width:1.3;fill:none;opacity:.55}.g-h{font:600 12px system-ui,sans-serif;fill:currentColor;opacity:.6}</style>`}
      <text x="10" y="18" class="g-h">INPUTS</text><text x={links.w - 10} y="18" class="g-h" text-anchor="end">OUTPUTS</text>
      {#each links.edges as [a, b]}
        {@const p = links.pos.get(a)}{@const q = links.pos.get(b)}
        <path d="M{p.x + 190} {p.y + 20} C{p.x + 215} {p.y + 20} {q.x - 25} {q.y + 20} {q.x} {q.y + 20}" class="g-e" />
      {/each}
      {#each links.nodes as n}
        {@const p = links.pos.get(n.id)}
        <rect x={p.x} y={p.y} width="190" height="40" rx="6" fill={KIND_COL[n.kind] ?? '#888'} fill-opacity=".16" stroke={KIND_COL[n.kind] ?? '#888'} />
        <text x={p.x + 8} y={p.y + 16} class="g-t g-b">{n.label.length > 30 ? n.label.slice(0, 29) + '…' : n.label}</text>
        <text x={p.x + 8} y={p.y + 31} class="g-t g-s">{(n.sub ?? '').length > 34 ? n.sub.slice(0, 33) + '…' : n.sub}</text>
      {/each}
    </svg>
  {/if}
</div>

<style>
  .drw { border: 1px solid var(--line); border-radius: var(--r); padding: 10px 12px; margin: 12px 0; background: var(--surface); color: var(--text, inherit); }
  .dh { display: flex; gap: 10px; align-items: center; margin: 4px 0 6px; }
  .dh button { margin-left: auto; }
  .sm { padding: 3px 8px; font-size: 12px; }
  svg { display: block; margin-bottom: 12px; }
</style>
