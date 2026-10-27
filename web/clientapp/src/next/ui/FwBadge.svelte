<script>
  /** "Needs firmware X" marker for features the released firmware does not have yet (dashed, △).
   *  upstream: the module runs upstream dingoFW, which does not have the feature at all. */
  let { version = '5.6', upstream = false } = $props()
</script>

<span class="fw">△ {upstream ? 'Not in this firmware' : `Needs firmware ${version}`}</span>

<style>
  .fw { display: inline-flex; align-items: center; font-size: var(--text-xs); font-weight: 700; padding: 2px 7px; border-radius: 6px; border: 1px dashed var(--color-warn); color: var(--color-warn); white-space: nowrap; }
</style>
