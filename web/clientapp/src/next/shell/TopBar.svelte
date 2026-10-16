<script>
  import { live, project, hub, pendingModules, unstoredModules } from '../lib/live.svelte.js'
  import { ui, setTheme } from './ui.svelte.js'

  const total = $derived(live.devices.length)
  const answering = $derived(live.devices.filter((d) => d.connected).length)
  const pending = $derived(pendingModules().length)
  const unstored = $derived(unstoredModules().length)
  // G2: edits saved and held for Apply, across the connected modules
  const waiting = $derived(live.devices.reduce((n, d) => n + (d.connected ? d.pendingEdits ?? 0 : 0), 0))
  const projName = $derived(project.current ? project.current.replace(/\.json$/i, '') : 'Untitled car')

  const conn = $derived.by(() => {
    if (hub.state !== 'live') return { tone: 'stale', text: hub.state === 'reconnecting' ? 'App reconnecting…' : 'App not running' }
    if (!live.connected) return { tone: 'stale', text: live.reconnecting ? 'Adapter lost · reconnecting…' : 'Not connected' }
    return { tone: answering === total && total ? 'on' : 'warn', text: `${live.adapter ?? 'Connected'} · ${answering} of ${total} live` }
  })
</script>

<header class="top">
  <button type="button" id="nx-menu-btn" class="chip icon menu" aria-label="Menu" aria-controls="nx-rail" aria-expanded={ui.nav} onclick={() => (ui.nav = !ui.nav)}>☰</button>
  <a class="logo" href="#/next/car" aria-label="dingoConfig home">dingo<span>Config</span></a>
  <button type="button" class="chip proj" aria-haspopup="dialog" aria-expanded={ui.panel === 'project'} onclick={() => (ui.panel = 'project')} data-testid="project-chip">
    <span class="sq" aria-hidden="true"></span><span class="pn">{projName}</span>{#if project.dirty}<span class="dirty"><span class="wide"> · </span>●<span class="wide"> unsaved</span></span>{/if}
  </button>
  <div class="grow"></div>
  <button type="button" class="chip" data-tone={conn.tone} aria-haspopup="dialog" aria-expanded={ui.panel === 'connect'} onclick={() => (ui.panel = 'connect')} data-testid="connection-pill">
    <span class="dot" aria-hidden="true"></span><span class="wide">{conn.text}</span>
  </button>
  <button type="button" class="chip apply" class:has={waiting > 0 || pending > 0 || unstored > 0} aria-haspopup="dialog" aria-expanded={ui.panel === 'apply'} onclick={() => (ui.panel = 'apply')} data-testid="apply-pill">
    <span class="narrow" aria-hidden="true">{#if waiting > 0 || pending > 0}◆ {waiting || pending} · Apply{:else if unstored > 0}◆ {unstored} · Store{:else}Apply{/if}</span>
    <span class="wide">{#if waiting > 0}◆ {waiting} change{waiting === 1 ? '' : 's'} waiting · Apply to car{:else if pending > 0}◆ {pending} {pending === 1 ? 'module differs' : 'modules differ'} · Apply to car{:else if unstored > 0}◆ {unstored} not stored · Store on modules{:else}Nothing to apply{/if}</span>
  </button>
  <button type="button" class="chip search desk" onclick={() => (ui.palette = true)} aria-keyshortcuts="Control+K">Search · <span class="mono">Ctrl K</span></button>
  <button type="button" class="chip icon desk" aria-label={ui.theme === 'dark' ? 'Use light theme' : 'Use dark theme'} onclick={() => setTheme(ui.theme === 'dark' ? 'light' : 'dark')}>{ui.theme === 'dark' ? '☀' : '☾'}</button>
  <a class="old desk" href="#/" title="Back to the current dingoConfig UI">Old UI</a>
</header>

<style>
  .top { flex: none; height: 64px; display: flex; align-items: center; gap: var(--space-3); padding: 0 var(--space-4); border-bottom: 1px solid var(--color-line); background: var(--color-surface); }
  .logo { font-weight: 700; font-size: 20px; color: var(--color-text); text-decoration: none; width: 196px; }
  .logo span { color: var(--color-accent); }
  .grow { flex: 1 1 auto; }
  .chip { display: inline-flex; align-items: center; gap: 10px; height: 40px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--color-line); background: transparent; color: var(--color-text); font-size: 15px; text-decoration: none; white-space: nowrap; }
  .chip:hover { background: var(--color-raised); }
  .sq { flex: none; width: 9px; height: 9px; border-radius: 2px; background: var(--color-ok); }
  .dirty { color: var(--color-accent); font-weight: 600; }
  .dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--c, var(--color-on)); }
  [data-tone='stale'] .dot { background: transparent; border: 2px solid var(--color-stale); }
  [data-tone='warn'] .dot { --c: var(--color-warn); }
  .apply { color: var(--color-text-muted); border-radius: 999px; }
  .apply.has { background: var(--color-warn-soft); border-color: var(--color-warn); color: var(--color-warn); font-weight: 700; }
  .search { border-radius: var(--radius-md); color: var(--color-text-muted); }
  .icon { width: 40px; justify-content: center; padding: 0; border-radius: var(--radius-md); }
  .old { font-size: var(--text-xs); color: var(--color-text-muted); padding: var(--space-2) var(--space-1); }
  .old:hover { color: var(--color-text); }
  .proj { min-width: 0; }
  .pn { overflow: hidden; text-overflow: ellipsis; }
  .menu, .narrow { display: none; }
  @media (max-width: 900px) {
    .top { height: 56px; gap: var(--space-2); padding: 0 var(--space-2); }
    .logo, .desk { display: none; }
    .chip { height: var(--target-min); padding: 0 var(--space-3); gap: var(--space-2); }
    .menu { display: inline-flex; flex: none; width: var(--target-min); padding: 0; font-size: 20px; }
    .grow { flex: 1 1 0; min-width: 0; }
    .narrow { display: inline; }
    .wide { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  }
</style>
