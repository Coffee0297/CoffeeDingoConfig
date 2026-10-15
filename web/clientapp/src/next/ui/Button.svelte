<script>
  /**
   * Button. variant: primary | secondary | ghost | danger | test (load-switching: orange outline).
   * size: sm (32) | md (44, default) | lg (52). Pass `href` to render a link styled as a button.
   * Extra attributes (aria-label, data-testid, title …) pass through.
   */
  let { variant = 'secondary', size = 'md', disabled = false, busy = false, type = 'button', href = null, onclick, children, ...rest } = $props()
</script>

{#if href}
  <a class="b {variant} {size}" {href} aria-disabled={disabled || undefined} {...rest}>{@render children?.()}</a>
{:else}
  <button class="b {variant} {size}" {type} disabled={disabled || busy} aria-busy={busy || undefined} {onclick} {...rest}>
    {#if busy}<span class="spin" aria-hidden="true"></span>{/if}
    {@render children?.()}
  </button>
{/if}

<style>
  .b { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); border-radius: var(--radius-md); border: 1px solid var(--color-line-strong); background: var(--color-surface); color: var(--color-text); font-weight: 600; text-decoration: none; white-space: nowrap; padding: 0 var(--space-4); transition: background var(--dur-fast) var(--ease); }
  .md { min-height: var(--target-min); }
  .sm { min-height: 32px; padding: 0 var(--space-3); font-size: var(--text-xs); }
  .lg { min-height: 52px; padding: 0 var(--space-5); font-size: var(--text-md); }
  .b:hover:not(:disabled) { background: var(--color-raised); }
  .primary { background: var(--color-accent); border-color: var(--color-accent); color: var(--color-on-accent); }
  .primary:hover:not(:disabled) { background: var(--color-accent-strong); }
  .ghost { background: transparent; border-color: transparent; }
  .danger { color: var(--color-fault); border-color: var(--color-fault); background: transparent; }
  .test { color: var(--color-fault); border-color: var(--color-fault); background: var(--color-surface); }
  .b:disabled, .b[aria-disabled='true'] { opacity: 0.5; }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: s 0.8s linear infinite; }
  @keyframes s { to { transform: rotate(360deg); } }
</style>
