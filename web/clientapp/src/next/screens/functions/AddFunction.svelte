<script>
  import { live, isPdm, isCanboard } from '../../lib/live.svelte.js'
  // Add a function: every ready-made template as a card (what it does, what it needs). Picking one opens the
  // setup wizard. "in use" comes from the applied templates; the cards come from templates.js.
  import { Page, PageHeader, Button, Chip, FwBadge, Empty } from '../../ui/index.js'
  import { has56 } from '../power/parts/ignition.js'
  import { href } from '../../router.svelte.js'
  import { TEMPLATES } from '../../../lib/templates.js'
  import { templateInstances, syncTemplates } from '../../../lib/store.js'
  import { SYSTEMS, systemName, templateSystem, needText } from './parts/catalog.js'
  import { untrack } from 'svelte'

  // Templates added in the latest batch (git: "9 more templates", 2026-10-12). The templates carry no date.
  const NEW_KEYS = ['washwipe', 'pwmfan', 'relaywipe', 'interior', 'reverse', 'brake', 'radfan', 'starter', 'drl', 'toggle', 'reminder']

  let q = $state(''), chip = $state('all'), opened = $state({}), clipped = $state({})
  // marks a description the 3-line clamp cuts, so only those get a More toggle
  function clamp(el, key) {
    const check = () => { const c = el.scrollHeight > el.clientHeight + 1; if (!el.classList.contains('open') && clipped[key] !== c) clipped = { ...clipped, [key]: c } }
    const ro = new ResizeObserver(check); ro.observe(el); check()
    return { destroy: () => ro.disconnect() }
  }
  $effect(() => { untrack(() => syncTemplates()) })

  const used = $derived.by(() => { const m = {}; for (const i of $templateInstances) m[i.key] = (m[i.key] ?? 0) + 1; return m })
  const cards = $derived(TEMPLATES.map((t) => ({ key: t.key, name: t.name, system: templateSystem(t.key), full: t.desc ?? '', need: needText(t), isNew: NEW_KEYS.includes(t.key), used: used[t.key] ?? 0, icon: t.icon })))
  const shown = $derived(cards.filter((c) => {
    if (chip !== 'all' && c.system !== chip) return false
    const w = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hay = (c.name + ' ' + c.full + ' ' + systemName(c.system)).toLowerCase()
    return w.every((x) => hay.includes(x))
  }))
  const chips = $derived([{ key: 'all', name: 'All', n: cards.length }, ...SYSTEMS.map((s) => ({ key: s.key, name: s.name, n: cards.filter((c) => c.system === s.key).length })).filter((c) => c.n)])
  const blankMod = $derived(live.devices.find(isPdm) ?? live.devices.find(isCanboard))
</script>

<Page wide>
  <PageHeader crumbs={[{ label: 'Functions', href: href('functions') }, { label: 'Add function' }]} title="Add a function"
    subtitle="Pick what the car should do. Every one is built from ordinary blocks you can open and change later.">
    {#snippet actions()}
      <input class="nx-input srch" type="search" bind:value={q} placeholder="fan, wipers, start button…" aria-label="Search templates" data-testid="tpl-search" />
      <!-- a blank function: the flow builder of the first PDM with Add open; pick another module there -->
      <Button href={blankMod ? href('functions', 'flow', blankMod.guid, { add: '1' }) : href('functions', 'flow')} title="Start from an empty canvas: add blocks and wire them to an output" data-testid="tpl-blank">Blank function</Button>
    {/snippet}
  </PageHeader>

  <div class="chips" role="group" aria-label="Filter by system">
    {#each chips as c (c.key)}
      <button type="button" class="chip" class:on={chip === c.key} aria-pressed={chip === c.key} onclick={() => (chip = c.key)}>{c.name}<span class="mono n">{c.n}</span></button>
    {/each}
  </div>

  <div class="grid" data-testid="tpl-cards">
    {#each shown as c (c.key)}
      <article class="card" data-tpl={c.key}>
        <div class="top"><span class="grp">{systemName(c.system).toUpperCase()}</span>
          {#if c.isNew}<Chip tone="accent" solid>NEW</Chip>{/if}
          {#if c.used}<Chip tone="ok" symbol="✓">IN USE{c.used > 1 ? ' ×' + c.used : ''}</Chip>{/if}
        </div>
        <h2><a href={href('functions', 'setup', c.key)}>{c.name}</a></h2>
        <p class="what" class:open={opened[c.key]} title={c.full} id={'tpl-d-' + c.key} use:clamp={c.key}>{c.full}</p>
        {#if clipped[c.key] || opened[c.key]}<button type="button" class="more" aria-expanded={!!opened[c.key]} aria-controls={'tpl-d-' + c.key}
          onclick={() => (opened = { ...opened, [c.key]: !opened[c.key] })}>{opened[c.key] ? 'Less' : 'More'}<span class="sr-only"> about {c.name}</span></button>{/if}
        <p class="need muted">You need: {c.need}</p>
      </article>
    {/each}
    {#if !q && (chip === 'all' || chip === 'power')}
      {@const ign56 = live.devices.some(has56)}
      <article class="card" class:off={!ign56}>
        <div class="top"><span class="grp">STARTING & POWER</span>{#if !ign56}<FwBadge version="5.6" />{/if}</div>
        <h2>{#if ign56}<a href={href('power', 'ignition')}>Ignition & start button</a>{:else}Ignition & start button{/if}</h2>
        <p class="what">Key or start button with clutch / brake, crank limit, output roles, dash power-down.</p>
        <p class="need muted">{ign56 ? 'You need: the ignition switch or key, and the start button, wired to one module.' : 'Needs firmware 5.6: the modules have no ignition block yet.'}</p>
      </article>
    {/if}
  </div>
  {#if !shown.length}<Empty title="No function matches" text="Try another word, or pick All." />{/if}
</Page>

<style>
  .srch { width: min(340px, 100%); }
  .chips { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .chip { min-height: 36px; padding: 0 var(--space-3); display: inline-flex; align-items: center; gap: var(--space-2); border-radius: 999px; border: 1px solid var(--color-line); background: transparent; font-weight: 600; font-size: var(--text-sm); }
  .chip.on { background: var(--color-raised); border-color: var(--color-line-strong); }
  .n { font-size: var(--text-xs); color: var(--color-text-muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-4); }
  .card { position: relative; display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4) var(--space-5); border: 1px solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface); min-height: 190px; }
  .card:hover:not(.off), .card:focus-within { border-color: var(--color-focus); background: var(--color-raised); }
  .card.off { border-style: dashed; opacity: 0.8; }
  .top { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
  .grp { font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-muted); margin-right: auto; }
  h2 { font-size: var(--text-lg); }
  h2 a { color: var(--color-text); text-decoration: none; }
  h2 a::after { content: ''; position: absolute; inset: 0; border-radius: var(--radius-lg); }
  h2 a:focus-visible { outline: none; }
  .card:has(h2 a:focus-visible) { outline: 3px solid var(--color-focus); outline-offset: 2px; }
  .what { font-size: var(--text-sm); line-height: 1.5; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden; }
  .what.open { display: block; }
  .more { position: relative; z-index: 1; align-self: flex-start; background: transparent; border: 0; padding: 2px 0; min-height: 28px; font-size: var(--text-sm); font-weight: 600; color: var(--color-accent); }
  .need { font-size: var(--text-sm); margin-top: auto; padding-top: var(--space-2); border-top: 1px solid var(--color-line); }
  @media (max-width: 900px) { .grid { grid-template-columns: minmax(0, 1fr); } .card { min-height: 0; } .srch { width: 100%; } }
</style>
