<script>
  /**
   * Labelled text / number input. value is bindable. unit shows after the box. hint below, error in fault.
   * type: text | number. mono for IDs / values. onchange(value) on blur/enter (committed edits).
   */
  let { label, value = $bindable(''), type = 'text', unit = '', hint = '', error = '', mono = false, disabled = false, placeholder = '', min, max, step, onchange, ...rest } = $props()
  const id = 'f-' + Math.random().toString(36).slice(2, 8)
</script>

<div class="f">
  <label class="nx-label" for={id}>{label}</label>
  <div class="row">
    <input {id} class="nx-input" class:mono {type} bind:value {disabled} {placeholder} {min} {max} {step} aria-invalid={error ? 'true' : undefined} aria-describedby={hint || error ? id + '-d' : undefined} onchange={() => onchange?.(value)} {...rest} />
    {#if unit}<span class="u">{unit}</span>{/if}
  </div>
  {#if error}<span class="e" id={id + '-d'}>■ {error}</span>{:else if hint}<span class="h muted" id={id + '-d'}>{hint}</span>{/if}
</div>

<style>
  .f { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .row { display: flex; align-items: center; gap: var(--space-2); }
  .u { font-family: var(--font-mono); color: var(--color-text-muted); }
  .h, .e { font-size: var(--text-xs); }
  .e { color: var(--color-fault); font-weight: 600; }
  input[aria-invalid='true'] { border-color: var(--color-fault); }
</style>
