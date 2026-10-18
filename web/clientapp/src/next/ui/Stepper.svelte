<script>
  /** Number with − / + buttons. value bindable; clamps to min/max; onchange(value) after each step/commit. */
  let { label, hideLabel = false, value = $bindable(0), step = 1, min = -Infinity, max = Infinity, unit = '', decimals = 0, disabled = false, onchange, ...rest } = $props()
  const id = 'st-' + Math.random().toString(36).slice(2, 8)
  const clamp = (v) => Math.min(max, Math.max(min, Math.round(v * 10 ** decimals) / 10 ** decimals))
  function bump(d) { value = clamp(Number(value) + d); onchange?.(value) }
</script>

<div class="f">
  <label class={hideLabel ? 'sr-only' : 'nx-label'} for={id}>{label}</label>   <!-- hideLabel: a table column heading says it -->
  <div class="row">
    <button type="button" class="b" aria-label={'Less ' + label} {disabled} onclick={() => bump(-step)}>−</button>
    <input {id} class="nx-input mono" type="number" bind:value {min} {max} {step} {disabled} onchange={() => { value = clamp(Number(value)); onchange?.(value) }} {...rest} />
    {#if unit}<span class="u">{unit}</span>{/if}
    <button type="button" class="b" aria-label={'More ' + label} {disabled} onclick={() => bump(step)}>+</button>
  </div>
</div>

<style>
  .f { display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; align-items: center; gap: var(--space-2); }
  .row input { width: 110px; text-align: center; }
  .b { width: var(--target-min); height: var(--target-min); flex: none; border-radius: var(--radius-md); border: 1px solid var(--color-line-strong); background: var(--color-raised); color: var(--color-text); font-size: 20px; font-weight: 700; }
  .u { font-family: var(--font-mono); color: var(--color-text-muted); }
</style>
