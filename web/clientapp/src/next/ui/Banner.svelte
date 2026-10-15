<script>
  /**
   * Message strip. tone: info | ok | warn | fault. Fault banners are role="alert", others role="status".
   * title (bold), children (text), actions (snippet with buttons).
   */
  let { tone = 'info', title = '', children, actions, ...rest } = $props()
  const sym = { info: '●', ok: '✓', warn: '▲', fault: '■' }
</script>

<div class="bn" data-tone={tone} role={tone === 'fault' ? 'alert' : 'status'} {...rest}>
  <span class="s" aria-hidden="true">{sym[tone]}</span>
  <div class="t">
    {#if title}<strong>{title}</strong>{/if}
    {#if children}<span class="d">{@render children()}</span>{/if}
  </div>
  {#if actions}<div class="a">{@render actions()}</div>{/if}
</div>

<style>
  .bn { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); border: 1px solid var(--c); background: var(--bg); }
  .s { color: var(--c); font-weight: 700; }
  .t { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .d { color: var(--color-text); font-size: var(--text-sm); }
  .a { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  [data-tone='info'] { --c: var(--color-line-strong); --bg: var(--color-raised); }
  [data-tone='ok'] { --c: var(--color-ok); --bg: var(--color-raised); }
  [data-tone='warn'] { --c: var(--color-warn); --bg: var(--color-warn-soft); }
  [data-tone='fault'] { --c: var(--color-fault); --bg: var(--color-fault-soft); }
</style>
