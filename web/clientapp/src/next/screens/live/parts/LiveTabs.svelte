<script>
  // The four Live views as links (they are separate routes). `current` = dashboard | plot | trips | logs.
  let { current } = $props()
  const views = [['dashboard', 'Dashboard', '#/next/live'], ['plot', 'Plot', '#/next/live/plot'], ['trips', 'Trips', '#/next/live/trips'], ['logs', 'Logs', '#/next/live/logs']]
</script>

<nav class="tabs" aria-label="Live views">
  {#each views as [k, name, h] (k)}
    <a href={h} class:on={current === k} aria-current={current === k ? 'page' : undefined}>{name}</a>
  {/each}
</nav>

<style>
  .tabs { display: inline-flex; gap: 2px; padding: 4px; border-radius: var(--radius-md); background: var(--color-raised); }
  a { min-height: 36px; padding: 0 var(--space-4); border-radius: 8px; color: var(--color-text-muted); font-weight: 600; display: inline-flex; align-items: center; text-decoration: none; }
  a:hover { color: var(--color-text); }
  a.on { background: var(--color-surface); color: var(--color-text); box-shadow: var(--shadow-1); }
</style>
