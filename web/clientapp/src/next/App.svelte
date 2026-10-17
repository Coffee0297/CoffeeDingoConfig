<script>
  import { route } from './router.svelte.js'
  import { match } from './screens.js'
  import { ui } from './shell/ui.svelte.js'
  import TopBar from './shell/TopBar.svelte'
  import Rail from './shell/Rail.svelte'
  import Toasts from './shell/Toasts.svelte'
  import CommandPalette from './shell/CommandPalette.svelte'
  import ConnectPanel from './shell/ConnectPanel.svelte'
  import ApplyPanel from './shell/ApplyPanel.svelte'
  import AgentPrompt from './shell/AgentPrompt.svelte'
  import ProjectMenu from './shell/ProjectMenu.svelte'
  import AddModule from './shell/AddModule.svelte'

  const m = $derived(match(route.parts))
  // Key by the whole route so a screen remounts (fresh state) when its params change.
  const key = $derived(route.parts.join('/'))

  $effect(() => { document.documentElement.setAttribute('data-theme', ui.theme) })
</script>

<div class="app" data-theme={ui.theme}>
  <TopBar />
  <div class="body">
    <Rail />
    <main id="nx-main" tabindex="-1" inert={ui.nav}>   <!-- the phone menu drawer is open: Tab stays in it -->
      {#key key}
        {#await m.load()}
          <p class="muted loading">Loading…</p>
        {:then mod}
          <mod.default {...m.params} query={route.query} />
        {:catch e}
          <p class="err" role="alert">This screen failed to load: {e.message}</p>
        {/await}
      {/key}
    </main>
  </div>
</div>

<ConnectPanel />
<ApplyPanel />
<AgentPrompt />
<ProjectMenu />
<AddModule />
<CommandPalette />
<Toasts />

<style>
  .app { height: 100vh; display: flex; flex-direction: column; background: var(--color-bg); color: var(--color-text); }
  .body { flex: 1 1 auto; display: flex; min-height: 0; }
  main { flex: 1 1 auto; min-width: 0; overflow: auto; padding: var(--space-5) var(--space-6); outline: none; }
  .loading { padding: var(--space-5); }
  .err { color: var(--color-fault); font-weight: 600; }
  @media (max-width: 900px) {
    .app { height: 100dvh; }
    main { padding: var(--space-4); }
  }
</style>
