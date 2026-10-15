<script>
  // System log (this app and the modules) from GET /api/syslog, newest first, polled once a second.
  import { Button, Segmented, Banner } from '../../../ui/index.js'
  import { api } from '../../../lib/live.svelte.js'

  let entries = $state([])
  let stale = $state(false)
  let level = $state('all')
  let filter = $state('')

  async function load() {
    try { entries = (await api.syslog()) ?? []; stale = false } catch { stale = true }
  }
  $effect(() => {
    let alive = true
    load()
    const id = setInterval(() => { if (alive) load() }, 1000)
    return () => { alive = false; clearInterval(id) }
  })

  const kind = (l) => (/error|fatal|critical/i.test(l) ? 'error' : /warn/i.test(l) ? 'warn' : 'info')
  const META = { info: { word: 'Info', glyph: '○' }, warn: { word: 'Warning', glyph: '▲' }, error: { word: 'Error', glyph: '■' } }
  const q = $derived(filter.trim().toLowerCase())
  const rows = $derived(entries.filter((e) => {
    const k = kind(e.level)
    if (level === 'warn' && k === 'info') return false
    if (level === 'error' && k !== 'error') return false
    return !q || `${e.source} ${e.message}`.toLowerCase().includes(q)
  }))
</script>

<div class="wrap">
  <div class="bar">
    <Segmented label="Show levels" bind:value={level} items={[{ value: 'all', label: 'All' }, { value: 'warn', label: 'Warnings and errors' }, { value: 'error', label: 'Errors only' }]} />
    <div class="fld"><label class="nx-label" for="sys-filter">Filter text</label><input id="sys-filter" class="nx-input" bind:value={filter} placeholder="PDM-01, write refused" /></div>
    <span class="muted" role="status" data-testid="sys-count">Showing {rows.length} of {entries.length} entries</span>
    <span class="grow"></span>
    <Button href="/api/syslog/export" download data-testid="sys-export">Export log (.csv)</Button>
  </div>
  {#if stale}<Banner tone="warn" title="The system log is not updating.">The app could not read it. It keeps trying.</Banner>{/if}
  <section aria-label="System log" class="tbl">
    <div class="nx-scroll" tabindex="0" role="region" aria-label="System log">
      <table class="nx-table">
        <thead><tr><th scope="col">Time</th><th scope="col">Level</th><th scope="col">Source</th><th scope="col">Message</th></tr></thead>
        <tbody>
          {#each rows as e, i (i)}
            {@const k = kind(e.level)}
            <tr class={k}>
              <td class="mono t">{e.time}</td>
              <td class="lv"><span aria-hidden="true">{META[k].glyph} </span>{META[k].word}</td>
              <td>{e.source}</td>
              <td>{e.message}</td>
            </tr>
          {:else}
            <tr><td colspan="4" class="muted">{entries.length ? 'No entry matches.' : 'No messages yet.'}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
  <p class="muted small">This app and the modules. Newest first. Kept until you close the app.</p>
</div>

<style>
  .wrap { display: flex; flex-direction: column; gap: var(--space-3); }
  .bar { display: flex; align-items: flex-end; gap: var(--space-4); flex-wrap: wrap; }
  .grow { flex: 1 1 auto; }
  .fld { display: flex; flex-direction: column; gap: 4px; width: 240px; }
  .tbl { border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); }
  .tbl .nx-scroll { max-height: 640px; }
  .small { font-size: var(--text-xs); }
  .t { white-space: nowrap; }
  .lv { white-space: nowrap; font-weight: 600; }
  tr.warn { background: var(--color-warn-soft); }
  tr.warn .lv { color: var(--color-warn); }
  tr.error { background: var(--color-fault-soft); }
  tr.error .lv { color: var(--color-fault); }
</style>
