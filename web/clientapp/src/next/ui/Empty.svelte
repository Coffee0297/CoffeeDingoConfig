<script>
  /** Empty / not-available state: title, text, optional `actions` snippet. */
  let { title, text = '', actions } = $props()
</script>

<div class="em" role="status">
  <strong>{title}</strong>
  {#if text}<p class="muted">{text}</p>{/if}
  {#if actions}<div class="a">{@render actions()}</div>{/if}
</div>

<style>
  .em { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); text-align: center; padding: var(--space-7) var(--space-5); border: 1px dashed var(--color-line-strong); border-radius: var(--radius-lg); }
  .em p { max-width: 520px; }
  .a { display: flex; gap: var(--space-2); margin-top: var(--space-2); }
</style>
