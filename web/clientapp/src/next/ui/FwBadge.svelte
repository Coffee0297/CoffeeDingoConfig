<script>
  /** "Needs firmware X" marker for features the released firmware does not have yet (dashed, △). */
  let { version = '5.6' } = $props()
</script>

<span class="fw">△ Needs firmware {version}</span>

<style>
  .fw { display: inline-flex; align-items: center; font-size: var(--text-xs); font-weight: 700; padding: 2px 7px; border-radius: 6px; border: 1px dashed var(--color-warn); color: var(--color-warn); white-space: nowrap; }
</style>
