<script>
  // Route: hardware/module/<guid>/output/<n>. The page is keyed so every output starts with fresh state.
  import OutputPage from './parts/OutputPage.svelte'
  let { guid, n } = $props()
</script>

{#key guid + ':' + n}
  <OutputPage {guid} {n} />
{/key}
