<script>
  /**
   * Block sheet (FC7): every function block and helper block with its ports, settings and what is inside.
   * Ports: ● on/off, ■ number, ◆ bundle. These are the recipes the "Replace with helper" matcher uses.
   */
  import { Dialog, Button } from '../../../ui/index.js'
  import { CATALOG } from './helpers.js'
  let { open = $bindable(false) } = $props()
  const port = (s) => (s[0] === '#' ? { sym: '■', name: s.slice(1) } : s[0] === '*' ? { sym: '◆', name: s.slice(1) } : { sym: '●', name: s })
  const sections = [
    { name: 'FUNCTION BLOCKS', note: 'one job on the car, many inputs and outputs', cards: CATALOG.filter((c) => c.kind === 'fn') },
    { name: 'HELPER BLOCKS', note: 'small reusable pieces; function blocks are built from these', cards: CATALOG.filter((c) => c.kind === 'helper') },
  ]
</script>

<Dialog bind:open title="Block sheet · function and helper blocks" description="Every port is generic: map any switch, CAN signal or output to it. Every block opens into ordinary blocks, so nothing is hidden." width={1100}>
  <p class="muted lg">● on/off · ■ number · ◆ bundle (several on/off signals in one wire). The builder suggests these where your blocks already match one; grouping never changes what the module runs.</p>
  {#each sections as sec (sec.name)}
    <section class="sec" aria-label={sec.name}>
      <h3><span>{sec.name}</span> <span class="muted note">{sec.note}</span></h3>
      <div class="cards">
        {#each sec.cards as c (c.key)}
          <article class="card" class:fn={c.kind === 'fn'}>
            <strong>{c.name}</strong>
            <span class="muted">{c.what}</span>
            <div class="io">
              <div><span class="h">IN</span>{#each c.ins as p (p)}{@const q = port(p)}<span class="p"><span aria-hidden="true">{q.sym}</span> {q.name}</span>{/each}{#if !c.ins.length}<span class="muted">none</span>{/if}</div>
              <div><span class="h">OUT</span>{#each c.outs as p (p)}{@const q = port(p)}<span class="p"><span aria-hidden="true">{q.sym}</span> {q.name}</span>{/each}</div>
            </div>
            <span class="h">SETTINGS</span>
            <ul>{#each c.settings as s (s)}<li>{s}</li>{/each}</ul>
            <span class="in"><strong>Inside:</strong> {c.inside}</span>
          </article>
        {/each}
      </div>
    </section>
  {/each}
  {#snippet footer()}<Button onclick={() => (open = false)}>Close</Button>{/snippet}
</Dialog>

<style>
  .lg { font-size: var(--text-xs); }
  .sec { display: flex; flex-direction: column; gap: 8px; }
  h3 { font-size: 12px; letter-spacing: 0.08em; }
  .note { font-weight: 400; letter-spacing: 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
  .card { display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: var(--radius-md); border: 1px solid var(--color-line); background: var(--color-raised); font-size: 13px; }
  .card.fn { border: 2px solid var(--color-accent); }
  .io { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .io > div { display: flex; flex-direction: column; gap: 2px; }
  .h { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); }
  .p { font-size: 12px; }
  ul { margin: 0; padding-left: 18px; font-size: 12px; color: var(--color-text-muted); }
  .in { font-size: 12px; }
</style>
