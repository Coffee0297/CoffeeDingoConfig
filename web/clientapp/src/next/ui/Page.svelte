<script>
  /** Screen layout: stacks its children with the standard gap. `wide` removes the max width. */
  let { wide = false, children } = $props()
</script>

<div class="page" class:wide>{@render children?.()}</div>

<style>
  .page { display: flex; flex-direction: column; gap: var(--space-5); max-width: 1680px; }
  .page.wide { max-width: none; }
</style>
