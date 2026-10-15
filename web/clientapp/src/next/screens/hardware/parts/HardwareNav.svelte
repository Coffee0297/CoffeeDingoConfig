<script>
  // Hardware sub-navigation: Modules, Keypads, Firmware (and every output on the car).
  import { href } from '../../../router.svelte.js'
  let { current = 'modules' } = $props()
  const items = [['modules', 'Modules', ['hardware']], ['outputs', 'Outputs', ['hardware', 'outputs']], ['keypads', 'Keypads', ['hardware', 'keypads']], ['firmware', 'Firmware', ['hardware', 'firmware']]]
</script>

<nav class="hn" aria-label="Hardware">
  {#each items as [key, label, parts] (key)}
    <a href={href(...parts)} aria-current={current === key ? 'page' : undefined} class:on={current === key}>{label}</a>
  {/each}
</nav>

<style>
  .hn { display: inline-flex; gap: 2px; padding: 4px; border-radius: var(--radius-md); background: var(--color-raised); align-self: flex-start; }
  a { display: inline-flex; align-items: center; min-height: 36px; padding: 0 var(--space-4); border-radius: 8px; color: var(--color-text-muted); font-weight: 600; text-decoration: none; }
  a.on { background: var(--color-surface); color: var(--color-text); box-shadow: var(--shadow-1); }
  a:hover:not(.on) { color: var(--color-text); }
</style>
