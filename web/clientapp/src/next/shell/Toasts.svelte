<script>
  import { toasts, dismiss } from '../../lib/toast.js'
</script>

<div class="tw" aria-live="polite" aria-relevant="additions">
  {#each $toasts as t (t.id)}
    <div class="t" data-kind={t.kind} role={t.kind === 'error' ? 'alert' : 'status'}>
      <span aria-hidden="true">{t.kind === 'error' ? '■' : '●'}</span>
      <span class="m">{t.msg}{#if t.count > 1} <b>({t.count} messages)</b>{/if}</span>
      <button type="button" aria-label="Dismiss message" onclick={() => dismiss(t.id)}>✕</button>
    </div>
  {/each}
</div>

<style>
  /* Top-right under the top bar: screens keep their primary actions bottom-right (sticky save bars),
     and a toast must never sit on top of a button. pointer-events only on the toasts themselves. */
  .tw { position: fixed; right: 16px; top: 76px; z-index: 950; display: flex; flex-direction: column; gap: 8px; max-width: 420px; pointer-events: none; }
  .t { pointer-events: auto; }
  .t { display: flex; align-items: flex-start; gap: 10px; padding: 12px 12px 12px 16px; border-radius: var(--radius-md); background: var(--color-surface); border: 1px solid var(--color-line-strong); box-shadow: var(--shadow-2); }
  .t[data-kind='error'] { border-color: var(--color-fault); background: var(--color-fault-soft); }
  .t[data-kind='error'] > span:first-child { color: var(--color-fault); }
  .m { flex: 1 1 auto; }
  button { width: 32px; height: 32px; flex: none; border-radius: 8px; border: 1px solid var(--color-line-strong); background: transparent; color: var(--color-text); }
</style>
