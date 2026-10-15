<script>
  /**
   * Live-state marker that never relies on colour alone.
   * tone: on | off | fault | warn | ok | stale | accent   shape: dot | ring | square | diamond | triangle
   * label: visible word next to it (also the accessible name). Omit `label` for a decorative dot.
   */
  let { tone = 'on', shape = 'dot', label = '', size = 10 } = $props()
</script>

<span class="sd" data-tone={tone}>
  <span class="m {shape}" style="width: {size}px; height: {size}px" aria-hidden="true"></span>
  {#if label}<span class="w">{label}</span>{/if}
</span>

<style>
  .sd { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
  .m { flex: none; display: inline-block; box-sizing: border-box; }
  .dot { border-radius: 50%; background: var(--c); }
  .ring { border-radius: 50%; border: 2px solid var(--c); }
  .square { border-radius: 2px; background: var(--c); }
  .diamond { transform: rotate(45deg) scale(0.8); background: var(--c); }
  .triangle { width: 0 !important; height: 0 !important; border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 10px solid var(--c); }
  [data-tone='on'] { --c: var(--color-on); color: var(--color-on); }
  [data-tone='off'] { --c: var(--color-off); color: var(--color-text-muted); }
  [data-tone='fault'] { --c: var(--color-fault); color: var(--color-fault); }
  [data-tone='warn'] { --c: var(--color-warn); color: var(--color-warn); }
  [data-tone='ok'] { --c: var(--color-ok); color: var(--color-ok); }
  [data-tone='stale'] { --c: var(--color-stale); color: var(--color-text-muted); }
  [data-tone='accent'] { --c: var(--color-accent); color: var(--color-accent); }
</style>
