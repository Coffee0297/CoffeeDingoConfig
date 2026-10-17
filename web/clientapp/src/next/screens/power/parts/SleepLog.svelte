<script>
  // Sleep and wake log: what each module said on the bus before it slept (its goodbye frame, with why) and when it
  // woke (its wake announcement, with why: CAN traffic, a digital input, USB, power-on). Firmware 5.6.3.
  import { onDestroy } from 'svelte'
  import { Card, Empty } from '../../../ui/index.js'
  import { href } from '../../../router.svelte.js'

  let rows = $state([]), err = $state('')
  let timer
  async function load() {
    try { const r = await fetch('/api/sleep-log'); rows = r.ok ? await r.json() : []; err = '' } catch (e) { err = e?.message ?? String(e) }
    timer = setTimeout(load, 3000)
  }
  load()
  onDestroy(() => clearTimeout(timer))
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
</script>

<Card title="Sleep and wake log" aria-label="Sleep and wake log">
  {#if err}<p class="muted">Could not read the log: {err}</p>
  {:else if !rows.length}
    <Empty title="Nothing yet" text="Each module reports here when it goes to sleep and when it wakes, with why (firmware 5.6.3)." />
  {:else}
    <ol class="log" data-testid="sleep-log">
      {#each rows.slice(0, 40) as r, i (i)}
        <li data-kind={r.kind}>
          <span class="t mono muted">{time(r.at)}</span>
          <span class="k" aria-hidden="true">{r.kind === 'sleep' ? '☾' : '☀'}</span>
          <span><a href={href('hardware', 'module', r.guid)}>{r.module}</a> {r.kind === 'sleep' ? 'went to sleep: ' : 'is awake: '}{r.why}</span>
        </li>
      {/each}
    </ol>
  {/if}
</Card>

<style>
  .log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 360px; overflow: auto; }
  .log li { display: grid; grid-template-columns: 72px 18px minmax(0, 1fr); gap: 8px; align-items: baseline; padding: 4px 0; border-bottom: 1px solid var(--color-line); font-size: var(--text-sm); }
  .log li[data-kind='sleep'] .k { color: var(--color-text-muted); }
  .log li[data-kind='wake'] .k { color: var(--color-accent); }
  .t { font-size: var(--text-xs); }
</style>
