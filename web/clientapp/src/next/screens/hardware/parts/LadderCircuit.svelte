<script>
  // Schematic of the resistor-ladder circuit the designer is calculating: 'ground' (pull-up, each position a
  // resistor to ground) or 'inline' (a series resistor into the switch, each leg its own resistor to the input).
  // Resistors drawn as IEC boxes; strokes follow the text colour so it works in both themes.
  let { kind = 'ground', rpu = 470, rs = 1000 } = $props()
  const ohms = (r) => (r >= 1000 ? (r / 1000) + ' kΩ' : r + ' Ω')
  const LEGS = [62, 98, 134]   // y of the three drawn legs; a fourth row shows "…"
</script>

{#if kind === 'inline'}
  <svg viewBox="0 0 600 196" role="img" aria-label={`Inline circuit: 5 volt through ${ohms(rs)} into the switch common, each position its own resistor, all legs joined to the analog input`}>
    <text x="8" y="34">+5 V</text>
    <line x1="44" y1="30" x2="64" y2="30" />
    <rect x="64" y="22" width="54" height="16" rx="2" />
    <text x="91" y="16" text-anchor="middle" class="em">{ohms(rs)}</text>
    <line x1="118" y1="30" x2="170" y2="30" />
    <line x1="170" y1="30" x2="170" y2={LEGS[1]} />
    <circle cx="170" cy={LEGS[1]} r="3" class="dot" />
    <line x1="170" y1={LEGS[1]} x2="212" y2={LEGS[0] + 3} class="wiper" />
    <text x="150" y={LEGS[1] + 28} text-anchor="middle" class="muted">switch</text>
    {#each LEGS as y, i (i)}
      <circle cx="216" cy={y} r="3" class="dot" />
      <line x1="219" y1={y} x2="252" y2={y} />
      <rect x="252" y={y - 8} width="54" height="16" rx="2" />
      <text x="279" y={y - 12} text-anchor="middle">R{i + 1}</text>
      <line x1="306" y1={y} x2="350" y2={y} />
    {/each}
    <text x="216" y="174" text-anchor="middle" class="muted">⋮</text>
    <text x="279" y="174" text-anchor="middle" class="muted">R…</text>
    <line x1="350" y1={LEGS[0]} x2="350" y2={LEGS[2]} />
    <line x1="350" y1={LEGS[1]} x2="420" y2={LEGS[1]} />
    <rect x="420" y={LEGS[1] - 26} width="168" height="52" rx="6" class="box" />
    <text x="504" y={LEGS[1] - 6} text-anchor="middle" class="em">Analog input</text>
    <text x="504" y={LEGS[1] + 12} text-anchor="middle" class="muted">14.7 kΩ to ground inside</text>
    <text x="380" y={LEGS[1] - 8} text-anchor="middle" class="muted">1 wire</text>
  </svg>
  <p class="cap">5 V goes through <strong>{ohms(rs)}</strong> into the switch's centre; each position has its own resistor, and all positions join on one wire to the input. A bigger resistor gives a lower voltage. Between positions nothing connects, so the input reads 0 V (no position), the same as a broken wire.</p>
{:else}
  <svg viewBox="0 0 600 196" role="img" aria-label={`To-ground circuit: 5 volt through a ${ohms(rpu)} pull-up to the analog input, each position grounds the input through its own resistor`}>
    <text x="8" y="34">+5 V</text>
    <line x1="44" y1="30" x2="64" y2="30" />
    <rect x="64" y="22" width="54" height="16" rx="2" />
    <text x="91" y="16" text-anchor="middle" class="em">{ohms(rpu)}</text>
    <line x1="118" y1="30" x2="420" y2="30" />
    <circle cx="170" cy="30" r="3" class="dot" />
    <line x1="170" y1="30" x2="170" y2={LEGS[2]} />
    {#each LEGS as y, i (i)}
      <line x1="170" y1={y} x2="200" y2={y} />
      <rect x="200" y={y - 8} width="54" height="16" rx="2" />
      <text x="227" y={y - 12} text-anchor="middle">R{i + 1}</text>
      <line x1="254" y1={y} x2="290" y2={y} />
      <circle cx="293" cy={y} r="3" class="dot" />
    {/each}
    <text x="227" y="174" text-anchor="middle" class="muted">R…</text>
    <circle cx="340" cy={LEGS[1]} r="3" class="dot" />
    <line x1="340" y1={LEGS[1]} x2="297" y2={LEGS[0] + 3} class="wiper" />
    <line x1="340" y1={LEGS[1]} x2="340" y2="160" />
    <line x1="328" y1="160" x2="352" y2="160" /><line x1="332" y1="165" x2="348" y2="165" /><line x1="336" y1="170" x2="344" y2="170" />
    <text x="362" y={LEGS[1] + 4} class="muted">switch to ground</text>
    <rect x="420" y="4" width="168" height="52" rx="6" class="box" />
    <text x="504" y="24" text-anchor="middle" class="em">Analog input</text>
    <text x="504" y="42" text-anchor="middle" class="muted">14.7 kΩ to ground inside</text>
  </svg>
  <p class="cap">5 V goes through the <strong>{ohms(rpu)}</strong> pull-up to the input; the switch grounds the input through the resistor of its position. A smaller resistor gives a lower voltage, and a position with no resistor (open) reads the top. Hall switches and other sensors that pull to ground work the same way.</p>
{/if}

<style>
  svg { width: 100%; max-width: 640px; height: auto; color: var(--color-text); display: block; }
  line, rect { stroke: currentColor; stroke-width: 1.6; fill: none; }
  rect.box { stroke: var(--color-line-strong); fill: var(--color-raised); }
  .wiper { stroke: var(--color-accent); stroke-width: 2.2; }
  .dot { fill: currentColor; stroke: none; }
  text { fill: currentColor; font-size: 12px; font-family: var(--font-mono); }
  text.em { font-weight: 700; }
  text.muted { fill: var(--color-text-muted); font-size: 11px; }
  .cap { margin: 0; font-size: var(--text-sm); color: var(--color-text-muted); }
</style>
