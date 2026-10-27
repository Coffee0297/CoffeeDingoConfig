<script>
  /**
   * Sentence view: the same blocks as the canvas, read as plain sentences. Every token is a button that
   * opens that block (or the block it names) in the inspector. Unfinished blocks are outlined and say why.
   */
  import { Chip } from '../../../ui/index.js'
  import { FAM_COLOR } from './model.js'
  import { sentenceFor, cardKind } from './sentence.js'
  import { fmt } from './livevals.js'

  let { model, lv, selected = null, onpick, onopencanvas } = $props()
  const ORDER = { condition: 1, virtualinput: 2, timer: 3, flasher: 4, counter: 5, table: 6, caninput: 0, output: 8, digitaloutput: 8, canoutput: 9 }
  const cards = $derived([...model.nodes.values()].map((n) => ({ n, segs: sentenceFor(model, n) })).filter((c) => c.segs)
    .sort((a, b) => (ORDER[a.n.kind] ?? 7) - (ORDER[b.n.kind] ?? 7) || a.n.title.localeCompare(b.n.title)))
  function now(n) {
    const st = lv.st[n.id]
    const pre = lv.sim ? 'Simulating: ' : 'Now: '
    if (st?.text) return pre + st.text.toLowerCase() + (st.why ? ' · ' + st.why : '')
    const p = n.outs.find((x) => x.type === 'bool') ?? n.outs[0]
    return p ? pre + p.label.toLowerCase() + ' ' + fmt(lv.v[p.idx]).toLowerCase() : ''
  }
</script>

<div class="sv">
  {#if !cards.length}
    <p class="muted">This module has no logic blocks yet. Add one with + Add, or open the canvas.</p>
  {/if}
  {#each cards as c (c.n.id)}
    {@const inc = c.n.incomplete?.length}
    <article class="card" class:inc class:sel={selected === c.n.id} style="--fam: {FAM_COLOR[c.n.fam]}" aria-label={c.n.title}>
      <div class="top">
        <span class="k">{cardKind(c.n, model.upstream)}</span>
        {#if inc}<Chip tone="fault" symbol="▲" dashed>NEEDS ATTENTION</Chip>{/if}
        {#if c.n.remote}<Chip tone="on" symbol="◆">OVER CAN</Chip>{/if}
        <span class="grow"></span>
        <button type="button" class="act" onclick={() => onpick?.(c.n.id)}>Edit</button>
        <button type="button" class="act" onclick={() => onopencanvas?.(c.n.id)}>Show on canvas</button>
      </div>
      <p class="line">
        {#each c.segs as g, i (i)}
          {#if g.t}<span>{g.t + ' '}</span>{:else}<button type="button" class="tok {g.tok}" aria-label={g.tok === 'missing' ? g.label + ', required, ' + c.n.title : g.label + ', open'} onclick={() => onpick?.(g.node ?? c.n.id)}>{g.label}{#if g.idx && lv.v[g.idx] != null}<span class="lvv"> {fmt(lv.v[g.idx])}</span>{/if}</button>{' '}{/if}
        {/each}
      </p>
      <span class="now" class:bad={inc}>{inc ? '▲ ' + c.n.incomplete.join('; ') + '.' : now(c.n)}</span>
    </article>
  {/each}
</div>

<style>
  .sv { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); overflow: auto; height: 100%; box-sizing: border-box; }
  .card { border: 1px solid var(--color-line); border-left: 4px solid var(--fam); border-radius: var(--radius-md); background: var(--color-surface); padding: var(--space-3) var(--space-4); display: flex; flex-direction: column; gap: 8px; }
  .card.sel { border-color: var(--color-accent); border-left-color: var(--fam); box-shadow: 0 0 0 2px var(--color-accent); }
  .card.inc { border: 2px dashed var(--color-fault); border-left: 4px solid var(--fam); }
  .top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .k { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--fam); }
  .grow { flex: 1 1 auto; }
  .act { min-height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--color-line-strong); background: transparent; color: var(--color-text); font-size: 13px; }
  .line { font-size: 18px; line-height: 2; }
  .tok { display: inline-flex; align-items: center; min-height: 34px; padding: 0 10px; margin: 0 2px; border-radius: 8px; border: 1px solid var(--color-line-strong); background: var(--color-raised); color: var(--color-text); font-size: 16px; font-weight: 600; vertical-align: middle; }
  .tok.self { border-color: var(--fam); }
  .tok.val { font-family: var(--font-mono); font-weight: 500; }
  .tok.missing { border: 2px dashed var(--color-fault); background: var(--color-fault-soft); color: var(--color-fault); }
  .lvv { font-family: var(--font-mono); font-size: 12px; color: var(--color-on); }
  .now { font-size: var(--text-xs); color: var(--color-text-muted); }
  .now.bad { color: var(--color-fault); font-weight: 600; }
</style>
