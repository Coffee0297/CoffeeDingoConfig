<script>
  // Add a function: every ready-made template as a card (what it does, what it needs). Picking one opens the
  // setup wizard. "in use" comes from the applied templates; the cards come from templates.js.
  import { Page, PageHeader, Button, Chip, FwBadge, Empty } from '../../ui/index.js'
  import { href } from '../../router.svelte.js'
  import { TEMPLATES } from '../../../lib/templates.js'
  import { templateInstances, syncTemplates } from '../../../lib/store.js'
  import { SYSTEMS, systemName, templateSystem, needText, shortDesc } from './parts/catalog.js'
  import { untrack } from 'svelte'

  // Templates added in the latest batch (git: "9 more templates", 2026-10-12). The templates carry no date.
  const NEW_KEYS = ['washwipe', 'pwmfan', 'relaywipe', 'interior', 'reverse', 'brake', 'radfan', 'starter', 'drl', 'toggle', 'reminder']

  let q = $state(''), chip = $state('all')
  $effect(() => { untrack(() => syncTemplates()) })

  const used = $derived.by(() => { const m = {}; for (const i of $templateInstances) m[i.key] = (m[i.key] ?? 0) + 1; return m })
  const cards = $derived(TEMPLATES.map((t) => ({ key: t.key, name: t.name, system: templateSystem(t.key), what: shortDesc(t), full: t.desc, need: needText(t), isNew: NEW_KEYS.includes(t.key), used: used[t.key] ?? 0, icon: t.icon })))
  const shown = $derived(cards.filter((c) => {
    if (chip !== 'all' && c.system !== chip) return false
    const w = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hay = (c.name + ' ' + c.full + ' ' + systemName(c.system)).toLowerCase()
    return w.every((x) => hay.includes(x))
  }))
  const chips = $derived([{ key: 'all', name: 'All', n: cards.length }, ...SYSTEMS.map((s) => ({ key: s.key, name: s.name, n: cards.filter((c) => c.system === s.key).length })).filter((c) => c.n)])
</script>

<Page wide>
  <PageHeader crumbs={[{ label: 'Functions', href: href('functions') }, { label: 'Add function' }]} title="Add a function"
    subtitle="Pick what the car should do. Every one is built from ordinary blocks you can open and change later.">
    {#snippet actions()}
      <input class="nx-input srch" type="search" bind:value={q} placeholder="fan, wipers, start button…" aria-label="Search templates" data-testid="tpl-search" />
      <Button disabled aria-label="Blank function (not available yet: the backend keeps no function record)" title="Not available yet: the backend keeps no function record for an empty function">Blank function</Button>
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
        <p class="what">{c.what}</p>
        <p class="need muted">You need: {c.need}</p>
      </article>
    {/each}
    {#if !q && (chip === 'all' || chip === 'power')}
      <article class="card off">
        <div class="top"><span class="grp">STARTING & POWER</span><FwBadge version="5.6" /></div>
        <h2>Ignition & start button</h2>
        <p class="what">Key or start button with clutch / brake, crank limit, output roles, dash power-down.</p>
        <p class="need muted">Not available yet: the modules have no ignition block in the released firmware.</p>
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
  .what { font-size: var(--text-sm); line-height: 1.5; }
  .need { font-size: var(--text-sm); margin-top: auto; }
</style>
