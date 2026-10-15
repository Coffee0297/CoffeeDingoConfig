<script>
  // The TEST / LINK LOST strip shown at the top of the output page while a bench test is running.
  import { Button } from '../../../ui/index.js'
  let { bench, name = 'This output', modName = 'the module', outNo = 0 } = $props()
  const b = $derived(bench.state)
  const left = $derived(Math.ceil(bench.remaining()))
  const lost = $derived(b.phase === 'lost')
</script>

{#if b.phase === 'running' || b.phase === 'lost'}
  <div class="bn" class:lost role="alert" data-testid="bench-banner">
    <span class="word">{lost ? 'LINK LOST' : 'TEST'}</span>
    <div class="t">
      <strong>{lost ? `Lost contact with ${modName} during the test` : `${name} is forced ${b.mode === 'pwm' ? `on at ${b.duty} % PWM` : 'ON'}`}</strong>
      <span>{lost
        ? `Lost ${(bench.elapsed() - b.lostAt).toFixed(1)} s ago. dingoConfig cannot see or stop the output now. ${modName} turns it off by itself when its ${bench.holdS()} s timer ends.`
        : `${modName} out ${outNo} is on for ${bench.holdS()} s. Its normal rule is paused for this output. Current limits stay active.`}</span>
    </div>
    <div class="c">
      <span role="timer" class="mono" data-testid="bench-count">{lost ? `off in about ${left} s` : `auto-off in ${left} s`}</span>
      <span class="muted">{lost ? 'module timer, not confirmed' : 'ends by itself, or press Stop now'}</span>
    </div>
    <Button variant="danger" disabled={lost} onclick={() => bench.stop()} data-testid="bench-stop-top">{lost ? 'Stop now unavailable' : 'Stop now'}</Button>
  </div>
{/if}

<style>
  .bn { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); border: 2px solid var(--color-fault); background: var(--color-fault-soft); flex-wrap: wrap; }
  .bn.lost { border-color: var(--color-warn); background: var(--color-warn-soft); }
  .word { font-weight: 800; letter-spacing: 0.1em; color: var(--color-fault); border: 2px solid currentColor; padding: 4px 10px; border-radius: var(--radius-sm); }
  .lost .word { color: var(--color-warn); }
  .t { flex: 1 1 260px; display: flex; flex-direction: column; gap: 2px; }
  .t span { font-size: var(--text-sm); }
  .c { display: flex; flex-direction: column; align-items: flex-end; font-size: var(--text-sm); }
</style>
