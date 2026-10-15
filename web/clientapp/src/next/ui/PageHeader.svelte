<script>
  /** Screen header: breadcrumbs [{ label, href? }], title (h1), subtitle, `tag` + `actions` snippets. */
  let { crumbs = [], title, subtitle = '', tag, actions } = $props()
</script>

<header class="ph">
  {#if crumbs.length}
    <nav aria-label="Breadcrumb" class="cr">
      {#each crumbs as c, i (i)}
        {#if i}<span aria-hidden="true">›</span>{/if}
        {#if c.href}<a href={c.href}>{c.label}</a>{:else}<span aria-current="page">{c.label}</span>{/if}
      {/each}
    </nav>
  {/if}
  <div class="row">
    <div class="t">
      <div class="tt"><h1>{title}</h1>{#if tag}{@render tag()}{/if}</div>
      {#if subtitle}<p class="muted">{subtitle}</p>{/if}
    </div>
    {#if actions}<div class="a">{@render actions()}</div>{/if}
  </div>
</header>

<style>
  .ph { display: flex; flex-direction: column; gap: var(--space-2); }
  .cr { display: flex; gap: 6px; font-size: var(--text-sm); color: var(--color-text-muted); flex-wrap: wrap; }
  .cr a { color: var(--color-text-muted); text-decoration: none; }
  .cr a:hover { color: var(--color-text); text-decoration: underline; }
  .cr [aria-current] { color: var(--color-text); }
  .row { display: flex; align-items: flex-end; gap: var(--space-4); flex-wrap: wrap; }
  .t { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .tt { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  h1 { font-size: var(--text-xl); font-weight: 700; }
  .a { display: flex; gap: var(--space-2); flex-wrap: wrap; }
</style>
