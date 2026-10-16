<script>
  import { tick, untrack } from 'svelte'
  import { route, href } from '../router.svelte.js'
  import { AREAS, EXPERT } from '../screens.js'
  import { ui, toggleExpert, setTheme } from './ui.svelte.js'
  const isExpert = $derived(route.parts[0] === 'expert')
  let navEl = $state(null)

  // Phone drawer (< 900 px): closes on navigation, Escape, scrim or a link click; focus moves in and back.
  const path = $derived(route.parts.join('/'))
  $effect(() => { path; untrack(() => { ui.nav = false }) })
  $effect(() => { if (ui.nav) tick().then(() => navEl?.querySelector('a, button')?.focus()) })
  function close() { ui.nav = false; document.getElementById('nx-menu-btn')?.focus() }
  function onkey(e) { if (ui.nav && e.key === 'Escape') { e.preventDefault(); close() } }
  function onclick(e) { if (ui.nav && e.target.closest('a')) ui.nav = false }
</script>

<svelte:window onkeydown={onkey} />

{#if ui.nav}<button type="button" class="scrim" tabindex="-1" aria-label="Close menu" onclick={close}></button>{/if}
<nav id="nx-rail" class="rail" class:open={ui.nav} aria-label="Main" bind:this={navEl} {onclick}>
  <div class="phone hd">
    <span class="nx-label">Menu</span>
    <button type="button" class="x" aria-label="Close menu" onclick={close}>✕</button>
  </div>
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
  <div class="phone ex">
    <button type="button" class="tool" onclick={() => { ui.nav = false; ui.palette = true }}>Search</button>
    <button type="button" class="tool" aria-label={ui.theme === 'dark' ? 'Use light theme' : 'Use dark theme'} onclick={() => setTheme(ui.theme === 'dark' ? 'light' : 'dark')}>{ui.theme === 'dark' ? '☀ Light theme' : '☾ Dark theme'}</button>
    <a class="tool" href="#/" title="Back to the current dingoConfig UI">Old UI</a>
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
  .phone, .scrim { display: none; }
  @media (max-width: 900px) {
    .rail { position: fixed; z-index: 800; top: 0; bottom: 0; left: 0; width: min(300px, 85vw); box-shadow: var(--shadow-2); transform: translateX(-100%); visibility: hidden; transition: transform var(--dur-mid) var(--ease), visibility 0s linear var(--dur-mid); }
    .rail.open { transform: none; visibility: visible; transition: transform var(--dur-mid) var(--ease); }
    .scrim { display: block; position: fixed; inset: 0; z-index: 799; border: 0; padding: 0; background: var(--color-scrim); }
    .phone { display: flex; }
    .hd { align-items: center; justify-content: space-between; padding: 0 0 var(--space-2) 12px; }
    .x { width: var(--target-min); height: var(--target-min); border-radius: var(--radius-md); border: 1px solid var(--color-line-strong); background: transparent; color: var(--color-text); }
    .exb { min-height: var(--target-min); }
    .tool { display: flex; align-items: center; min-height: var(--target-min); padding: 0 12px; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--color-text-muted); font-size: var(--text-md); text-align: left; text-decoration: none; }
    .tool:hover { background: var(--color-raised); color: var(--color-text); }
  }
</style>
