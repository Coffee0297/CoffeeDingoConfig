<script>
  /** Panel. title + optional subtitle, `actions` snippet top-right, `tag` snippet next to the title. */
  let { title = '', subtitle = '', actions, tag, children, ...rest } = $props()
</script>

<section class="card" {...rest}>
  {#if title || actions}
    <header>
      <div class="h">
        {#if title}<h2>{title}</h2>{/if}
        {#if tag}{@render tag()}{/if}
        {#if subtitle}<span class="muted sub">{subtitle}</span>{/if}
      </div>
      {#if actions}<div class="a">{@render actions()}</div>{/if}
    </header>
  {/if}
  {@render children?.()}
</section>

<style>
  .card { background: var(--color-surface); border: 1px solid var(--color-line); border-radius: var(--radius-lg); padding: var(--space-4) var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
  header { display: flex; align-items: center; gap: var(--space-3); }
  .h { flex: 1 1 auto; display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; min-width: 0; }
  h2 { font-size: var(--text-lg); font-weight: 700; }
  .sub { font-size: var(--text-xs); }
  .a { display: flex; gap: var(--space-2); flex-wrap: wrap; }
</style>
