<script>
  /**
   * Small status/label chip. tone: ok | on | warn | fault | muted | accent. `symbol` (●, ○, ■, ◆, △ …)
   * keeps the meaning readable without colour. `dashed` for "not yet / gap / needs something".
   * `solid` fills it (e.g. the FUNCTION tag).
   */
  let { tone = 'muted', symbol = '', dashed = false, solid = false, children, ...rest } = $props()
</script>

<span class="chip" class:dashed class:solid data-tone={tone} {...rest}>{#if symbol}<span aria-hidden="true">{symbol}</span>{/if}{@render children?.()}</span>

<style>
  .chip { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-xs); font-weight: 700; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 6px; border: 1px solid var(--c); color: var(--c); white-space: nowrap; line-height: 1.4; }
  .dashed { border-style: dashed; }
  .solid { background: var(--c); color: var(--color-on-accent); }
  [data-tone='ok'] { --c: var(--color-ok); }
  [data-tone='on'] { --c: var(--color-on); }
  [data-tone='warn'] { --c: var(--color-warn); }
  [data-tone='fault'] { --c: var(--color-fault); }
  [data-tone='muted'] { --c: var(--color-text-muted); }
  [data-tone='accent'] { --c: var(--color-accent); }
</style>
