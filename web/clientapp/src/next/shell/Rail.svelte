<script>
  import { route, href } from '../router.svelte.js'
  import { AREAS, EXPERT } from '../screens.js'
  import { ui, toggleExpert } from './ui.svelte.js'
  const isExpert = $derived(route.parts[0] === 'expert')
</script>

<nav class="rail" aria-label="Main">
  <ul>
    {#each AREAS as a (a.area)}
      {@const active = route.parts[0] === a.area}
      <li><a href={href(a.area)} class:active aria-current={active ? 'page' : undefined}><span class="bar" aria-hidden="true"></span>{a.label}</a></li>
    {/each}
  </ul>
  <div class="grow"></div>
  <div class="ex">
    <button type="button" class="exb" aria-expanded={ui.expertOpen || isExpert} aria-controls="nx-expert" onclick={toggleExpert}>Expert {ui.expertOpen || isExpert ? '−' : '+'}</button>
    {#if ui.expertOpen || isExpert}
      <ul id="nx-expert">
        {#each EXPERT as x (x.label)}
          {@const active = route.parts[0] === x.parts[0] && route.parts[1] === x.parts[1]}
          <li><a href={href(...x.parts)} class:active aria-current={active ? 'page' : undefined}><span class="bar" aria-hidden="true"></span>{x.label}</a></li>
        {/each}
      </ul>
    {/if}
  </div>
</nav>

<style>
  .rail { flex: none; width: 232px; border-right: 1px solid var(--color-line); background: var(--color-surface); padding: var(--space-3) var(--space-3); display: flex; flex-direction: column; gap: 4px; overflow: auto; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  a { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 0 12px; border-radius: var(--radius-md); color: var(--color-text-muted); font-size: var(--text-md); font-weight: 500; text-decoration: none; }
  a:hover { background: var(--color-raised); color: var(--color-text); }
  a.active { background: var(--color-raised); color: var(--color-text); font-weight: 700; }
  .bar { width: 4px; height: 22px; border-radius: 2px; background: transparent; }
  a.active .bar { background: var(--color-accent); }
  .grow { flex: 1 1 auto; }
  .ex { border-top: 1px solid var(--color-line); padding-top: var(--space-2); display: flex; flex-direction: column; gap: 4px; }
  .exb { min-height: 40px; text-align: left; padding: 0 12px; border: 0; background: transparent; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; border-radius: var(--radius-md); }
  .exb:hover { background: var(--color-raised); color: var(--color-text); }
</style>
